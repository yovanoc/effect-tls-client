import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  BrowserScriptContext,
  BrowserScriptError,
  BrowserScriptResult,
  type BrowserScriptHost,
  type BrowserScriptRuntime,
} from "./BrowserScript.js";
import { makeBrowserScriptRunnerSource } from "./BrowserScriptRunner.js";
import { normalizeAllowedOrigins, resolveAllowedUrl } from "./ScriptPolicy.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_INPUT_LINE_BYTES = 128 * 1024;
const MAX_OUTPUT_LINE_BYTES = 128 * 1024;
const MAX_NETWORK_REQUESTS = 8;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SCRIPT_ASSET_BYTES = 1024 * 1024;
const MAX_TOTAL_NETWORK_BYTES = 1024 * 1024;
const MAX_COOKIE_BYTES = 64 * 1024;
const MAX_COOKIE_WRITES = 64;
const MAX_SCRIPT_HEADERS = 128;
const MAX_SCRIPT_HEADER_BYTES = 64 * 1024;
const MAX_TIMERS = 64;
const MAX_TIMER_FIRES = 256;
const MAX_TIMER_DELAY_MS = 120_000;

const timeoutError = () =>
  new BrowserScriptError({
    reason: "script evaluation timed out and the process was terminated",
  });

const RunnerStart = Schema.Struct({
  type: Schema.Literal("start"),
  source: Schema.String,
  url: Schema.String,
  cookie: Schema.String,
  userAgent: Schema.String,
  authoritativeCookies: Schema.Boolean,
});
const RunnerOutput = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.String,
    setCookies: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
]);
const RunnerRequestBody = Schema.NullOr(
  Schema.Union([
    Schema.String,
    Schema.Array(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
        Schema.isLessThanOrEqualTo(255),
      ),
    ).check(Schema.isMaxLength(MAX_REQUEST_BODY_BYTES)),
  ]),
);
const RunnerMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("network"),
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    kind: Schema.Literals(["fetch", "script"]),
    cookieVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    url: Schema.String,
    method: Schema.String,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    body: RunnerRequestBody,
  }),
  Schema.Struct({
    type: Schema.Literal("cookie.write"),
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    value: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("timer.set"),
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    ms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    type: Schema.Literal("timer.clear"),
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("script.error"),
    reason: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("result"), output: RunnerOutput }),
]);
const RunnerNetworkResponse = Schema.Struct({
  status: Schema.Int,
  url: Schema.String,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  body: Schema.String,
  cookie: Schema.String,
  appliedCookieVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  error: Schema.optionalKey(Schema.String),
});
const RunnerInputMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("cookie.sync"),
    cookie: Schema.String,
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    applied: Schema.Boolean,
    error: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("reply"),
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    ok: Schema.Literal(true),
    response: RunnerNetworkResponse,
  }),
  Schema.Struct({
    type: Schema.Literal("reply"),
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    ok: Schema.Literal(false),
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("timer.fire"),
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({ type: Schema.Literal("fatal"), reason: Schema.String }),
]);
const RunnerStartJson = Schema.fromJsonString(RunnerStart);
const RunnerMessageJson = Schema.fromJsonString(RunnerMessage);

const RUNNER_SOURCE = makeBrowserScriptRunnerSource({
  maxInputLineBytes: MAX_INPUT_LINE_BYTES,
  maxControlInputLineBytes: MAX_CONTROL_INPUT_LINE_BYTES,
  maxOutputLineBytes: MAX_OUTPUT_LINE_BYTES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxCookieBytes: MAX_COOKIE_BYTES,
  maxNetworkRequests: MAX_NETWORK_REQUESTS,
  maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
  maxTotalNetworkBytes: MAX_TOTAL_NETWORK_BYTES,
  maxHeaders: MAX_SCRIPT_HEADERS,
  maxHeaderBytes: MAX_SCRIPT_HEADER_BYTES,
  maxCookieWrites: MAX_COOKIE_WRITES,
  maxTimers: MAX_TIMERS,
  maxTimerDelayMs: MAX_TIMER_DELAY_MS,
});

interface Output {
  readonly result?: Schema.Schema.Type<typeof RunnerOutput>;
  readonly bytes: number;
}

