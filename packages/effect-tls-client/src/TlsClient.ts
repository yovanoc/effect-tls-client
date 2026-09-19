import { Cookies } from "effect/unstable/http";
import { Context, Effect, Exit, Layer, Schema, Stream } from "effect";
import type { Scope } from "effect";
import {
  Bridge,
  type BridgeResponse,
  type BridgeVersion,
} from "./internal/Bridge.js";
import {
  SessionConfigError,
  TlsRequestError,
  type BridgeError,
} from "./internal/Errors.js";
import { FrameKind } from "./internal/Frame.js";
import {
  SessionConfig as SessionConfigSchema,
  type Pair,
  type SessionConfig as SessionConfigType,
} from "./internal/Protocol.js";

export const SessionConfig = SessionConfigSchema;
export type { Pair };
export type SessionConfig = SessionConfigType;

const RequestOptionsSchema = Schema.Struct({
  headers: Schema.optionalKey(
    Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  ),
  headerOrder: Schema.optionalKey(Schema.Array(Schema.String)),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  followRedirects: Schema.optionalKey(Schema.Boolean),
  hostOverride: Schema.optionalKey(Schema.String),
});

export interface RequestOptions {
  readonly headers?: ReadonlyArray<Pair>;
  readonly headerOrder?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly followRedirects?: boolean;
  readonly hostOverride?: string;
}

export type RequestInput = RequestOptions & { readonly url: string };

type TlsOperationError = BridgeError;

export interface TlsResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: ReadonlyArray<Pair>;
  readonly protocol: "HTTP/1.1" | "HTTP/2.0" | "HTTP/3.0";
  readonly cookies: Cookies.Cookies;
  readonly stream: Stream.Stream<Uint8Array, TlsOperationError>;
  readonly bytes: Effect.Effect<Uint8Array, TlsOperationError>;
  readonly text: Effect.Effect<string, TlsOperationError>;
  readonly json: Effect.Effect<unknown, TlsOperationError>;
  readonly close: Effect.Effect<void>;
}

export interface TlsSession {
  readonly id: string;
  readonly request: (
    url: string | RequestInput,
    options?: RequestOptions,
  ) => Effect.Effect<TlsResponse, TlsOperationError, Scope.Scope>;
}

export interface TlsClientService {
  readonly version: Effect.Effect<BridgeVersion, BridgeError>;
  readonly session: (
    config: SessionConfigType,
  ) => Effect.Effect<TlsSession, TlsOperationError, Scope.Scope>;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const concatenate = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const requestError = (message: string, cause?: unknown): TlsRequestError =>
  new TlsRequestError({
    kind: "Body",
    message,
    isTransient: false,
    ...(cause === undefined ? {} : { cause }),
  });

const responseFrom = (
  response: BridgeResponse,
): Effect.Effect<TlsResponse, TlsOperationError> =>
  Effect.gen(function* () {
    const bytes = yield* Effect.cached(
      Stream.runCollect(response.stream).pipe(Effect.map(concatenate)),
    );
    const text = yield* Effect.cached(
      bytes.pipe(Effect.map((value) => new TextDecoder().decode(value))),
    );
    const json = yield* Effect.cached(
      text.pipe(
        Effect.flatMap((value) =>
          Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
            value,
          ).pipe(
            Effect.mapError((cause) =>
              requestError("response body is not valid JSON", cause),
            ),
          ),
        ),
      ),
    );
    const setCookies = response.headers.headers
      .filter(([name]) => name.toLowerCase() === "set-cookie")
      .map(([, value]) => value);
    return {
      status: response.headers.status,
      url: response.headers.url,
      headers: response.headers.headers,
      protocol: response.headers.protocol,
      cookies: Cookies.fromSetCookie(setCookies),
      stream: response.stream,
      bytes,
      text,
      json,
      close: response.close,
    };
  });

const normalizeConfig = (
  config: unknown,
): Effect.Effect<SessionConfigType, SessionConfigError> =>
  Schema.decodeUnknownEffect(SessionConfigSchema)(config).pipe(
    Effect.mapError(
      (cause) =>
        new SessionConfigError({
          message: errorMessage(cause),
        }),
    ),
  );

