import { Context, Duration, Effect, Layer, Ref, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  BrowserScriptContext,
  BrowserScriptError,
  BrowserScriptResult,
  type BrowserScriptRuntime,
} from "./BrowserScript.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const timeoutError = () =>
  new BrowserScriptError({
    reason: "script evaluation timed out and the process was terminated",
  });
const RunnerInput = Schema.Struct({
  source: Schema.String,
  url: Schema.String,
  cookie: Schema.String,
  userAgent: Schema.String,
});
const RunnerOutput = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.String,
    setCookies: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
]);
const RunnerInputJson = Schema.fromJsonString(RunnerInput);
const RunnerOutputJson = Schema.fromJsonString(RunnerOutput);

/** Options for the process-backed browser mock. */
export const BrowserMockOptions = Schema.Struct({
  executable: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
      Schema.isLessThanOrEqualTo(120_000),
    ),
  ),
});
export interface BrowserMockOptions extends Schema.Schema.Type<
  typeof BrowserMockOptions
> {}

// This is deliberately a small context, not a fake browser. Network APIs and
// DOM constructors are absent; network work belongs to the TlsSession host.
const RUNNER_SOURCE = String.raw`
const vm = require("node:vm");
const encoder = new TextEncoder();
const MAX_COOKIE_BYTES = 64 * 1024;
const httpOnly = /(?:^|;)\s*httponly(?:\s*=|;|$)/i;
const send = (value) => process.stdout.end(JSON.stringify(value), () => process.exit(0));
const errorMessage = (cause) => cause instanceof Error ? cause.message : String(cause);
const readInput = () => new Promise((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.once("error", reject);
  process.stdin.once("end", () => {
    try { resolve(JSON.parse(value)); } catch (cause) { reject(cause); }
  });
});
const run = async () => {
  const major = Number.parseInt(process.versions.node, 10);
  if (
    !Number.isInteger(major) ||
    major < 25 ||
    process.permission?.has("net") !== false
  ) {
    throw new Error("BrowserMock requires network permission denial support");
  }
  const input = await readInput();
  const visible = new Map();
  for (const part of String(input.cookie).split(";")) {
    const equals = part.indexOf("=");
    if (equals > 0) visible.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim());
  }
  const setCookies = [];
  let cookieBytes = 0;
  let cookieError;
  const cookieValue = () => Array.from(visible, ([name, value]) => name + "=" + value).join("; ");
  const setCookie = (value) => {
    const text = String(value);
    if (httpOnly.test(text)) return;
    const first = text.split(";", 1)[0] ?? "";
    const equals = first.indexOf("=");
    if (equals <= 0) return;
    if (cookieBytes + encoder.encode(text).byteLength > MAX_COOKIE_BYTES) {
      cookieError = "script cookie output exceeds the 64 KiB limit";
      return;
    }
    cookieBytes += encoder.encode(text).byteLength;
    setCookies.push(text);
    const name = first.slice(0, equals).trim();
    const nextValue = first.slice(equals + 1).trim();
    const maxAge = /(?:^|;)\s*max-age\s*=\s*(-?\d+)/i.exec(text);
    if (maxAge && Number(maxAge[1]) <= 0) visible.delete(name);
    else visible.set(name, nextValue);
  };
  const bootstrap = [
    "(function () {",
    "  const cookieRead = __cookieRead;",
    "  const cookieWrite = __cookieWrite;",
    "  const location = Object.freeze({ href: String(__url) });",
    "  const document = {};",
    "  Object.defineProperty(document, 'cookie', {",
    "    enumerable: true,",
    "    get: () => String(cookieRead()),",
    "    set: (value) => cookieWrite(String(value)),",
    "  });",
    "  document.location = location;",
    "  document.referrer = '';",
    "  const navigator = Object.freeze({",
    "    userAgent: String(__userAgent), language: 'en-US', languages: Object.freeze(['en-US']),",
    "    cookieEnabled: true, webdriver: false,",
    "  });",
    "  const console = Object.freeze({ log() {}, warn() {}, error() {}, info() {} });",
    "  const window = { document, location, navigator, console, Promise };",
    "  window.window = window; window.self = window; window.globalThis = globalThis;",
    "  Object.assign(globalThis, { document, location, navigator, console, window, self: window });",
    "})();",
  ].join('\n');
  const context = Object.assign(Object.create(null), {
    __cookieRead: () => cookieValue(),
    __cookieWrite: (value) => setCookie(value),
    __url: String(input.url),
    __userAgent: String(input.userAgent),
  });
  const vmContext = vm.createContext(context, {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(bootstrap, vmContext);
  for (const name of [
    '__cookieRead', '__cookieWrite', '__url', '__userAgent',
  ]) delete context[name];
  const result = await vm.runInContext(
    "(async function () {\n" + String(input.source) + "\n})()",
    vmContext,
  );
  if (cookieError) return { ok: false, reason: cookieError };
  return { ok: true, value: String(result ?? ""), setCookies };
};
run().then(send, (cause) => send({ ok: false, reason: errorMessage(cause) }));
`;

