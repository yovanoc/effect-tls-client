import packageJson from "../../package.json" with { type: "json" };
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveBridgeBinary } from "./BridgeBinary.js";
import {
  BridgeExited,
  BridgeProtocolError,
  BridgeSpawnError,
  BridgeVersionMismatch,
  SessionConfigError,
  SessionNotFound,
  TlsRequestError,
  isTransientRequestKind,
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
  AckMeta,
  CancelMeta,
  ChunkMeta,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_WINDOW,
  DebugSleepMeta,
  DebugStreamMeta,
  EmptyMeta,
  EndMeta,
  ErrorMeta,
  HelloAckMeta,
  HelloMeta,
  RequestMeta,
  ResponseHeadersMeta,
  SessionConfigWire,
  SessionIdMeta,
  PROTOCOL_VERSION,
  decodeEmptyMeta,
  decodeMeta,
  encodeEmptyMeta,
  encodeMeta,
} from "./Protocol.js";

export const PACKAGE_VERSION = packageJson.version;
const STDERR_TAIL_BYTES = 4096;
const SHUTDOWN_TIMEOUT_MILLIS = 2000;

type CallKind =
  | typeof FrameKind.debugPing
  | typeof FrameKind.debugSleep
  | typeof FrameKind.sessionCreate
  | typeof FrameKind.sessionDestroy;

export interface BridgeVersion {
  readonly packageVersion: string;
  readonly bridgeVersion: string;
  readonly protocolVersion: number;
  readonly tlsClientVersion: string;
  readonly goVersion: string;
  readonly window?: number;
  readonly chunkSize?: number;
}

interface PendingDeferred {
  readonly _tag: "deferred";
  readonly deferred: Deferred.Deferred<Frame, BridgeError>;
  readonly expected: "hello" | "call" | "shutdown";
}

interface PendingStream {
  readonly _tag: "stream";
  readonly queue: Queue.Queue<Uint8Array, BridgeError | Cause.Done>;
  readonly done: Deferred.Deferred<void>;
  readonly headers: Deferred.Deferred<ResponseHeadersMeta, BridgeError>;
  readonly end: Deferred.Deferred<unknown, BridgeError>;
  readonly expectsHeaders: boolean;
  headersSeen: boolean;
}

type Pending = PendingDeferred | PendingStream;

export interface BridgeResponse {
  readonly headers: ResponseHeadersMeta;
  readonly stream: Stream.Stream<Uint8Array, BridgeError>;
}

interface State {
  dead: BridgeError | undefined;
  closing: boolean;
  nextId: number;
  stderrTail: Uint8Array;
  chunkSize: number;
}

export interface BridgeService {
  readonly call: (
    kind: CallKind,
    meta?: unknown,
    body?: Uint8Array,
  ) => Effect.Effect<Frame, BridgeError>;
  readonly stream: (
    kind: typeof FrameKind.debugStream,
    meta?: unknown,
  ) => Stream.Stream<Uint8Array, BridgeError>;
  readonly request: (
    meta: unknown,
  ) => Effect.Effect<BridgeResponse, BridgeError>;
  readonly version: Effect.Effect<BridgeVersion, BridgeError>;
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

const makeBridge = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const binary = yield* resolveBridgeBinary;
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
  const activeSessions = new Set<string>();
  const writeSemaphore = yield* Semaphore.make(1);
  const state: State = {
    dead: undefined,
    closing: false,
    nextId: 1,
    stderrTail: new Uint8Array(0),
    chunkSize: DEFAULT_CHUNK_SIZE,
  };
  const decoder = new FrameDecoder();
  const getDead = (): BridgeError | undefined =>
    state.dead ??
    (state.closing ? makeBridgeExited(state, null, null) : undefined);

  const markDead = (error: BridgeError): void => {
    if (state.dead !== undefined) return;
    state.dead = error;
    const operations = Array.from(pending.values());
    pending.clear();
    for (const operation of operations) {
      if (operation._tag === "stream") {
        Queue.failCauseUnsafe(operation.queue, Cause.fail(error));
        Deferred.doneUnsafe(operation.headers, Effect.fail(error));
        Deferred.doneUnsafe(operation.end, Effect.fail(error));
        Deferred.doneUnsafe(operation.done, Effect.void);
      } else {
        Deferred.doneUnsafe(operation.deferred, Effect.fail(error));
      }
    }
  };

