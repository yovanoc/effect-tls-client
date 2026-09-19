import { Context, Deferred, Duration, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveBridgeBinary } from "./BridgeBinary.js";
import {
  BridgeExited,
  BridgeProtocolError,
  BridgeSpawnError,
  BridgeVersionMismatch,
  type BridgeError,
} from "./Errors.js";
import {
  encodeFrame,
  FrameDecoder,
  FrameKind,
  type Frame,
  type FrameInput,
} from "./Frame.js";
import {
  EmptyMeta,
  ErrorMeta,
  HelloAckMeta,
  HelloMeta,
  PROTOCOL_VERSION,
  decodeEmptyMeta,
  decodeMeta,
  encodeEmptyMeta,
  encodeMeta,
} from "./Protocol.js";

export const PACKAGE_VERSION = "0.0.0";
const STDERR_TAIL_BYTES = 4096;
const SHUTDOWN_TIMEOUT_MILLIS = 2000;

export interface BridgeVersion {
  readonly packageVersion: string;
  readonly bridgeVersion: string;
  readonly protocolVersion: number;
  readonly tlsClientVersion: string;
  readonly goVersion: string;
}

interface Pending {
  readonly deferred: Deferred.Deferred<Frame, BridgeError>;
  readonly expected: "hello" | "call" | "shutdown";
}

interface State {
  dead: BridgeError | undefined;
  closing: boolean;
  nextId: number;
  stderrTail: Uint8Array;
  stderrDone: boolean;
  exit:
    | { readonly exitCode: number | null; readonly signal: string | null }
    | undefined;
}

export interface BridgeService {
  readonly call: (
    kind: typeof FrameKind.debugPing,
    meta?: unknown,
    body?: Uint8Array,
  ) => Effect.Effect<Frame, BridgeError>;
  readonly version: Effect.Effect<BridgeVersion, BridgeError>;
}

export class Bridge extends Context.Service<Bridge, BridgeService>()(
  "effect-tls-client/internal/Bridge",
) {
  static readonly layer = Layer.effect(Bridge, makeBridge());
}

const stderrText = (tail: Uint8Array): string => new TextDecoder().decode(tail);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const signalFromError = (cause: unknown): string | null => {
  const seen = new Set<unknown>();
  const visit = (value: unknown): string | null => {
    const text = String(value);
    const match = /signal:\s*['"]([^'"]+)['"]/i.exec(text);
    if (match?.[1] !== undefined) return match[1];
    if (value === null || typeof value !== "object" || seen.has(value))
      return null;
    seen.add(value);
    if ("signal" in value && typeof value.signal === "string") {
      return value.signal;
    }
    if ("cause" in value) {
      const signal = visit(value.cause);
      if (signal !== null) return signal;
    }
    if ("reason" in value) {
      const signal = visit(value.reason);
      if (signal !== null) return signal;
    }
    for (const nested of Object.values(value)) {
      const signal = visit(nested);
      if (signal !== null) return signal;
    }
    return null;
  };
  return (
    visit(cause) ??
    /signal:\s*['"]([^'"]+)['"]/i.exec(errorMessage(cause))?.[1] ??
    null
  );
};

const makeBridgeExited = (
  state: State,
  exitCode: number | null,
  signal: string | null,
): BridgeExited =>
  new BridgeExited({
    exitCode,
    signal,
    stderrTail: stderrText(state.stderrTail),
  });

