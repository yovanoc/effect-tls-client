import { Cookies } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import {
  Context,
  Effect,
  Exit,
  Metric,
  Layer,
  Latch,
  Option,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import {
  Bridge,
  type BridgeResponse,
  type BridgeVersion,
  type BridgeWebSocket,
  type RequestBody as BridgeRequestBody,
} from "./internal/Bridge.js";
import {
  BridgeProtocolError,
  SessionConfigError,
  TlsRequestError,
  TlsWebSocketError,
  type BridgeError,
} from "./internal/Errors.js";
import { FrameKind } from "./internal/Frame.js";
import * as TlsClientMetrics from "./Telemetry.js";
import {
  BandwidthResultMeta,
  Cookie as CookieSchema,
  CookiesJson,
  CookiesResultMeta,
  CookiesScriptResultMeta,
  SessionConfig as SessionConfigSchema,
  type Cookie as WireCookie,
  type Pair,
  type SessionConfig as SessionConfigType,
  WsConnectMeta,
  decodeMeta,
} from "./internal/Protocol.js";

export const SessionConfig = SessionConfigSchema;
export type { Pair };
export type SessionConfig = SessionConfigType;
export type Bandwidth = Schema.Schema.Type<typeof BandwidthResultMeta>;

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

const WebSocketOptionsSchema = Schema.Struct({
  headers: Schema.optionalKey(
    Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  ),
  headerOrder: Schema.optionalKey(Schema.Array(Schema.String)),
  subprotocols: Schema.optionalKey(Schema.Array(Schema.String)),
  handshakeTimeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  readBufferSize: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  writeBufferSize: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
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

export interface WebSocketOptions {
  readonly headers?: ReadonlyArray<Pair>;
  readonly headerOrder?: ReadonlyArray<string>;
  readonly subprotocols?: ReadonlyArray<string>;
  readonly handshakeTimeoutMs?: number;
  readonly readBufferSize?: number;
  readonly writeBufferSize?: number;
}

type TlsOperationError = BridgeError;

export interface TlsResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: ReadonlyArray<Pair>;
  readonly protocol: "HTTP/1.1" | "HTTP/2.0" | "HTTP/3.0";
  readonly cookies: Cookies.Cookies;
  readonly bytesRead: Effect.Effect<number, TlsOperationError>;
  readonly bytesWritten: Effect.Effect<number, TlsOperationError>;
  readonly stream: Stream.Stream<Uint8Array, TlsOperationError>;
  readonly bytes: Effect.Effect<Uint8Array, TlsOperationError>;
  readonly text: Effect.Effect<string, TlsOperationError>;
  readonly json: Effect.Effect<unknown, TlsOperationError>;
  readonly close: Effect.Effect<void>;
}

export type ProxyInput = string | null | undefined | Option.Option<string>;

export interface TlsSession {
  readonly id: string;
  readonly request: (
    url: string | RequestInput,
    options?: RequestOptions,
  ) => Effect.Effect<TlsResponse, TlsOperationError, Scope.Scope>;
  readonly webSocket: (
    url: string,
    options?: WebSocketOptions,
  ) => Effect.Effect<Socket.Socket, TlsWebSocketError, Scope.Scope>;
  readonly cookies: (
    url: string,
  ) => Effect.Effect<Cookies.Cookies, TlsOperationError>;
  readonly setCookies: (
    url: string,
    cookies: Cookies.Cookies,
  ) => Effect.Effect<void, TlsOperationError>;
  readonly scriptCookies: (
    url: string,
    setCookies?: ReadonlyArray<string>,
  ) => Effect.Effect<string, TlsOperationError>;
  readonly exportCookies: Effect.Effect<string, TlsOperationError>;
  readonly importCookies: (
    json: string,
  ) => Effect.Effect<void, TlsOperationError>;
  readonly bandwidth: Effect.Effect<Bandwidth, TlsOperationError>;
  readonly resetBandwidth: Effect.Effect<void, TlsOperationError>;
  readonly setProxy: (
    proxy: ProxyInput,
  ) => Effect.Effect<void, TlsOperationError>;
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
  readonly bandwidth: Effect.Effect<Bandwidth, TlsOperationError>;
  readonly resetBandwidth: Effect.Effect<void, TlsOperationError>;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const concatenate = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  if (chunks.length === 1) {
    const only = chunks[0];
    if (only) return only;
  }
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

const socketError = (
  phase: "open" | "read" | "write",
  error: BridgeError,
): Socket.SocketError => {
  if (error._tag === "TlsWebSocketError") {
    if (error.kind === "Closed") {
      return new Socket.SocketError({
        reason: new Socket.SocketCloseError({
          code: error.code ?? 1000,
          ...(error.reason === undefined ? {} : { closeReason: error.reason }),
        }),
      });
    }
    if (error.kind === "Read") {
      return new Socket.SocketError({
        reason: new Socket.SocketReadError({ cause: error }),
      });
    }
    if (error.kind === "Write") {
      return new Socket.SocketError({
        reason: new Socket.SocketWriteError({ cause: error }),
      });
    }
    return new Socket.SocketError({
      reason: new Socket.SocketOpenError({
        kind: /timeout|deadline/i.test(error.message) ? "Timeout" : "Unknown",
        cause: error,
      }),
    });
  }
  return new Socket.SocketError({
    reason:
      phase === "open"
        ? new Socket.SocketOpenError({ kind: "Unknown", cause: error })
        : phase === "read"
          ? new Socket.SocketReadError({ cause: error })
          : new Socket.SocketWriteError({ cause: error }),
  });
};

const normalizeWebSocket = (
  url: string,
  options: WebSocketOptions | undefined,
): Effect.Effect<WsConnectMeta, TlsWebSocketError> =>
  Effect.gen(function* () {
    const parsedUrl = yield* Schema.decodeEffect(Schema.String)(url).pipe(
      Effect.mapError(
        (cause) =>
          new TlsWebSocketError({
            kind: "Handshake",
            message: errorMessage(cause),
            cause,
          }),
      ),
    );
    const parsedOptions = yield* Schema.decodeEffect(WebSocketOptionsSchema)(
      options ?? {},
    ).pipe(
      Effect.mapError(
        (cause) =>
          new TlsWebSocketError({
            kind: "Handshake",
            message: "invalid WebSocket options",
            cause,
          }),
      ),
    );
    return yield* Schema.decodeEffect(WsConnectMeta)({
      sessionId: "",
      url: parsedUrl,
      headers: parsedOptions.headers ?? [],
      ...(parsedOptions.headerOrder === undefined
        ? {}
        : { headerOrder: parsedOptions.headerOrder }),
      ...(parsedOptions.subprotocols === undefined
        ? {}
        : { subprotocols: parsedOptions.subprotocols }),
      ...(parsedOptions.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: parsedOptions.handshakeTimeoutMs }),
      ...(parsedOptions.readBufferSize === undefined
        ? {}
        : { readBufferSize: parsedOptions.readBufferSize }),
      ...(parsedOptions.writeBufferSize === undefined
        ? {}
        : { writeBufferSize: parsedOptions.writeBufferSize }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TlsWebSocketError({
            kind: "Handshake",
            message: "invalid WebSocket metadata",
            cause,
          }),
      ),
    );
  });

interface ManagedWebSocket {
  readonly socket: Socket.Socket;
  readonly close: Effect.Effect<void>;
}

const makeWebSocketSocket = (
  bridge: Bridge["Service"],
  sessionId: string,
  meta: WsConnectMeta,
): ManagedWebSocket => {
  const latch = Latch.makeUnsafe(false);
  let connection: BridgeWebSocket | undefined;
  let failure: Socket.SocketError | undefined;
  const countedConnections = new Set<BridgeWebSocket>();

  const localCloseError = (code = 1000, reason = "") =>
    new Socket.SocketError({
      reason: new Socket.SocketCloseError({
        code,
        ...(reason === "" ? {} : { closeReason: reason }),
      }),
    });
  const setFailure = (error: Socket.SocketError): void => {
    if (failure === undefined) failure = error;
    connection = undefined;
    latch.openUnsafe();
  };
  const closeConnection = (
    active: BridgeWebSocket,
    code = 1000,
    reason = "",
  ): Effect.Effect<void> => {
    const closeReason = reason ?? "";
    setFailure(localCloseError(code, closeReason));
    const decrement = Effect.suspend(() =>
      countedConnections.delete(active)
        ? Metric.modify(TlsClientMetrics.webSocketConnectionsActive, -1)
        : Effect.void,
    );
    return active
      .close(code, closeReason)
      .pipe(Effect.ignore, Effect.ensuring(decrement));
  };

  const reader: Socket.Socket["reader"] = Effect.gen(function* () {
    failure = undefined;
    connection = undefined;
    latch.closeUnsafe();
    const active = yield* bridge
      .webSocket({ ...meta, sessionId })
      .pipe(Effect.mapError((error) => socketError("open", error)));
    connection = active;
    yield* Effect.addFinalizer(() => closeConnection(active));
    yield* Effect.uninterruptible(
      Effect.sync(() => countedConnections.add(active)).pipe(
        Effect.flatMap(() =>
          Metric.modify(TlsClientMetrics.webSocketConnectionsActive, 1),
        ),
      ),
    );
    latch.openUnsafe();

    const read = Effect.suspend(() => {
      if (connection !== active) {
        return Effect.fail(failure ?? localCloseError());
      }
      return active.pull.pipe(
        Effect.map((frame) =>
          frame.opcode === 1
            ? new TextDecoder().decode(frame.body)
            : frame.body,
        ),
        Effect.mapError((error) => {
          const mapped = socketError("read", error);
          if (connection === active) setFailure(mapped);
          return mapped;
        }),
      );
    });
    return {
      pull: read.pipe(Effect.map((value) => [value] as const)),
      upgrade: Socket.SocketUpgradeError.unsupported,
    };
  });

  const write = (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ): Effect.Effect<void, Socket.SocketError> =>
    Effect.suspend(() => {
      const active = connection;
      if (active === undefined) {
        if (failure !== undefined) return Effect.fail(failure);
        return latch.whenOpen(
          Effect.suspend(() => {
            if (connection !== undefined) return write(chunk);
            return Effect.fail(failure ?? localCloseError());
          }),
        );
      }
      if (Socket.isCloseEvent(chunk)) {
        return closeConnection(active, chunk.code, chunk.reason).pipe(
          Effect.mapError((error) => socketError("write", error)),
        );
      }
      const opcode = typeof chunk === "string" ? 1 : 2;
      return active
        .write(
          opcode,
          chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk),
        )
        .pipe(
          Effect.mapError((error) => {
            const mapped = socketError("write", error);
            if (connection === active) setFailure(mapped);
            return mapped;
          }),
        );
    });
  const writer: Socket.Socket["writer"] = Effect.succeed({
    write,
    writeAll: (chunks: ReadonlyArray<Uint8Array | string>) =>
      Effect.forEach(chunks, (chunk) => write(chunk), { discard: true }),
  });

  return {
    socket: Socket.make({ reader, writer }),
    close: Effect.suspend(() => {
      const active = connection;
      return active === undefined ? Effect.void : closeConnection(active);
    }),
  };
};

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

const cookiesFromWire = (
  values: ReadonlyArray<WireCookie>,
): Effect.Effect<Cookies.Cookies, TlsRequestError> =>
  Effect.try({
    try: () =>
      Cookies.fromIterable(
        values.map((cookie) => {
          const expires =
            cookie.expires === null
              ? undefined
              : new Date(cookie.expires * 1000);
          if (expires !== undefined && Number.isNaN(expires.getTime())) {
            throw new Error(
              `cookie ${cookie.name} has an invalid expires value`,
            );
          }
          return Cookies.makeCookieUnsafe(cookie.name, cookie.value, {
            ...(cookie.domain === "" ? {} : { domain: cookie.domain }),
            ...(cookie.path === "" ? {} : { path: cookie.path }),
            ...(expires === undefined ? {} : { expires }),
            ...(cookie.secure ? { secure: true } : {}),
            ...(cookie.httpOnly ? { httpOnly: true } : {}),
            ...(cookie.sameSite === undefined
              ? {}
              : {
                  sameSite:
                    cookie.sameSite === "Lax"
                      ? "lax"
                      : cookie.sameSite === "Strict"
                        ? "strict"
                        : "none",
                }),
          });
        }),
      ),
    catch: (cause) =>
      requestConfigError("invalid cookies returned by Bridge", cause),
  });

const decodeCookieResult = (frame: {
  readonly meta: Uint8Array;
}): Effect.Effect<ReadonlyArray<WireCookie>, BridgeProtocolError> =>
  Effect.try({
    try: () => decodeMeta(CookiesResultMeta, frame.meta).cookies,
    catch: (cause) =>
      new BridgeProtocolError({
        message: "invalid cookie response metadata",
        cause,
      }),
  });

const decodeScriptCookieResult = (frame: {
  readonly meta: Uint8Array;
}): Effect.Effect<string, BridgeProtocolError> =>
  Effect.try({
    try: () => decodeMeta(CookiesScriptResultMeta, frame.meta).cookie,
    catch: (cause) =>
      new BridgeProtocolError({
        message: "invalid script cookie response metadata",
        cause,
      }),
  });

const decodeBandwidthResult = (frame: {
  readonly meta: Uint8Array;
}): Effect.Effect<Bandwidth, BridgeProtocolError> =>
  Effect.try({
    try: () => decodeMeta(BandwidthResultMeta, frame.meta),
    catch: (cause) =>
      new BridgeProtocolError({
        message: "invalid bandwidth response metadata",
        cause,
      }),
  });

const requestMetric = (profile: string, protocol: string, errorKind: string) =>
  Metric.update(
    Metric.withAttributes(TlsClientMetrics.requests, {
      profile,
      protocol,
      error_kind: errorKind,
    }),
    1,
  );

const requestErrorKind = (error: TlsOperationError): string =>
  Schema.is(TlsRequestError)(error) ? error.kind : error._tag;

const normalizeProxy = (proxy: ProxyInput): string | null =>
  Option.isOption(proxy) ? Option.getOrNull(proxy) : (proxy ?? null);

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
  profile: string,
): Effect.Effect<TlsResponse, TlsOperationError> =>
  Effect.gen(function* () {
    const end = yield* Effect.cached(
      response.end.pipe(
        Effect.tap((value) =>
          Effect.all(
            [
              Metric.update(
                Metric.withAttributes(TlsClientMetrics.bytesRead, {
                  profile,
                  protocol: value.protocol ?? "unknown",
                }),
                value.bytesRead,
              ),
              Metric.update(
                Metric.withAttributes(TlsClientMetrics.bytesWritten, {
                  profile,
                  protocol: value.protocol ?? "unknown",
                }),
                value.bytesWritten,
              ),
              requestMetric(profile, value.protocol ?? "unknown", "none"),
            ],
            { discard: true },
          ),
        ),
        Effect.tapError((error) =>
          requestMetric(
            profile,
            response.headers.protocol ?? "unknown",
            requestErrorKind(error),
          ),
        ),
      ),
    );
    const stream = response.stream.pipe(
      Stream.ensuring(end.pipe(Effect.ignore)),
    );
    const bytes = yield* Effect.cached(
      Stream.runCollect(stream).pipe(Effect.map(concatenate)),
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
      bytesRead: bytes.pipe(
        Effect.flatMap(() => end),
        Effect.map((value) => value.bytesRead),
      ),
      bytesWritten: bytes.pipe(
        Effect.flatMap(() => end),
        Effect.map((value) => value.bytesWritten),
      ),
      stream,
      bytes,
      text,
      json,
      close: response.close.pipe(Effect.ensuring(end.pipe(Effect.ignore))),
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
  | { readonly sessionId: string; readonly profile: string }
  | { readonly config: SessionConfigType; readonly profile: string };

const requestWith = (
  bridge: Bridge["Service"],
  target: RequestTarget,
  urlOrInput: string | RequestInput,
  options?: RequestOptions,
): Effect.Effect<TlsResponse, TlsOperationError, Scope.Scope> =>
  Effect.gen(function* () {
    const normalized = yield* normalizeRequest(urlOrInput, options);
    const { profile, ...requestTarget } = target;
    const response = yield* bridge
      .request({ ...requestTarget, ...normalized.meta }, normalized.body)
      .pipe(
        Effect.tapError((error) =>
          requestMetric(profile, "unknown", requestErrorKind(error)),
        ),
      );
    const tlsResponse = yield* responseFrom(response, target.profile).pipe(
      Effect.tapError(() => response.close),
    );
    yield* Effect.addFinalizer(() => tlsResponse.close);
    return tlsResponse;
  });

const makeTlsClientLayerInternal = (service: typeof TlsClient) =>
  Layer.effect(
    service,
    Effect.gen(function* () {
      const bridge = yield* Bridge;
      const activeSessions = new Map<string, Effect.Effect<void>>();
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          const destroyers = Array.from(activeSessions.values());
          activeSessions.clear();
          return Effect.forEach(destroyers, (destroy) => destroy, {
            discard: true,
          }).pipe(Effect.asVoid);
        }),
      );
      const request = Effect.fn("TlsClient.request")(function* (
        input: SessionConfigType,
        urlOrInput: string | RequestInput,
        options?: RequestOptions,
      ) {
        const config = yield* normalizeConfig(input);
        return yield* requestWith(
          bridge,
          { config, profile: config.profile ?? "custom" },
          urlOrInput,
          options,
        );
      });
      const bandwidth = Effect.gen(function* () {
        const frame = yield* bridge.call(
          FrameKind.bandwidthGet,
          {},
          undefined,
          BandwidthResultMeta,
        );
        return yield* decodeBandwidthResult(frame);
      });
      const resetBandwidth = bridge
        .call(FrameKind.bandwidthReset, {})
        .pipe(Effect.asVoid);
      const session = Effect.fn("TlsClient.session")(function* (
        input: SessionConfigType,
      ) {
        const config = yield* normalizeConfig(input);
        const sessionId = globalThis.crypto.randomUUID();
        let destroySent = false;
        let sessionActive = false;
        const destroySession = Effect.suspend(() => {
          if (destroySent) return Effect.void;
          destroySent = true;
          activeSessions.delete(sessionId);
          return bridge
            .call(FrameKind.sessionDestroy, { sessionId })
            .pipe(
              Effect.ignore,
              Effect.ensuring(
                sessionActive
                  ? Metric.modify(TlsClientMetrics.sessionsActive, -1)
                  : Effect.void,
              ),
            );
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
            activeSessions.set(sessionId, destroySession);
            sessionActive = true;
            yield* Metric.modify(TlsClientMetrics.sessionsActive, 1);
            return yield* Effect.acquireRelease(
              Effect.succeed(
                makeSession(bridge, sessionId, config.profile ?? "custom"),
              ),
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
        bandwidth,
        resetBandwidth,
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
  profile: string,
): TlsSession => {
  const cookies = Effect.fn("TlsSession.cookies")(function* (url: string) {
    const frame = yield* bridge.call(
      FrameKind.cookiesGet,
      { sessionId, url },
      undefined,
      CookiesResultMeta,
    );
    const values = yield* decodeCookieResult(frame);
    return yield* cookiesFromWire(values);
  });
  const setCookies = Effect.fn("TlsSession.setCookies")(function* (
    url: string,
    value: Cookies.Cookies,
  ) {
    const values = yield* normalizeCookies(value);
    yield* bridge
      .call(FrameKind.cookiesSet, {
        sessionId,
        url,
        cookies: values ?? [],
      })
      .pipe(Effect.asVoid);
  });
  const scriptCookies = Effect.fn("TlsSession.scriptCookies")(function* (
    url: string,
    setCookies?: ReadonlyArray<string>,
  ) {
    const frame = yield* bridge.call(
      FrameKind.cookiesScript,
      {
        sessionId,
        url,
        ...(setCookies === undefined ? {} : { setCookies }),
      },
      undefined,
      CookiesScriptResultMeta,
    );
    return yield* decodeScriptCookieResult(frame);
  });
  const exportCookies = Effect.gen(function* () {
    const frame = yield* bridge.call(
      FrameKind.cookiesExport,
      { sessionId },
      undefined,
      CookiesResultMeta,
    );
    const values = yield* decodeCookieResult(frame);
    return yield* Effect.try({
      try: () => Schema.encodeSync(CookiesJson)(values),
      catch: (cause) =>
        new BridgeProtocolError({
          message: "failed to encode exported cookies",
          cause,
        }),
    });
  });
  const importCookies = Effect.fn("TlsSession.importCookies")(function* (
    json: string,
  ) {
    const values = yield* Schema.decodeUnknownEffect(CookiesJson)(json).pipe(
      Effect.mapError((cause) =>
        requestConfigError("invalid cookie export", cause),
      ),
    );
    yield* bridge
      .call(FrameKind.cookiesImport, { sessionId, cookies: values })
      .pipe(Effect.asVoid);
  });
  const bandwidth = Effect.gen(function* () {
    const frame = yield* bridge.call(
      FrameKind.bandwidthGet,
      { sessionId },
      undefined,
      BandwidthResultMeta,
    );
    return yield* decodeBandwidthResult(frame);
  });
  const resetBandwidth = bridge
    .call(FrameKind.bandwidthReset, { sessionId })
    .pipe(Effect.asVoid);
  const setProxy = Effect.fn("TlsSession.setProxy")(function* (
    proxy: ProxyInput,
  ) {
    yield* bridge
      .call(FrameKind.sessionProxy, {
        sessionId,
        proxyUrl: normalizeProxy(proxy),
      })
      .pipe(Effect.asVoid);
  });
  const webSocket = Effect.fn("TlsSession.webSocket")(function* (
    url: string,
    options?: WebSocketOptions,
  ) {
    const meta = yield* normalizeWebSocket(url, options);
    const managed = makeWebSocketSocket(bridge, sessionId, meta);
    yield* Effect.addFinalizer(() => managed.close);
    return managed.socket;
  });

  return {
    id: sessionId,
    request: (urlOrInput, options) =>
      requestWith(bridge, { sessionId, profile }, urlOrInput, options),
    webSocket,
    bandwidth,
    resetBandwidth,
    cookies,
    setCookies,
    scriptCookies,
    exportCookies,
    importCookies,
    setProxy,
  };
};