  const markExited = (exitCode: number | null, signal: string | null): void => {
    markDead(makeBridgeExited(state, exitCode, signal));
  };

  const appendStderr = (chunk: Uint8Array): void => {
    const chunkStart = Math.max(0, chunk.byteLength - STDERR_TAIL_BYTES);
    const retainedChunk = chunk.subarray(chunkStart);
    const retainedOld = Math.min(
      state.stderrTail.byteLength,
      STDERR_TAIL_BYTES - retainedChunk.byteLength,
    );
    const next = new Uint8Array(retainedOld + retainedChunk.byteLength);
    next.set(
      state.stderrTail.subarray(state.stderrTail.byteLength - retainedOld),
    );
    next.set(retainedChunk, retainedOld);
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

  // Every normal, cancellation, and acknowledgement frame uses this one
  // permit, so concurrent fibers cannot interleave writes on stdin.
  const writeFrame = (input: FrameInput): Effect.Effect<void, BridgeError> =>
    Effect.try({
      try: () => encodeFrame(input),
      catch: (cause) =>
        new BridgeProtocolError({ message: errorMessage(cause), cause }),
    }).pipe(
      Effect.flatMap((bytes) =>
        writeSemaphore.withPermit(Effect.uninterruptible(writeBytes(bytes))),
      ),
    );

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
    if (operation === undefined || operation._tag !== "deferred") return;
    pending.delete(id);
    Deferred.doneUnsafe(operation.deferred, effect);
  };

  const completeStream = (id: number, result: "end" | BridgeError): void => {
    const operation = pending.get(id);
    if (operation === undefined || operation._tag !== "stream") return;
    pending.delete(id);
    if (result === "end") {
      Queue.endUnsafe(operation.queue);
      Deferred.doneUnsafe(operation.end, Effect.void);
    } else {
      Queue.failCauseUnsafe(operation.queue, Cause.fail(result));
      Deferred.doneUnsafe(operation.headers, Effect.fail(result));
      Deferred.doneUnsafe(operation.end, Effect.fail(result));
    }
    Deferred.doneUnsafe(operation.done, Effect.void);
  };

  const errorFromMeta = (meta: ErrorMeta): BridgeError => {
    if (meta.kind === "Protocol") {
      return new BridgeProtocolError({ message: meta.message });
    }
    if (meta.kind === "SessionConfig") {
      return new SessionConfigError({ message: meta.message });
    }
    if (meta.kind === "SessionNotFound") {
      const sessionId =
        meta.detail !== undefined &&
        typeof meta.detail["sessionId"] === "string"
          ? meta.detail["sessionId"]
          : "";
      return new SessionNotFound({
        message: meta.message,
        sessionId,
      });
    }
    const detail = meta.detail === undefined ? {} : { detail: meta.detail };
    return new TlsRequestError({
      ...detail,
      kind: meta.kind,
      message: meta.message,
      isTransient: isTransientRequestKind(meta.kind),
    });
  };

  const handleErrorFrame = (
    frame: Frame,
    operation: Pending,
  ): BridgeProtocolError | undefined => {
    if (frame.body.byteLength !== 0) {
      const error = failProtocol("error frame cannot contain a body");
      markDead(error);
      return error;
    }
    try {
      const meta = decodeMeta(ErrorMeta, frame.meta);
      const error = errorFromMeta(meta);
      if (operation._tag === "stream") {
        completeStream(frame.id, error);
      } else {
        completePending(frame.id, Effect.fail(error));
      }
      return undefined;
    } catch (cause) {
      const error = failProtocol("invalid error metadata", cause);
      markDead(error);
      return error;
    }
  };

