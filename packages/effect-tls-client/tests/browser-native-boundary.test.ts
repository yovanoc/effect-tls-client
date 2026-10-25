import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Sink,
  Stream,
} from "effect";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { BrowserMock } from "../src/browser/BrowserMock.js";
import {
  BrowserScriptError,
  runBoundedScript,
  type BrowserScriptHost,
  type BrowserScriptRuntime,
} from "../src/browser/BrowserScript.js";

const labels = [
  "NativeProcessIoFailure",
  "NativeOutputRejected",
  "ScriptErrorFrameReceived",
  "ChildReportedFailure",
  "NativeProcessCompletionFailure",
  "NativeDeadlineElapsed",
  "NativeResultRejected",
] as const;
const source = 'return "authored";';
const context = { url: "about:blank", cookie: "", userAgent: "fixture" };
const success = {
  type: "result",
  output: { ok: true, value: "authored", setCookies: [] },
};
const frames = (...messages: ReadonlyArray<object>) =>
  Stream.fromIterable(
    messages.map((message) =>
      new TextEncoder().encode(`${JSON.stringify(message)}\n`),
    ),
  );
const ioError = PlatformError.systemError({
  _tag: "Unknown",
  module: "process",
  method: "authored-fixture",
});

// Only the external process boundary is replaced; every evaluator is the production layer.
const fixture = (
  options: {
    readonly stdout?: ChildProcessSpawner.ChildProcessHandle["stdout"];
    readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
    readonly exitCode?: ChildProcessSpawner.ChildProcessHandle["exitCode"];
    readonly spawnError?: PlatformError.PlatformError;
  } = {},
) => {
  const counts = { spawn: 0, start: 0, kill: 0, release: 0 };
  const stdin = Sink.forEach((_: Uint8Array) =>
    Effect.sync(() => {
      counts.start++;
    }),
  );
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    stdin: options.stdin ?? stdin,
    stdout: options.stdout ?? frames(success),
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode:
      options.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        counts.kill++;
      }),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
  const layer = BrowserMock.layer().pipe(
    Layer.provide(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            counts.spawn++;
            if (options.spawnError !== undefined)
              return yield* options.spawnError;
            return yield* Effect.acquireRelease(Effect.succeed(handle), () =>
              Effect.sync(() => {
                counts.release++;
              }),
            );
          }),
        ),
      ),
    ),
  );
  return { layer, counts };
};