const hostProcess =
  typeof globalThis.process === "object" ? globalThis.process : undefined;

const lineBytes = (line: string): number =>
  new TextEncoder().encode(line).byteLength;

const exceedsCookieLimit = (cookie: string): boolean =>
  cookie.length > MAX_COOKIE_BYTES || lineBytes(cookie) > MAX_COOKIE_BYTES;

const makeEvaluate = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: BrowserMockOptions,
  hostRequestSemaphore: Semaphore.Semaphore,
): BrowserScriptRuntime["evaluate"] =>
  Effect.fn("BrowserMock.evaluate")(function* (
    source: string,
    context: BrowserScriptContext = {
      url: "about:blank",
      cookie: "",
      userAgent: "",
    },
    host?: BrowserScriptHost,
  ): Effect.fn.Return<BrowserScriptResult, BrowserScriptError> {
    if (
      source.length > MAX_SOURCE_BYTES ||
      new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES
    ) {
      return yield* new BrowserScriptError({
        reason: "script source exceeds the 64 KiB limit",
      });
    }
    if (
      exceedsCookieLimit(context.cookie) ||
      source.length +
        context.url.length +
        context.cookie.length +
        context.userAgent.length >
        MAX_CONTROL_INPUT_LINE_BYTES
    ) {
      return yield* new BrowserScriptError({
        reason: "script IPC start input exceeds its 128 KiB limit",
      });
    }
    const start = yield* Schema.encodeEffect(RunnerStartJson)({
      type: "start",
      source,
      url: context.url,
      cookie: context.cookie,
      userAgent: context.userAgent,
      authoritativeCookies: host !== undefined,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserScriptError({
            reason: "failed to encode browser script input",
            cause,
          }),
      ),
    );
    const executable =
      options.executable ??
      (hostProcess?.versions?.bun === undefined
        ? (hostProcess?.execPath ?? "node")
        : "node");
    const environment =
      typeof hostProcess?.env?.["PATH"] === "string"
        ? { PATH: hostProcess.env["PATH"] }
        : {};
    const startLine = new TextEncoder().encode(`${start}\n`);
    if (
      startLine.byteLength > MAX_CONTROL_INPUT_LINE_BYTES ||
      startLine.byteLength > MAX_INPUT_BYTES
    ) {
      return yield* new BrowserScriptError({
        reason: "script IPC start input exceeds its 128 KiB limit",
      });
    }
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(
              executable,
              ["--permission", "-e", RUNNER_SOURCE],
              {
                detached: true,
                env: environment,
                stdin: { stream: "pipe", endOnDone: false },
                stdout: "pipe",
                stderr: "ignore",
              },
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new BrowserScriptError({
                  reason: "failed to spawn browser script process",
                  cause,
                }),
            ),
          );
        const stopped = yield* Ref.make(false);
        const timedOut = yield* Ref.make(false);
        const timers = new Map<number, Fiber.Fiber<void, never>>();
        const writeSemaphore = yield* Semaphore.make(1);
        let inputBytes = startLine.byteLength;
        let networkBytes = 0;
        let networkRequests = 0;
        let activeRequests = 0;
        let timerFires = 0;
        let cookieWriteCount = 0;
        let cookieBytes = 0;
        let appliedCookieVersion = 0;

        const writeInput = (
          message: unknown,
          maxLineBytes = MAX_CONTROL_INPUT_LINE_BYTES,
        ): Effect.Effect<void, BrowserScriptError> =>
          Effect.gen(function* () {
            const validated = yield* Schema.decodeUnknownEffect(
              RunnerInputMessage,
            )(message).pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserScriptError({
                    reason: "invalid host-to-runner IPC message",
                    cause,
                  }),
              ),
            );
            const cookie =
              validated.type === "cookie.sync"
                ? validated.cookie
                : validated.type === "reply" && validated.ok
                  ? validated.response.cookie
                  : undefined;
            if (cookie !== undefined && exceedsCookieLimit(cookie)) {
              return yield* new BrowserScriptError({
                reason: "script cookie state exceeds the 64 KiB limit",
              });
            }
            const bytes = yield* Effect.try({
              try: () => {
                const line = `${JSON.stringify(validated)}\n`;
                const encoded = new TextEncoder().encode(line);
                if (
                  encoded.byteLength > maxLineBytes ||
                  inputBytes + encoded.byteLength > MAX_INPUT_BYTES
                ) {
                  throw new RangeError(
                    "script IPC input exceeds the 8 MiB limit",
                  );
                }
                inputBytes += encoded.byteLength;
                return encoded;
              },
              catch: (cause) =>
                new BrowserScriptError({
                  reason: "failed to encode script IPC input",
                  cause,
                }),
            });
            yield* writeSemaphore.withPermit(
              Stream.run(Stream.succeed(bytes), handle.stdin).pipe(
                Effect.mapError(
                  (cause) =>
                    new BrowserScriptError({
                      reason: "failed to write script IPC input",
                      cause,
                    }),
                ),
              ),
            );
          });

        const terminate = (reason: BrowserScriptError) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* Ref.set(timedOut, true);
              yield* Ref.set(stopped, true);
              yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
              return yield* reason;
            }),
          );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const timer of timers.values()) yield* Fiber.interrupt(timer);
            timers.clear();
            if (!(yield* Ref.get(stopped))) {
              yield* Ref.set(stopped, true);
              yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
            }
          }),
        );

        const handleNetwork = (
          event: Extract<
            Schema.Schema.Type<typeof RunnerMessage>,
            { type: "network" }
          >,
        ) =>
          Effect.gen(function* () {
            let requestBodyBytes = 0;
            if (typeof event.body === "string") {
              requestBodyBytes = lineBytes(event.body);
            } else if (event.body !== null) {
              requestBodyBytes = event.body.length;
            }
            if (requestBodyBytes > MAX_REQUEST_BODY_BYTES) {
              yield* writeInput({
                type: "reply",
                id: event.id,
                ok: false,
                error: "script request body exceeds the 16 KiB limit",
              });
              return;
            }
            const requestBytes = lineBytes(JSON.stringify(event));
            networkRequests += 1;
            if (networkRequests > MAX_NETWORK_REQUESTS) {
              yield* writeInput({
                type: "reply",
                id: event.id,
                ok: false,
                error: `script request budget exceeds ${MAX_NETWORK_REQUESTS} requests`,
              });
              return;
            }
            if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
              yield* writeInput({
                type: "reply",
                id: event.id,
                ok: false,
                error: `script request concurrency exceeds ${MAX_CONCURRENT_REQUESTS}`,
              });
              return;
            }
            if (networkBytes + requestBytes > MAX_TOTAL_NETWORK_BYTES) {
              yield* writeInput({
                type: "reply",
                id: event.id,
                ok: false,
                error: "script network byte budget exceeded",
              });
              return;
            }
            const urlResult = yield* Effect.result(
              Effect.try({
                try: () =>
                  resolveAllowedUrl(
                    event.url,
                    context.url,
                    options.allowedOrigins ?? [],
                  ).toString(),
                catch: (cause) =>
                  new BrowserScriptError({
                    reason:
                      cause instanceof Error
                        ? cause.message
                        : "script origin is not allowed",
                    cause,
                  }),
              }),
            );
            if (urlResult._tag === "Failure") {
              yield* writeInput({
                type: "reply",
                id: event.id,
                ok: false,
                error: urlResult.failure.reason,
              });
              return;
            }
            const url = urlResult.success;
            const request = {
              kind: event.kind,
              url,
              method: event.method,
              headers: event.headers,
              body: typeof event.body === "string" ? event.body : null,
              bodyBytes:
                typeof event.body === "string" || event.body === null
                  ? null
                  : event.body,
            } as const;
            networkBytes += requestBytes;
            activeRequests += 1;
            const perform = Effect.gen(function* () {
              const responseCookieVersion = appliedCookieVersion;
              const response =
                host === undefined
                  ? yield* new BrowserScriptError({
                      reason: "script network host is unavailable",
                    })
                  : yield* host.request(request);
              const responseBytes = lineBytes(response.body);
              const responseLimit =
                event.kind === "script"
                  ? MAX_SCRIPT_ASSET_BYTES
                  : MAX_RESPONSE_BYTES;
              if (responseBytes > responseLimit) {
                yield* writeInput({
                  type: "reply",
                  id: event.id,
                  ok: false,
                  error:
                    event.kind === "script"
                      ? "script asset exceeds the 1 MiB limit"
                      : "script response exceeds the 64 KiB limit",
                });
                return;
              }
              if (networkBytes + responseBytes > MAX_TOTAL_NETWORK_BYTES) {
                yield* writeInput({
                  type: "reply",
                  id: event.id,
                  ok: false,
                  error: "script network byte budget exceeded",
                });
                return;
              }
              networkBytes += responseBytes;
              const encoded = yield* Schema.encodeEffect(RunnerNetworkResponse)(
                { ...response, appliedCookieVersion: responseCookieVersion },
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new BrowserScriptError({
                      reason: "host returned invalid script network data",
                      cause,
                    }),
                ),
              );
              const message = {
                type: "reply",
                id: event.id,
                ok: true,
                response: encoded,
              } as const;
              yield* writeInput(message, MAX_INPUT_LINE_BYTES);
            }).pipe(
              Effect.catch((error) =>
                writeInput({
                  type: "reply",
                  id: event.id,
                  ok: false,
                  error: error.reason,
                }),
              ),
              Effect.ensuring(Effect.sync(() => (activeRequests -= 1))),
            );
            yield* Effect.forkScoped(hostRequestSemaphore.withPermit(perform));
          });

        const onLine = (line: string, state: Output) =>
          Effect.gen(function* () {
            const lineLength = lineBytes(line);
            if (lineLength > MAX_OUTPUT_LINE_BYTES) {
              return yield* new BrowserScriptError({
                reason: "script process emitted an oversized IPC line",
              });
            }
            const bytes = state.bytes + lineLength + 1;
            if (bytes > MAX_OUTPUT_BYTES) {
              return yield* new BrowserScriptError({
                reason: "script process output exceeds the 1 MiB limit",
              });
            }
            const event = yield* Schema.decodeEffect(RunnerMessageJson)(
              line,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserScriptError({
                    reason: "script process emitted an invalid IPC message",
                    cause,
                  }),
              ),
            );
            if (event.type === "result") {
              return {
                result:
                  host === undefined || !event.output.ok
                    ? event.output
                    : { ...event.output, setCookies: [] },
                bytes,
              };
            }
            if (event.type === "script.error") {
              return yield* new BrowserScriptError({ reason: event.reason });
            }
            if (event.type === "cookie.write") {
              if (
                ++cookieWriteCount > MAX_COOKIE_WRITES ||
                cookieBytes + lineBytes(event.value) > MAX_COOKIE_BYTES
              ) {
                return yield* new BrowserScriptError({
                  reason: "script cookie output exceeds the configured limit",
                });
              }
              cookieBytes += lineBytes(event.value);
              let cookie = "";
              if (host !== undefined) {
                const result = yield* Effect.result(
                  host.setCookie(event.value),
                );
                if (result._tag === "Failure") {
                  return yield* new BrowserScriptError({
                    reason: result.failure.reason,
                    cause: result.failure,
                  });
                }
                cookie = result.success;
              }
              appliedCookieVersion = Math.max(
                appliedCookieVersion,
                event.version,
              );
              if (host !== undefined) {
                yield* writeInput({
                  type: "cookie.sync",
                  cookie,
                  version: event.version,
                  applied: true,
                });
              }
              return { bytes };
            }
            if (event.type === "timer.clear") {
              const timer = timers.get(event.id);
              if (timer !== undefined) {
                timers.delete(event.id);
                yield* Fiber.interrupt(timer);
              }
              return { bytes };
            }
            if (event.type === "timer.set") {
              if (timers.size >= MAX_TIMERS) {
                yield* writeInput({
                  type: "fatal",
                  reason: `script timer budget exceeds ${MAX_TIMERS} active timers`,
                });
                return { bytes };
              }
              const delay = Math.min(event.ms, MAX_TIMER_DELAY_MS);
              const timer = yield* Effect.sleep(Duration.millis(delay)).pipe(
                Effect.flatMap(() =>
                  Effect.suspend(() => {
                    timers.delete(event.id);
                    timerFires += 1;
                    return timerFires > MAX_TIMER_FIRES
                      ? writeInput({
                          type: "fatal",
                          reason: `script timer budget exceeds ${MAX_TIMER_FIRES} fires`,
                        })
                      : writeInput({ type: "timer.fire", id: event.id });
                  }),
                ),
                Effect.ignore,
                Effect.forkScoped,
              );
              timers.set(event.id, timer);
              return { bytes };
            }
            if (event.cookieVersion > appliedCookieVersion) {
              yield* writeInput({
                type: "reply",
                id: event.id,
                ok: false,
                error:
                  "script cookie update was not committed before the request",
              });
              return { bytes };
            }
            yield* handleNetwork(event);
            return { bytes };
          });

        const read = handle.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runFoldEffect(
            (): Output => ({ bytes: 0 }),
            (state, line) => onLine(line, state),
          ),
          Effect.mapError((cause) =>
            cause instanceof BrowserScriptError
              ? cause
              : new BrowserScriptError({
                  reason: "failed to read script process output",
                  cause,
                }),
          ),
        );
        const wait = Effect.gen(function* () {
          yield* writeSemaphore.withPermit(
            Stream.run(Stream.succeed(startLine), handle.stdin).pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserScriptError({
                    reason: "failed to start browser script process",
                    cause,
                  }),
              ),
            ),
          );
          const collected = yield* read;
          yield* handle.exitCode.pipe(
            Effect.mapError(
              (cause) =>
                new BrowserScriptError({
                  reason: "browser script process exited without a result",
                  cause,
                }),
            ),
          );
          yield* Ref.set(stopped, true);
          if (collected.result === undefined) {
            return yield* new BrowserScriptError({
              reason: "browser script process exited without a result",
            });
          }
          if (!collected.result.ok) {
            return yield* new BrowserScriptError({
              reason: collected.result.reason,
            });
          }
          return yield* Schema.decodeEffect(BrowserScriptResult)({
            value: collected.result.value,
            setCookies: collected.result.setCookies,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new BrowserScriptError({
                  reason: "browser script result failed validation",
                  cause,
                }),
            ),
          );
        }).pipe(
          Effect.catch((error) =>
            Ref.get(timedOut).pipe(
              Effect.flatMap((hasTimedOut) =>
                hasTimedOut ? Effect.fail(timeoutError()) : Effect.fail(error),
              ),
            ),
          ),
        );
        return yield* Effect.raceFirst(
          wait,
          Effect.sleep(
            Duration.millis(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          ).pipe(Effect.andThen(terminate(timeoutError()))),
        );
      }),
    );
    return output;
  });