interface Output {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly bytes: number;
}

const join = (chunks: ReadonlyArray<Uint8Array>, bytes: number): Uint8Array => {
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const hostProcess =
  typeof globalThis.process === "object" ? globalThis.process : undefined;

const makeEvaluate = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: BrowserMockOptions,
): BrowserScriptRuntime["evaluate"] =>
  Effect.fn("BrowserMock.evaluate")(function* (
    source: string,
    context: BrowserScriptContext = {
      url: "about:blank",
      cookie: "",
      userAgent: "",
    },
  ): Effect.fn.Return<BrowserScriptResult, BrowserScriptError> {
    if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
      return yield* new BrowserScriptError({
        reason: "script source exceeds the 64 KiB limit",
      });
    }
    const input = yield* Schema.encodeEffect(RunnerInputJson)({
      source,
      url: context.url,
      cookie: context.cookie,
      userAgent: context.userAgent,
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
    const encodedInput = new TextEncoder().encode(input);
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
                stdin: { stream: "pipe", endOnDone: true },
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
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (yield* Ref.get(stopped)) return;
            yield* Ref.set(stopped, true);
            yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
          }),
        );
        const read = Effect.gen(function* () {
          const collected = yield* handle.stdout.pipe(
            Stream.runFoldEffect(
              (): Output => ({ chunks: [], bytes: 0 }),
              (state, chunk: Uint8Array) => {
                const bytes = state.bytes + chunk.byteLength;
                return bytes > MAX_OUTPUT_BYTES
                  ? Effect.fail(
                      new BrowserScriptError({
                        reason: "browser script output exceeds the limit",
                      }),
                    )
                  : Effect.succeed({
                      chunks: [...state.chunks, chunk],
                      bytes,
                    });
              },
            ),
            Effect.mapError((cause) =>
              cause instanceof BrowserScriptError
                ? cause
                : new BrowserScriptError({
                    reason: "failed to read browser script output",
                    cause,
                  }),
            ),
          );
          yield* handle.exitCode.pipe(
            Effect.mapError(
              (cause) =>
                new BrowserScriptError({
                  reason: "browser script process exited without a result",
                  cause,
                }),
            ),
            Effect.catchCause((cause) =>
              Ref.get(stopped).pipe(
                Effect.flatMap((wasStopped) =>
                  wasStopped
                    ? Effect.fail(timeoutError())
                    : Effect.failCause(cause),
                ),
              ),
            ),
          );
          yield* Ref.set(stopped, true);
          return new TextDecoder().decode(
            join(collected.chunks, collected.bytes),
          );
        });
        return yield* Effect.raceFirst(
          Effect.gen(function* () {
            yield* Stream.run(Stream.succeed(encodedInput), handle.stdin).pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserScriptError({
                    reason: "failed to write browser script input",
                    cause,
                  }),
              ),
            );
            return yield* read;
          }),
          Effect.gen(function* () {
            yield* Effect.sleep(
              Duration.millis(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            );
            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Ref.set(stopped, true);
                yield* handle.kill({ killSignal: "SIGKILL" }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new BrowserScriptError({
                        reason: "failed to terminate timed-out script process",
                        cause,
                      }),
                  ),
                );
                return yield* timeoutError();
              }),
            );
          }),
        );
      }),
    );
    const result = yield* Schema.decodeEffect(RunnerOutputJson)(output).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserScriptError({
            reason: "browser script process returned invalid output",
            cause,
          }),
      ),
    );
    if (!result.ok) {
      return yield* new BrowserScriptError({ reason: result.reason });
    }
    return yield* Schema.decodeEffect(BrowserScriptResult)(result).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserScriptError({
            reason: "browser script result failed validation",
            cause,
          }),
      ),
    );
  });

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
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return BrowserMock.of({ evaluate: makeEvaluate(spawner, options) });
      }),
    );
}
