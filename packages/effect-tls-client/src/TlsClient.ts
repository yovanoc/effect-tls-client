import { Cookies } from "effect/unstable/http";
import { Context, Effect, Exit, Layer, Schema, Stream } from "effect";
import type { Scope } from "effect";
import {
  Bridge,
  type BridgeResponse,
  type BridgeVersion,
  type RequestBody as BridgeRequestBody,
} from "./internal/Bridge.js";
import {
  SessionConfigError,
  TlsRequestError,
  type BridgeError,
} from "./internal/Errors.js";
import { FrameKind } from "./internal/Frame.js";
import {
  Cookie as CookieSchema,
  SessionConfig as SessionConfigSchema,
  type Cookie as WireCookie,
  type Pair,
  type SessionConfig as SessionConfigType,
} from "./internal/Protocol.js";

export const SessionConfig = SessionConfigSchema;
export type { Pair };
export type SessionConfig = SessionConfigType;

const RequestCookieInputSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  domain: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  expires: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  secure: Schema.optionalKey(Schema.Boolean),
  httpOnly: Schema.optionalKey(Schema.Boolean),
  sameSite: Schema.optionalKey(Schema.Literals(["Strict", "Lax", "None"])),
});

const RequestOptionsSchema = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(
    Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  ),
  headerOrder: Schema.optionalKey(Schema.Array(Schema.String)),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  followRedirects: Schema.optionalKey(Schema.Boolean),
  hostOverride: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.Unknown),
  cookies: Schema.optionalKey(Schema.Unknown),
});

export interface RequestCookieInput {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly expires?: number | null;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
}

export type RequestBody =
  | Uint8Array
  | string
  | FormData
  | Stream.Stream<Uint8Array, unknown, never>;

export interface RequestOptions {
  readonly headers?: ReadonlyArray<Pair>;
  readonly headerOrder?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly followRedirects?: boolean;
  readonly hostOverride?: string;
  readonly method?: string;
  readonly body?: RequestBody;
  readonly cookies?: Cookies.Cookies | ReadonlyArray<RequestCookieInput>;
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
  readonly request: (
    config: SessionConfigType,
    request: string | RequestInput,
    options?: RequestOptions,
  ) => Effect.Effect<TlsResponse, TlsOperationError, Scope.Scope>;
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

const requestConfigError = (
  message: string,
  cause?: unknown,
): TlsRequestError =>
  new TlsRequestError({
    kind: "InvalidConfig",
    message,
    isTransient: false,
    ...(cause === undefined ? {} : { cause }),
  });

interface EncodedBody {
  readonly stream: BridgeRequestBody;
  readonly length?: number;
  readonly contentType?: string;
}

interface NormalizedRequest {
  readonly meta: {
    readonly url: string;
    readonly method: string;
    readonly headers: ReadonlyArray<Pair>;
    readonly headerOrder?: ReadonlyArray<string>;
    readonly hasBody: boolean;
    readonly contentLength?: number;
    readonly timeoutMs?: number;
    readonly followRedirects?: boolean;
    readonly hostOverride?: string;
    readonly cookies?: ReadonlyArray<WireCookie>;
  };
  readonly body?: BridgeRequestBody;
}

const isRequestStream = (
  value: RequestBody,
): value is Stream.Stream<Uint8Array, unknown, never> => Stream.isStream(value);

const encodeBody = (
  body: RequestBody | undefined,
): Effect.Effect<EncodedBody | undefined, TlsRequestError> => {
  if (body === undefined) return Effect.succeed(undefined);
  if (body instanceof Uint8Array) {
    return Effect.succeed({
      stream: Stream.succeed(body),
      length: body.byteLength,
    });
  }
  if (typeof body === "string") {
    const bytes = new TextEncoder().encode(body);
    return Effect.succeed({
      stream: Stream.succeed(bytes),
      length: bytes.byteLength,
      contentType: "text/plain;charset=UTF-8",
    });
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return Effect.tryPromise({
      try: async () => {
        const request = new globalThis.Request(
          "http://effect-tls-client.invalid/",
          { method: "POST", body },
        );
        const bytes = new Uint8Array(await request.arrayBuffer());
        const contentType = request.headers.get("content-type");
        return {
          stream: Stream.succeed(bytes),
          length: bytes.byteLength,
          ...(contentType === null ? {} : { contentType }),
        };
      },
      catch: (cause) => requestError("failed to encode FormData", cause),
    });
  }
  if (isRequestStream(body)) return Effect.succeed({ stream: body });
  return Effect.fail(
    requestError("request body must be bytes, string, FormData, or Stream"),
  );
};

const toWireCookie = (cookie: Cookies.Cookie): WireCookie => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.options?.domain ?? "",
  path: cookie.options?.path ?? "/",
  expires:
    cookie.options?.expires === undefined
      ? null
      : Math.floor(cookie.options.expires.getTime() / 1000),
  secure: cookie.options?.secure ?? false,
  httpOnly: cookie.options?.httpOnly ?? false,
  ...(cookie.options?.sameSite === undefined
    ? {}
    : {
        sameSite:
          cookie.options.sameSite === "lax"
            ? "Lax"
            : cookie.options.sameSite === "strict"
              ? "Strict"
              : "None",
      }),
});