/** Options for the process-backed browser mock. */
export const BrowserMockOptions = Schema.Struct({
  executable: Schema.optionalKey(Schema.String),
  allowedOrigins: Schema.optionalKey(Schema.Array(Schema.String)),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
      Schema.isLessThanOrEqualTo(120_000),
    ),
  ),
});
export interface BrowserMockOptions extends Schema.Schema.Type<
  typeof BrowserMockOptions
> {}

/** A fresh, process-backed small browser-global runtime for reviewed scripts. */
export class BrowserMock extends Context.Service<
  BrowserMock,
  BrowserScriptRuntime
>()("effect-tls-client/browser/BrowserMock") {
  static readonly layer = (input: BrowserMockOptions = {}) =>
    Layer.effect(
      BrowserMock,
      Effect.gen(function* () {
        const options = yield* Schema.decodeEffect(BrowserMockOptions)(
          input,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new BrowserScriptError({
                reason: "invalid BrowserMock options",
                cause,
              }),
          ),
        );
        const allowedOrigins = yield* Effect.try({
          try: () => normalizeAllowedOrigins(options.allowedOrigins ?? []),
          catch: (cause) =>
            new BrowserScriptError({
              reason: "invalid BrowserMock allowedOrigins",
              cause,
            }),
        });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Cookie snapshots have no host revision; serialize requests through reply delivery.
        // ponytail: host revisions can restore script-request concurrency.
        const hostRequestSemaphore = yield* Semaphore.make(1);
        return BrowserMock.of({
          allowedOrigins,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          evaluate: makeEvaluate(
            spawner,
            { ...options, allowedOrigins },
            hostRequestSemaphore,
          ),
        });
      }),
    );
}