function makeBridge() {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const binary = yield* resolveBridgeBinary();
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(binary, [], {
          detached: false,
          stdin: { stream: "pipe", endOnDone: false },
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new BridgeSpawnError({
              message: `failed to spawn Bridge: ${errorMessage(cause)}`,
              cause,
            }),
        ),
      );

    const pending = new Map<number, Pending>();
    const state: State = {
      dead: undefined,
      closing: false,
      nextId: 1,
      stderrTail: new Uint8Array(0),
      stderrDone: false,
      exit: undefined,
    };
    const decoder = new FrameDecoder();

    const markDead = (error: BridgeError): void => {
      if (state.dead !== undefined) return;
      state.dead = error;
      const operations = Array.from(pending.values());
      pending.clear();
      for (const operation of operations) {
        Deferred.doneUnsafe(operation.deferred, Effect.fail(error));
      }
    };

    const maybeMarkExited = (): void => {
      if (state.exit !== undefined && state.stderrDone) {
        markDead(
          makeBridgeExited(state, state.exit.exitCode, state.exit.signal),
        );
      }
    };

    const markExited = (
      exitCode: number | null,
      signal: string | null,
    ): void => {
      state.exit = { exitCode, signal };
      maybeMarkExited();
    };

    const appendStderr = (chunk: Uint8Array): void => {
      const total = Math.min(
        STDERR_TAIL_BYTES,
        state.stderrTail.byteLength + chunk.byteLength,
      );
      const next = new Uint8Array(total);
      const oldStart = Math.max(0, state.stderrTail.byteLength - total);
      const chunkStart = Math.max(0, chunk.byteLength - total);
      const old = state.stderrTail.slice(oldStart);
      next.set(old.slice(0, total), 0);
      next.set(
        chunk.slice(chunkStart),
        Math.max(0, total - (chunk.byteLength - chunkStart)),
      );
      state.stderrTail = next;
    };

    const writeBytes = (bytes: Uint8Array): Effect.Effect<void, BridgeError> =>
      Stream.run(Stream.succeed(bytes), handle.stdin).pipe(
        Effect.mapError((_cause) => {
          const error = state.dead ?? makeBridgeExited(state, null, null);
          markDead(error);
          return error;
        }),
      );

    const writeFrame = (input: FrameInput): Effect.Effect<void, BridgeError> =>
      Effect.try({
        try: () => encodeFrame(input),
        catch: (cause) =>
          new BridgeProtocolError({ message: errorMessage(cause), cause }),
      }).pipe(Effect.flatMap(writeBytes));

    const failProtocol = (
      message: string,
      cause?: unknown,
    ): BridgeProtocolError =>
      new BridgeProtocolError(
        cause === undefined ? { message } : { message, cause },
      );

    const completePending = (
      id: number,
      effect: Effect.Effect<Frame, BridgeError>,
    ): void => {
      const operation = pending.get(id);
      if (operation === undefined) return;
      pending.delete(id);
      Deferred.doneUnsafe(operation.deferred, effect);
    };

    const handleFrame = (frame: Frame): BridgeProtocolError | undefined => {
      if (!Object.values(FrameKind).includes(frame.kind)) {
        const error = failProtocol(
          `unknown frame kind 0x${frame.kind.toString(16)}`,
        );
        markDead(error);
        return error;
      }

      const operation = pending.get(frame.id);
      if (operation === undefined) return undefined;

      if (frame.kind === FrameKind.error) {
        if (frame.body.byteLength !== 0) {
          const error = failProtocol("error frame cannot contain a body");
          markDead(error);
          return error;
        }
        try {
          const meta = decodeMeta(ErrorMeta, frame.meta);
          completePending(
            frame.id,
            Effect.fail(new BridgeProtocolError({ message: meta.message })),
          );
        } catch (cause) {
          const error = failProtocol("invalid error metadata", cause);
          markDead(error);
          return error;
        }
        return undefined;
      }

      try {
        if (operation.expected === "hello") {
          if (
            frame.kind !== FrameKind.helloAck ||
            frame.id !== 0 ||
            frame.body.byteLength !== 0
          ) {
            throw failProtocol("expected helloAck for hello");
          }
          decodeMeta(HelloAckMeta, frame.meta);
        } else {
          if (frame.kind !== FrameKind.ok || frame.body.byteLength !== 0) {
            throw failProtocol("expected ok for Bridge operation");
          }
          decodeEmptyMeta(frame.meta);
        }
      } catch (cause) {
        const error =
          cause instanceof BridgeProtocolError
            ? cause
            : failProtocol("invalid response metadata", cause);
        markDead(error);
        return error;
      }

      completePending(frame.id, Effect.succeed(frame));
      return undefined;
    };

    const processChunk = (
      chunk: Uint8Array,
    ): BridgeProtocolError | undefined => {
      try {
        for (const frame of decoder.push(chunk)) {
          const failure = handleFrame(frame);
          if (failure !== undefined) return failure;
        }
        return undefined;
      } catch (cause) {
        return failProtocol("malformed Bridge frame", cause);
      }
    };

    const observeExit = handle.exitCode.pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          Effect.sync(() => markExited(null, signalFromError(cause))),
        onSuccess: (exitCode) =>
          Effect.sync(() => markExited(Number(exitCode), null)),
      }),
    );

    const stdoutLoop = handle.stdout.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const failure = processChunk(chunk);
          if (failure !== undefined) {
            markDead(failure);
            yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
          }
        }),
      ),
      Effect.ignoreCause,
      Effect.tap(() =>
        Effect.sync(() => {
          try {
            decoder.finish();
          } catch (cause) {
            const error = failProtocol(
              "Bridge stdout ended with a malformed frame",
              cause,
            );
            markDead(error);
          }
        }),
      ),
      Effect.flatMap(() => observeExit),
    );

    const stderrLoop = handle.stderr.pipe(
      Stream.runForEach((chunk) => Effect.sync(() => appendStderr(chunk))),
      Effect.ignoreCause,
      Effect.tap(() =>
        Effect.sync(() => {
          state.stderrDone = true;
          maybeMarkExited();
        }),
      ),
    );

    const release = Effect.gen(function* () {
      if (state.closing) return;
      state.closing = true;
      if (state.dead !== undefined) {
        yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
        return;
      }
      const deferred = Deferred.makeUnsafe<Frame, BridgeError>();
      pending.set(0, { deferred, expected: "shutdown" });
      yield* writeFrame({
        kind: FrameKind.shutdown,
        id: 0,
        meta: encodeMeta(EmptyMeta, {}),
      }).pipe(Effect.ignore);
      yield* Effect.raceFirst(
        Deferred.await(deferred).pipe(Effect.asVoid),
        handle.exitCode.pipe(Effect.asVoid),
      ).pipe(
        Effect.timeoutOption(Duration.millis(SHUTDOWN_TIMEOUT_MILLIS)),
        Effect.ignore,
      );
      yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
    }).pipe(Effect.ignore);

    yield* Effect.addFinalizer(() => release);
    yield* stdoutLoop.pipe(Effect.forkScoped);
    yield* stderrLoop.pipe(Effect.forkScoped);
    yield* observeExit.pipe(Effect.forkScoped);

    const helloDeferred = Deferred.makeUnsafe<Frame, BridgeError>();
    pending.set(0, { deferred: helloDeferred, expected: "hello" });
    yield* writeFrame({
      kind: FrameKind.hello,
      id: 0,
      meta: encodeMeta(HelloMeta, {
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: PACKAGE_VERSION,
        window: 1024 * 1024,
        chunkSize: 64 * 1024,
      }),
    });

    const helloFrame = yield* Deferred.await(helloDeferred);
    const hello = yield* Effect.try({
      try: () => decodeMeta(HelloAckMeta, helloFrame.meta),
      catch: (cause) => {
        const error = failProtocol("invalid helloAck metadata", cause);
        markDead(error);
        return error;
      },
    });
    if (
      hello.protocolVersion !== PROTOCOL_VERSION ||
      hello.bridgeVersion !== PACKAGE_VERSION
    ) {
      const error = new BridgeVersionMismatch({
        message: `Bridge version mismatch: expected ${PACKAGE_VERSION} / protocol ${PROTOCOL_VERSION}, got ${hello.bridgeVersion} / protocol ${hello.protocolVersion}`,
        expected: PACKAGE_VERSION,
        actual: hello.bridgeVersion,
      });
      markDead(error);
      yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
      return yield* error;
    }

    const allocateId = (): number => {
      for (;;) {
        const id = state.nextId;
        state.nextId = id === 0xffffffff ? 1 : id + 1;
        if (id !== 0 && !pending.has(id)) return id;
      }
    };

    const call = Effect.fnUntraced(function* (
      kind: typeof FrameKind.debugPing,
      meta?: unknown,
      body?: Uint8Array,
    ) {
      if (state.dead !== undefined) return yield* state.dead;
      if (kind !== FrameKind.debugPing) {
        return yield* new BridgeProtocolError({
          message: "only debug.ping is available in protocol v1",
        });
      }
      const frameMeta = yield* Effect.try({
        try: () => encodeEmptyMeta(meta),
        catch: (cause) =>
          new BridgeProtocolError({
            message: "invalid request metadata",
            cause,
          }),
      });
      const id = allocateId();
      const deferred = Deferred.makeUnsafe<Frame, BridgeError>();
      pending.set(id, { deferred, expected: "call" });
      yield* writeFrame(
        body === undefined
          ? { kind, id, meta: frameMeta }
          : { kind, id, meta: frameMeta, body },
      ).pipe(Effect.tapError(() => Effect.sync(() => pending.delete(id))));
      return yield* Deferred.await(deferred);
    });

    const bridgeVersion: BridgeVersion = {
      packageVersion: PACKAGE_VERSION,
      bridgeVersion: hello.bridgeVersion,
      protocolVersion: hello.protocolVersion,
      tlsClientVersion: hello.tlsClientVersion,
      goVersion: hello.goVersion,
    };

    return Bridge.of({
      call,
      version: Effect.suspend(() =>
        state.dead === undefined
          ? Effect.succeed(bridgeVersion)
          : Effect.fail(state.dead),
      ),
    });
  });
}