describe("host construction boundary (not failure origin)", () => {
  it("accepts exactly seven optional Schema literals without changing document metadata", () => {
    const decode = Schema.decodeUnknownSync(BrowserScriptError);
    for (const hostBoundary of labels) {
      expect(
        decode({
          _tag: "BrowserScriptError",
          reason: "authored",
          hostBoundary,
        }),
      ).toHaveProperty("hostBoundary", hostBoundary);
    }
    for (const hostBoundary of [
      "GoFault",
      "guest",
      "NativeProcessIoFailure ",
      "",
      null,
      1,
    ]) {
      expect(() =>
        decode({
          _tag: "BrowserScriptError",
          reason: "authored",
          hostBoundary,
        }),
      ).toThrow();
    }
    expect(
      Object.hasOwn(
        decode({ _tag: "BrowserScriptError", reason: "authored" }),
        "hostBoundary",
      ),
    ).toBe(false);
    expect(
      Object.hasOwn(
        new BrowserScriptError({ reason: "authored" }),
        "hostBoundary",
      ),
    ).toBe(false);
    expect(
      BrowserScriptError.fields.documentInputFailure.schema.literals,
    ).toHaveLength(5);
    expect(
      BrowserScriptError.fields.documentInputRule.schema.literals,
    ).toHaveLength(22);
  });

  const branches = [
    {
      name: "spawn",
      options: { spawnError: ioError },
      label: "NativeProcessIoFailure",
      reason: "failed to spawn browser script process",
      cause: ioError,
      kill: 0,
      release: 0,
      start: 0,
    },
    {
      name: "stdout read",
      options: { stdout: Stream.fail(ioError) },
      label: "NativeProcessIoFailure",
      reason: "failed to read script process output",
      cause: ioError,
      kill: 1,
      release: 1,
      start: 1,
    },
    {
      name: "initial stdin write",
      options: { stdin: Sink.fail(ioError) },
      label: "NativeProcessIoFailure",
      reason: "failed to start browser script process",
      cause: ioError,
      kill: 1,
      release: 1,
      start: 0,
    },
    {
      name: "line ceiling",
      options: {
        stdout: Stream.succeed(
          new TextEncoder().encode("x".repeat(128 * 1024 + 1) + "\n"),
        ),
      },
      label: "NativeOutputRejected",
      reason: "script process emitted an oversized IPC line",
      kill: 1,
      release: 1,
      start: 1,
    },
    {
      name: "total output ceiling",
      options: {
        stdout: frames(
          ...Array.from({ length: 9 }, () => ({
            type: "result",
            output: { ok: true, value: "x".repeat(120 * 1024), setCookies: [] },
          })),
        ),
      },
      label: "NativeOutputRejected",
      reason: "script process output exceeds the 1 MiB limit",
      kill: 1,
      release: 1,
      start: 1,
    },
    {
      name: "IPC decoder",
      options: {
        stdout: Stream.succeed(
          new TextEncoder().encode('{"type":"unknown"}\n'),
        ),
      },
      label: "NativeOutputRejected",
      reason: "script process emitted an invalid IPC message",
      schemaCause: true,
      kill: 1,
      release: 1,
      start: 1,
    },
    {
      name: "script.error discriminant",
      options: {
        stdout: frames({
          type: "script.error",
          reason: "script evaluation timed out and the process was terminated",
          hostBoundary: "NativeDeadlineElapsed",
        }),
      },
      label: "ScriptErrorFrameReceived",
      reason: "script evaluation timed out and the process was terminated",
      kill: 1,
      release: 1,
      start: 1,
    },
    {
      name: "failed result discriminant",
      options: {
        stdout: frames({
          type: "result",
          hostBoundary: "NativeDeadlineElapsed",
          output: {
            ok: false,
            reason:
              "script evaluation timed out and the process was terminated",
            hostBoundary: "NativeDeadlineElapsed",
          },
        }),
      },
      label: "ChildReportedFailure",
      reason: "script evaluation timed out and the process was terminated",
      kill: 0,
      release: 1,
      start: 1,
    },
    {
      name: "exitCode effect failure",
      options: { exitCode: Effect.fail(ioError) },
      label: "NativeProcessCompletionFailure",
      reason: "browser script process exited without a result",
      cause: ioError,
      kill: 1,
      release: 1,
      start: 1,
    },
    {
      name: "EOF without result",
      options: { stdout: Stream.empty },
      label: "NativeProcessCompletionFailure",
      reason: "browser script process exited without a result",
      kill: 0,
      release: 1,
      start: 1,
    },
  ];
  for (const branch of branches) {
    it.effect(
      `labels ${branch.name} and preserves reason/cause/cleanup`,
      () => {
        const fake = fixture(branch.options);
        return Effect.gen(function* () {
          const error = yield* Effect.gen(function* () {
            const runtime = yield* BrowserMock;
            expect(runtime.timeoutMs).toBe(2000);
            return yield* runtime.evaluate(source).pipe(Effect.flip);
          }).pipe(Effect.provide(fake.layer));
          expect(error).toHaveProperty("hostBoundary", branch.label);
          expect(error.reason).toBe(branch.reason);
          expect(error._tag).toBe("BrowserScriptError");
          if (branch.cause !== undefined)
            expect(error.cause).toBe(branch.cause);
          else if (branch.schemaCause) expect(error.cause).toBeDefined();
          else expect(Object.hasOwn(error, "cause")).toBe(false);
          expect(Object.hasOwn(error, "documentInputFailure")).toBe(false);
          expect(Object.hasOwn(error, "documentInputRule")).toBe(false);
          expect(fake.counts).toEqual({
            spawn: 1,
            start: branch.start,
            kill: branch.kill,
            release: branch.release,
          });
        });
      },
    );
  }

  it.effect("uses logical time for the native deadline only", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const fake = fixture({
        stdout: Stream.fromEffect(
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        ),
      });
      const fiber = yield* Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        return yield* runtime.evaluate(source).pipe(Effect.flip);
      }).pipe(Effect.provide(fake.layer), Effect.forkChild);
      yield* Deferred.await(reading);
      yield* TestClock.adjust(2000);
      const error = yield* Fiber.join(fiber);
      expect(error).toHaveProperty("hostBoundary", "NativeDeadlineElapsed");
      expect(error.reason).toBe(
        "script evaluation timed out and the process was terminated",
      );
      expect(Object.hasOwn(error, "cause")).toBe(false);
      expect(fake.counts).toEqual({ spawn: 1, start: 1, kill: 1, release: 1 });
    }),
  );

  it.effect("does not classify the cooperative outer timeout", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const fake = fixture({
        stdout: Stream.fromEffect(
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        ),
      });
      const fiber = yield* Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        return yield* runBoundedScript(
          { ...runtime, timeoutMs: 1 },
          source,
        ).pipe(Effect.flip);
      }).pipe(Effect.provide(fake.layer), Effect.forkChild);
      yield* Deferred.await(reading);
      yield* TestClock.adjust(1);
      const error = yield* Fiber.join(fiber);
      expect(Object.hasOwn(error, "hostBoundary")).toBe(false);
      expect(error.reason).toBe("script evaluation timed out");
      expect(fake.counts).toEqual({ spawn: 1, start: 1, kill: 1, release: 1 });
    }),
  );

  it.effect(
    "keeps interruption unclassified and closes the process scope",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const fake = fixture({
          stdout: Stream.fromEffect(
            Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          ),
        });
        const fiber = yield* Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          return yield* runtime.evaluate(source);
        }).pipe(Effect.provide(fake.layer), Effect.forkChild);
        yield* Deferred.await(reading);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(fake.counts).toEqual({
          spawn: 1,
          start: 1,
          kill: 1,
          release: 1,
        });
      }),
  );

  it.effect(
    "preserves a whole defect cause without manufacturing a typed classification",
    () => {
      const defect = { authored: "defect" };
      const cause = Cause.die(defect);
      const fake = fixture({ stdout: Stream.failCause(cause) });
      return Effect.gen(function* () {
        const exit = yield* Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          return yield* runtime.evaluate(source);
        }).pipe(Effect.provide(fake.layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons).toHaveLength(1);
          const reason = exit.cause.reasons[0];
          expect(reason).toBeDefined();
          if (reason !== undefined && Cause.isDieReason(reason)) {
            expect(reason.defect).toBe(defect);
          } else {
            expect.fail("authored defect was not preserved");
          }
        }
        expect(fake.counts).toEqual({
          spawn: 1,
          start: 1,
          kill: 1,
          release: 1,
        });
      });
    },
  );

  for (const mode of ["async", "classic"] as const) {
    it.effect(
      `delegates ${mode} exactly once with the same receiver/arguments and error object`,
      () => {
        const fake = fixture({
          stdout: frames({
            type: "script.error",
            reason: "authored identical error",
          }),
        });
        return Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const evaluateDefault =
            mode === "classic" ? runtime.evaluateClassic : runtime.evaluate;
          if (evaluateDefault === undefined)
            return yield* Effect.die("missing default classic evaluator");
          let calls = 0;
          let captured: BrowserScriptError | undefined;
          const host: BrowserScriptHost = {
            request: () => Effect.die("unexpected request"),
            setCookie: () => Effect.die("unexpected cookie write"),
          };
          const delegate: BrowserScriptRuntime["evaluate"] = function (
            this: BrowserScriptRuntime,
            actualSource,
            actualContext,
            actualHost,
          ) {
            expect(this).toBe(wrapper);
            expect(actualSource).toBe(source);
            expect(actualContext).toBe(context);
            expect(actualHost).toBe(host);
            calls++;
            return evaluateDefault
              .call(runtime, actualSource, actualContext, actualHost)
              .pipe(
                Effect.catchTag("BrowserScriptError", (error) => {
                  captured = error;
                  return Effect.fail(error);
                }),
              );
          };
          const wrapper: BrowserScriptRuntime = {
            ...runtime,
            evaluate: delegate,
            evaluateClassic: delegate,
          };
          const error = yield* runBoundedScript(
            wrapper,
            source,
            context,
            host,
            mode,
          ).pipe(Effect.flip);
          expect(error).toBe(captured);
          expect(error).toHaveProperty(
            "hostBoundary",
            "ScriptErrorFrameReceived",
          );
          expect(calls).toBe(1);
          expect(fake.counts).toEqual({
            spawn: 1,
            start: 1,
            kill: 1,
            release: 1,
          });
        }).pipe(Effect.provide(fake.layer));
      },
    );
  }

  it.effect(
    "leaves pre-spawn and cookie-host wrappers absent and preserves their causes",
    () => {
      const original = new BrowserScriptError({
        reason: "authored cookie failure",
      });
      const fake = fixture({
        stdout: frames({
          type: "cookie.write",
          version: 1,
          value: "authored=x",
        }),
      });
      return Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const invalid = yield* runtime
          .evaluate(source, {
            ...context,
            languages: Array.from({ length: 17 }, () => "en"),
          })
          .pipe(Effect.flip);
        expect(Object.hasOwn(invalid, "hostBoundary")).toBe(false);
        expect(invalid.documentInputFailure).toBe("InvalidContext");
        expect(fake.counts.spawn).toBe(0);
        const error = yield* runtime
          .evaluate(source, context, {
            request: () => Effect.die("unexpected request"),
            setCookie: () => Effect.fail(original),
          })
          .pipe(Effect.flip);
        expect(Object.hasOwn(error, "hostBoundary")).toBe(false);
        expect(error.reason).toBe(original.reason);
        expect(error.cause).toBe(original);
        expect(fake.counts).toEqual({
          spawn: 1,
          start: 1,
          kill: 1,
          release: 1,
        });
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect(
    "ignores guest metadata on success and rejects malformed results at IPC decoding",
    () => {
      const fake = fixture({
        stdout: frames({
          ...success,
          hostBoundary: "NativeDeadlineElapsed",
          output: { ...success.output, hostBoundary: "NativeResultRejected" },
        }),
      });
      const malformed = fixture({
        stdout: frames({
          type: "result",
          output: { ok: true, value: 1, setCookies: [] },
        }),
      });
      return Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          return yield* runtime.evaluate(source);
        }).pipe(Effect.provide(fake.layer));
        expect(result).toEqual({ value: "authored", setCookies: [] });
        expect(fake.counts).toEqual({
          spawn: 1,
          start: 1,
          kill: 0,
          release: 1,
        });
        const error = yield* Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          return yield* runtime.evaluate(source).pipe(Effect.flip);
        }).pipe(Effect.provide(malformed.layer));
        // RunnerOutput already validates the same result fields; the later
        // NativeResultRejected constructor is unreachable with validated frames.
        expect(error).toHaveProperty("hostBoundary", "NativeOutputRejected");
        expect(error.reason).toBe(
          "script process emitted an invalid IPC message",
        );
        expect(error.cause).toBeDefined();
      });
    },
  );
});