const normalizeCookies = (
  value: Cookies.Cookies | ReadonlyArray<RequestCookieInput> | undefined,
): Effect.Effect<ReadonlyArray<WireCookie> | undefined, TlsRequestError> => {
  if (value === undefined) return Effect.succeed(undefined);
  return Effect.try({
    try: () => {
      const cookies = Cookies.isCookies(value)
        ? Object.values(value.cookies).map(toWireCookie)
        : Schema.decodeUnknownSync(Schema.Array(RequestCookieInputSchema))(
            value,
          ).map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain ?? "",
            path: cookie.path ?? "/",
            expires: cookie.expires ?? null,
            secure: cookie.secure ?? false,
            httpOnly: cookie.httpOnly ?? false,
            ...(cookie.sameSite === undefined
              ? {}
              : { sameSite: cookie.sameSite }),
          }));
      return Schema.decodeUnknownSync(Schema.Array(CookieSchema))(cookies);
    },
    catch: (cause) => requestConfigError("invalid request cookies", cause),
  });
};

const headerValue = (
  headers: ReadonlyArray<Pair>,
  name: string,
): string | undefined =>
  headers.find(([headerName]) => headerName.toLowerCase() === name)?.[1];

const normalizeRequest = (
  urlOrInput: string | RequestInput,
  options?: RequestOptions,
): Effect.Effect<NormalizedRequest, TlsRequestError> =>
  Effect.gen(function* () {
    const url = typeof urlOrInput === "string" ? urlOrInput : urlOrInput.url;
    const optionInput: RequestOptions =
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
    const parsed = yield* Schema.decodeUnknownEffect(RequestOptionsSchema)(
      optionInput,
    ).pipe(Effect.mapError((cause) => requestConfigError(errorMessage(cause))));
    const encodedBody = yield* encodeBody(optionInput.body);
    let headers: Array<Pair> = [...(parsed.headers ?? [])];
    if (
      encodedBody?.contentType !== undefined &&
      headerValue(headers, "content-type") === undefined
    ) {
      headers.push(["Content-Type", encodedBody.contentType]);
    }
    const declaredLength = headerValue(headers, "content-length");
    let contentLength = encodedBody?.length;
    if (declaredLength !== undefined) {
      const parsedLength = Number(declaredLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        return yield* requestConfigError(
          "content-length must be a non-negative integer",
        );
      }
      if (encodedBody === undefined && parsedLength !== 0) {
        return yield* requestConfigError(
          "content-length requires a request body",
        );
      }
      if (contentLength !== undefined && parsedLength !== contentLength) {
        return yield* requestConfigError(
          `content-length ${parsedLength} does not match request body length ${contentLength}`,
        );
      }
      contentLength = parsedLength;
    }
    const cookies = yield* normalizeCookies(optionInput.cookies);
    const method =
      parsed.method === undefined || parsed.method === ""
        ? encodedBody === undefined
          ? "GET"
          : "POST"
        : parsed.method;
    return {
      meta: {
        url: requestUrl,
        method,
        headers,
        hasBody: encodedBody !== undefined,
        ...(parsed.headerOrder === undefined
          ? {}
          : { headerOrder: parsed.headerOrder }),
        ...(contentLength === undefined ? {} : { contentLength }),
        ...(parsed.timeoutMs === undefined
          ? {}
          : { timeoutMs: parsed.timeoutMs }),
        ...(parsed.followRedirects === undefined
          ? {}
          : { followRedirects: parsed.followRedirects }),
        ...(parsed.hostOverride === undefined
          ? {}
          : { hostOverride: parsed.hostOverride }),
        ...(cookies === undefined ? {} : { cookies }),
      },
      ...(encodedBody === undefined ? {} : { body: encodedBody.stream }),
    };
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

type RequestTarget =
  | { readonly sessionId: string }
  | { readonly config: SessionConfigType };

const requestWith = (
  bridge: Bridge["Service"],
  target: RequestTarget,
  urlOrInput: string | RequestInput,
  options?: RequestOptions,
): Effect.Effect<TlsResponse, TlsOperationError, Scope.Scope> =>
  Effect.gen(function* () {
    const normalized = yield* normalizeRequest(urlOrInput, options);
    const response = yield* bridge.request(
      { ...target, ...normalized.meta },
      normalized.body,
    );
    yield* Effect.addFinalizer(() => response.close);
    return yield* responseFrom(response);
  });

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
      const request = Effect.fn("TlsClient.request")(function* (
        input: SessionConfigType,
        urlOrInput: string | RequestInput,
        options?: RequestOptions,
      ) {
        const config = yield* normalizeConfig(input);
        return yield* requestWith(bridge, { config }, urlOrInput, options);
      });
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
        request,
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
): TlsSession => ({
  id: sessionId,
  request: (urlOrInput, options) =>
    requestWith(bridge, { sessionId }, urlOrInput, options),
});