  const handleStreamFrame = (
    frame: Frame,
    operation: PendingStream,
  ): BridgeProtocolError | undefined => {
    if (frame.kind === FrameKind.error) {
      return handleErrorFrame(frame, operation);
    }
    try {
      if (operation.expectsHeaders && !operation.headersSeen) {
        if (frame.kind !== FrameKind.headers || frame.body.byteLength !== 0) {
          throw failProtocol("expected response headers before body chunks");
        }
        const headers = decodeMeta(ResponseHeadersMeta, frame.meta);
        operation.headersSeen = true;
        Deferred.doneUnsafe(operation.headers, Effect.succeed(headers));
        return undefined;
      }
      if (!operation.expectsHeaders && frame.kind === FrameKind.headers) {
        throw failProtocol("unexpected response headers for Bridge stream");
      }
      if (frame.kind === FrameKind.chunk) {
        if (frame.body.byteLength === 0) {
          throw failProtocol("chunk frame cannot be empty");
        }
        decodeMeta(ChunkMeta, frame.meta);
        if (frame.body.byteLength > state.chunkSize) {
          throw failProtocol(
            `chunk length ${frame.body.byteLength} exceeds negotiated chunkSize ${state.chunkSize}`,
          );
        }
        if (!Queue.offerUnsafe(operation.queue, frame.body)) {
          throw failProtocol("stream chunk queue is closed");
        }
        return undefined;
      }
      if (frame.kind === FrameKind.end) {
        if (frame.body.byteLength !== 0) {
          throw failProtocol("end frame cannot contain a body");
        }
        decodeMeta(EndMeta, frame.meta);
        completeStream(frame.id, "end");
        return undefined;
      }
      throw failProtocol(
        "expected headers, chunk, end, or error for Bridge stream",
      );
    } catch (cause) {
      const error =
        cause instanceof BridgeProtocolError
          ? cause
          : failProtocol("invalid stream response metadata", cause);
      markDead(error);
      return error;
    }
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

    if (operation._tag === "stream") {
      return handleStreamFrame(frame, operation);
    }
    if (frame.kind === FrameKind.error) {
      return handleErrorFrame(frame, operation);
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

  const processChunk = (chunk: Uint8Array): BridgeProtocolError | undefined => {
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
  );

  const release = Effect.gen(function* () {
    if (state.closing) return;
    state.closing = true;
    if (state.dead !== undefined) {
      yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
      return;
    }
    for (const sessionId of activeSessions) {
      yield* writeFrame({
        kind: FrameKind.sessionDestroy,
        id: allocateId(),
        meta: encodeMeta(SessionIdMeta, { sessionId }),
      }).pipe(Effect.ignore);
    }
    activeSessions.clear();
    const deferred = Deferred.makeUnsafe<Frame, BridgeError>();
    pending.set(0, { _tag: "deferred", deferred, expected: "shutdown" });
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
  pending.set(0, {
    _tag: "deferred",
    deferred: helloDeferred,
    expected: "hello",
  });
  yield* writeFrame({
    kind: FrameKind.hello,
    id: 0,
    meta: encodeMeta(HelloMeta, {
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: PACKAGE_VERSION,
      window: DEFAULT_WINDOW,
      chunkSize: DEFAULT_CHUNK_SIZE,
    }),
  });

  const helloFrame = yield* Deferred.await(helloDeferred).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(SHUTDOWN_TIMEOUT_MILLIS),
      orElse: () => {
        const error = failProtocol("Bridge hello timed out");
        markDead(error);
        return handle.kill({ killSignal: "SIGKILL" }).pipe(
          Effect.ignore,
          Effect.flatMap(() => Effect.fail(error)),
        );
      },
    }),
  );
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
  state.chunkSize =
    hello.chunkSize === undefined || hello.chunkSize === 0
      ? DEFAULT_CHUNK_SIZE
      : hello.chunkSize;

  const allocateId = (): number => {
    for (;;) {
      const id = state.nextId;
      state.nextId = id === 0xffffffff ? 1 : id + 1;
      if (id !== 0 && !pending.has(id)) return id;
    }
  };

  const encodeCallMeta = (kind: CallKind, meta: unknown): Uint8Array => {
    if (kind === FrameKind.debugPing) return encodeEmptyMeta(meta);
    if (kind === FrameKind.debugSleep) {
      return encodeMeta(
        DebugSleepMeta,
        Schema.decodeUnknownSync(DebugSleepMeta)(meta ?? {}),
      );
    }
    if (kind === FrameKind.sessionCreate) {
      return encodeMeta(
        SessionConfigWire,
        Schema.decodeUnknownSync(SessionConfigWire)(meta ?? {}),
      );
    }
    return encodeMeta(
      SessionIdMeta,
      Schema.decodeUnknownSync(SessionIdMeta)(meta ?? {}),
    );
  };

  const sendCancel = (id: number): Effect.Effect<void, BridgeError> =>
    Effect.suspend(() => {
      if (state.dead !== undefined || !pending.has(id)) {
        return Effect.void;
      }
      return writeFrame({
        kind: FrameKind.cancel,
        id,
        meta: encodeMeta(CancelMeta, {}),
      });
    });

  const call = Effect.fnUntraced(function* (
    kind: CallKind,
    meta?: unknown,
    body?: Uint8Array,
  ) {
    const initialDead = getDead();
    if (initialDead !== undefined) return yield* initialDead;
    if (kind === FrameKind.debugSleep && body !== undefined) {
      return yield* new BridgeProtocolError({
        message: "debug.sleep does not accept a body",
      });
    }
    const frameMeta = yield* Effect.try({
      try: () => encodeCallMeta(kind, meta),
      catch: (cause) =>
        new BridgeProtocolError({
          message: "invalid request metadata",
          cause,
        }),
    });
    const id = allocateId();
    const deferred = Deferred.makeUnsafe<Frame, BridgeError>();
    const operation: PendingDeferred = {
      _tag: "deferred",
      deferred,
      expected: "call",
    };
    pending.set(id, operation);
    const dead = getDead();
    if (dead !== undefined) {
      pending.delete(id);
      return yield* dead;
    }
    const input: FrameInput =
      body === undefined
        ? { kind, id, meta: frameMeta }
        : { kind, id, meta: frameMeta, body };
    let requestSent = false;
    const frame = yield* Effect.onInterrupt(
      Effect.gen(function* () {
        yield* Effect.uninterruptible(
          writeFrame(input).pipe(
            Effect.tap(() => Effect.sync(() => (requestSent = true))),
            Effect.tapError(() => Effect.sync(() => pending.delete(id))),
          ),
        );
        return yield* Deferred.await(deferred);
      }),
      () =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!requestSent) {
              if (pending.get(id) === operation) pending.delete(id);
              return;
            }
            yield* sendCancel(id).pipe(Effect.ignore);
            if (pending.get(id) === operation) {
              yield* Deferred.await(deferred).pipe(Effect.ignore);
            }
          }),
        ),
    );
    if (
      frame.kind === FrameKind.ok &&
      typeof meta === "object" &&
      meta !== null
    ) {
      const sessionId = (meta as { readonly sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string") {
        if (kind === FrameKind.sessionCreate) activeSessions.add(sessionId);
        if (kind === FrameKind.sessionDestroy) activeSessions.delete(sessionId);
      }
    }
    return frame;
  });

  const encodeStreamMeta = (meta: unknown): Uint8Array =>
    encodeMeta(
      DebugStreamMeta,
      Schema.decodeUnknownSync(DebugStreamMeta)(meta ?? {}),
    );

  const stream = (
    kind: typeof FrameKind.debugStream,
    meta?: unknown,
  ): Stream.Stream<Uint8Array, BridgeError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const initialDead = getDead();
        if (initialDead !== undefined) return yield* initialDead;
        const frameMeta = yield* Effect.try({
          try: () => {
            if (kind !== FrameKind.debugStream) {
              throw new Error("only debug.stream is available in protocol v1");
            }
            return encodeStreamMeta(meta);
          },
          catch: (cause) =>
            new BridgeProtocolError({
              message: "invalid stream metadata",
              cause,
            }),
        });
        const queue = yield* Queue.unbounded<
          Uint8Array,
          BridgeError | Cause.Done
        >();
        const done = Deferred.makeUnsafe<void>();
        const headers = Deferred.makeUnsafe<ResponseHeadersMeta, BridgeError>();
        const end = Deferred.makeUnsafe<unknown, BridgeError>();
        const id = allocateId();
        const operation: PendingStream = {
          _tag: "stream",
          queue,
          done,
          headers,
          end,
          expectsHeaders: false,
          headersSeen: true,
        };
        let requestSent = false;
        yield* Effect.onInterrupt(
          Effect.uninterruptible(
            Effect.sync(() => pending.set(id, operation)).pipe(
              Effect.flatMap(() =>
                writeFrame({ kind, id, meta: frameMeta }).pipe(
                  Effect.tap(() => Effect.sync(() => (requestSent = true))),
                ),
              ),
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (pending.get(id) === operation) pending.delete(id);
                }),
              ),
            ),
          ),
          () =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (!requestSent) {
                  if (pending.get(id) === operation) pending.delete(id);
                  return;
                }
                yield* sendCancel(id).pipe(Effect.ignore);
                if (pending.get(id) === operation) {
                  yield* Deferred.await(done).pipe(Effect.ignore);
                }
              }),
            ),
        );
        return Stream.fromQueue(queue).pipe(
          Stream.mapEffect((bytes) =>
            writeFrame({
              kind: FrameKind.ack,
              id,
              meta: encodeMeta(AckMeta, { bytes: bytes.byteLength }),
            }).pipe(Effect.as(bytes)),
          ),
          Stream.ensuring(
            Effect.uninterruptible(
              Effect.gen(function* () {
                yield* sendCancel(id).pipe(Effect.ignore);
                if (pending.get(id) === operation) {
                  yield* Deferred.await(done);
                }
              }),
            ),
          ),
        );
      }),
    );

  const request = Effect.fnUntraced(function* (meta: unknown) {
    const initialDead = getDead();
    if (initialDead !== undefined) return yield* initialDead;
    const requestMeta = yield* Schema.decodeUnknownEffect(RequestMeta)(
      meta ?? {},
    ).pipe(
      Effect.mapError(
        (cause) =>
          new BridgeProtocolError({
            message: "invalid request metadata",
            cause,
          }),
      ),
    );
    const frameMeta = encodeMeta(RequestMeta, requestMeta);
    const queue = yield* Queue.unbounded<
      Uint8Array,
      BridgeError | Cause.Done
    >();
    const done = Deferred.makeUnsafe<void>();
    const headers = Deferred.makeUnsafe<ResponseHeadersMeta, BridgeError>();
    const end = Deferred.makeUnsafe<unknown, BridgeError>();
    const id = allocateId();
    const operation: PendingStream = {
      _tag: "stream",
      queue,
      done,
      headers,
      end,
      expectsHeaders: true,
      headersSeen: false,
    };
    let requestSent = false;
    const cleanup = () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!requestSent) {
            if (pending.get(id) === operation) pending.delete(id);
            return;
          }
          yield* sendCancel(id).pipe(Effect.ignore);
          if (pending.get(id) === operation) {
            yield* Deferred.await(done).pipe(Effect.ignore);
          }
        }),
      );
    const responseHeaders = yield* Effect.onInterrupt(
      Effect.gen(function* () {
        yield* Effect.uninterruptible(
          Effect.sync(() => pending.set(id, operation)).pipe(
            Effect.flatMap(() =>
              writeFrame({
                kind: FrameKind.request,
                id,
                meta: frameMeta,
              }).pipe(
                Effect.tap(() => Effect.sync(() => (requestSent = true))),
              ),
            ),
            Effect.tapError(() =>
              Effect.sync(() => {
                if (pending.get(id) === operation) pending.delete(id);
              }),
            ),
          ),
        );
        return yield* Deferred.await(headers);
      }),
      cleanup,
    );
    const responseStream = Stream.fromQueue(queue).pipe(
      Stream.mapEffect((bytes) =>
        writeFrame({
          kind: FrameKind.ack,
          id,
          meta: encodeMeta(AckMeta, { bytes: bytes.byteLength }),
        }).pipe(Effect.as(bytes)),
      ),
      Stream.ensuring(cleanup()),
    );
    return { headers: responseHeaders, stream: responseStream };
  });

  const bridgeVersion: BridgeVersion = {
    packageVersion: PACKAGE_VERSION,
    bridgeVersion: hello.bridgeVersion,
    protocolVersion: hello.protocolVersion,
    tlsClientVersion: hello.tlsClientVersion,
    goVersion: hello.goVersion,
    ...(hello.window !== undefined ? { window: hello.window } : {}),
    ...(hello.chunkSize !== undefined ? { chunkSize: hello.chunkSize } : {}),
  };

  return Bridge.of({
    call,
    stream,
    request,
    version: Effect.suspend(() => {
      const dead = getDead();
      return dead === undefined
        ? Effect.succeed(bridgeVersion)
        : Effect.fail(dead);
    }),
  });
});

export class Bridge extends Context.Service<Bridge, BridgeService>()(
  "effect-tls-client/internal/Bridge",
) {
  static readonly layer = Layer.effect(Bridge, makeBridge);
}