const makeTlsClientLayerInternal = (service: typeof TlsClient) =>
  Layer.effect(
    service,
    Effect.gen(function* () {
      const bridge = yield* Bridge;
      const activeSessionIds = new Set<string>();
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          const sessionIds = Array.from(activeSessionIds);
          activeSessionIds.clear();
          return Effect.forEach(
            sessionIds,
            (sessionId) =>
              bridge
                .call(FrameKind.sessionDestroy, { sessionId })
                .pipe(Effect.ignore),
            { discard: true },
          ).pipe(Effect.asVoid);
        }),
      );
      const session = Effect.fn("TlsClient.session")(function* (
        input: SessionConfigType,
      ) {
        const config = yield* normalizeConfig(input);
        const sessionId = globalThis.crypto.randomUUID();
        let destroySent = false;
        const destroySession = Effect.suspend(() => {
          if (destroySent) return Effect.void;
          destroySent = true;
          activeSessionIds.delete(sessionId);
          return bridge
            .call(FrameKind.sessionDestroy, { sessionId })
            .pipe(Effect.ignore);
        });
        const acquire = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const created = yield* Effect.exit(
              restore(
                bridge
                  .call(FrameKind.sessionCreate, {
                    sessionId,
                    ...config,
                  })
                  .pipe(Effect.asVoid),
              ),
            );
            if (Exit.isFailure(created)) {
              yield* destroySession;
              return yield* Effect.failCause(created.cause);
            }
            activeSessionIds.add(sessionId);
            return yield* Effect.acquireRelease(
              Effect.succeed(makeSession(bridge, sessionId)),
              () => destroySession,
            );
          }),
        );
        return yield* Effect.onInterrupt(acquire, () =>
          destroySession.pipe(Effect.uninterruptible),
        );
      });
      return TlsClient.of({
        version: bridge.version,
        session,
      });
    }),
  );

export class TlsClient extends Context.Service<TlsClient, TlsClientService>()(
  "effect-tls-client/TlsClient",
) {
  static readonly layer = makeTlsClientLayerInternal(TlsClient).pipe(
    Layer.provide(Bridge.layer),
  );
}

/** Layer for deterministic tests with a supplied Bridge service. */
export const makeTlsClientLayer = makeTlsClientLayerInternal(TlsClient);

const makeSession = (
  bridge: Bridge["Service"],
  sessionId: string,
): TlsSession => {
  const request = (
    urlOrInput: string | RequestInput,
    options?: RequestOptions,
  ) =>
    Effect.gen(function* () {
      const url = typeof urlOrInput === "string" ? urlOrInput : urlOrInput.url;
      const optionInput =
        typeof urlOrInput === "string" ? (options ?? {}) : urlOrInput;
      const requestUrl = yield* Schema.decodeEffect(Schema.String)(url).pipe(
        Effect.mapError(
          (cause) =>
            new TlsRequestError({
              kind: "InvalidUrl",
              message: errorMessage(cause),
              isTransient: false,
            }),
        ),
      );
      const parsed = yield* Schema.decodeEffect(RequestOptionsSchema)(
        optionInput,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TlsRequestError({
              kind: "InvalidConfig",
              message: errorMessage(cause),
              isTransient: false,
            }),
        ),
      );
      const requestMeta = {
        sessionId,
        url: requestUrl,
        method: "GET",
        headers: parsed.headers ?? [],
        hasBody: false,
        ...(parsed.headerOrder === undefined
          ? {}
          : { headerOrder: parsed.headerOrder }),
        ...(parsed.timeoutMs === undefined
          ? {}
          : { timeoutMs: parsed.timeoutMs }),
        ...(parsed.followRedirects === undefined
          ? {}
          : { followRedirects: parsed.followRedirects }),
        ...(parsed.hostOverride === undefined
          ? {}
          : { hostOverride: parsed.hostOverride }),
      };
      const response = yield* bridge.request(requestMeta);
      yield* Effect.addFinalizer(() => response.close);
      return yield* responseFrom(response);
    });
  return {
    id: sessionId,
    request,
  };
};
