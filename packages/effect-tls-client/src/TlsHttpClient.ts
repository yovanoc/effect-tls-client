import {
  Context,
  Effect,
  Exit,
  Inspectable,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";
import * as Scope from "effect/Scope";
import * as Cookies from "effect/unstable/http/Cookies";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type { HttpClientRequest } from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as UrlParams from "effect/unstable/http/UrlParams";
import {
  TlsClient,
  type Pair,
  type RequestBody as TlsRequestBody,
  type RequestOptions as TlsRequestOptions,
  type SessionConfig,
  type TlsResponse,
  type TlsSession,
} from "./TlsClient.js";
import { TlsRequestError } from "./internal/Errors.js";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ResponseMode = Schema.Literals([
  "stream",
  "bytes",
  "text",
  "json",
  "formData",
  "urlParamsBody",
]);
export type ResponseMode = typeof ResponseMode.Type;

/** Per-request options that are specific to the tls-client transport. */
export const RequestOptionsSchema = Schema.Struct({
  timeoutMs: Schema.optionalKey(NonNegativeInt),
  headerOrder: Schema.optionalKey(Schema.Array(Schema.String)),
  hostOverride: Schema.optionalKey(Schema.String),
  responseMode: Schema.optionalKey(ResponseMode),
});
export type RequestOptions = typeof RequestOptionsSchema.Type;

/**
 * Ambient options for `HttpClient` requests sent through tls-client.
 *
 * The standard `HttpClientRequest` remains the source of truth for method,
 * headers and body. This reference only exposes transport-specific controls.
 */
export const RequestOptions = Context.Reference<RequestOptions>(
  "effect-tls-client/TlsHttpClient/RequestOptions",
  { defaultValue: () => ({}) },
);

const transportError = (
  request: HttpClientRequest,
  cause: unknown,
): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause }),
  });

const encodeError = (
  request: HttpClientRequest,
  cause: unknown,
): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.EncodeError({ request, cause }),
  });

const pairsFromHeaders = (headers: Headers.Headers): Array<Pair> =>
  Object.entries(headers).map(([name, value]) => [name, value]);

const hasHeader = (headers: ReadonlyArray<Pair>, name: string): boolean =>
  headers.some(([headerName]) => headerName.toLowerCase() === name);

const combineHeaderPairs = (pairs: ReadonlyArray<Pair>): Array<Pair> => {
  const combined: Array<Pair> = [];
  for (const [name, value] of pairs) {
    const index = combined.findIndex(
      ([existingName]) => existingName.toLowerCase() === name.toLowerCase(),
    );
    if (index === -1) {
      combined.push([name, value]);
    } else {
      const existing = combined[index]!;
      combined[index] = [existing[0], `${existing[1]}, ${value}`];
    }
  }
  return combined;
};

const withBodyHeaders = (
  headers: Array<Pair>,
  body: HttpBody.HttpBody,
): Array<Pair> => {
  if (body._tag !== "Empty" && body._tag !== "FormData") {
    if (body.contentType !== undefined && !hasHeader(headers, "content-type")) {
      headers.push(["content-type", body.contentType]);
    }
    if (
      body.contentLength !== undefined &&
      !hasHeader(headers, "content-length")
    ) {
      headers.push(["content-length", String(body.contentLength)]);
    }
  }
  return headers;
};

const isReadableStream = (
  value: unknown,
): value is ReadableStream<Uint8Array> =>
  typeof ReadableStream !== "undefined" && value instanceof ReadableStream;

const bodyFromRaw = (
  body: HttpBody.Raw,
  request: HttpClientRequest,
): Effect.Effect<TlsRequestBody, HttpClientError.HttpClientError> => {
  const rawBody = body.body;
  if (rawBody instanceof Uint8Array) return Effect.succeed(rawBody);
  if (typeof rawBody === "string") return Effect.succeed(rawBody);
  if (typeof FormData !== "undefined" && rawBody instanceof FormData) {
    return Effect.succeed(rawBody);
  }
  if (
    typeof URLSearchParams !== "undefined" &&
    rawBody instanceof URLSearchParams
  ) {
    return Effect.succeed(rawBody.toString());
  }
  if (rawBody instanceof ArrayBuffer) {
    return Effect.succeed(new Uint8Array(rawBody));
  }
  if (ArrayBuffer.isView(rawBody)) {
    return Effect.succeed(
      new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength),
    );
  }
  if (isReadableStream(rawBody)) {
    return Effect.succeed(
      Stream.fromReadableStream({
        evaluate: () => rawBody,
        onError: (cause) => cause,
      }),
    );
  }
  if (typeof Blob !== "undefined" && rawBody instanceof Blob) {
    return Effect.tryPromise({
      try: () => rawBody.arrayBuffer(),
      catch: (cause) => encodeError(request, cause),
    }).pipe(Effect.map((bytes) => new Uint8Array(bytes)));
  }
  return Effect.fail(
    encodeError(request, new Error("unsupported Raw HTTP body")),
  );
};

const bodyFromHttpBody = (
  body: HttpBody.HttpBody,
  request: HttpClientRequest,
): Effect.Effect<
  TlsRequestBody | undefined,
  HttpClientError.HttpClientError
> => {
  switch (body._tag) {
    case "Empty":
      return Effect.as(Effect.void, undefined);
    case "Uint8Array":
      return Effect.succeed(body.body);
    case "Raw":
      return bodyFromRaw(body, request);
    case "FormData":
      return Effect.succeed(body.formData);
    case "Stream":
      return Effect.succeed(body.stream);
    default:
      return Effect.die(new Error("unsupported HttpBody variant"));
  }
};

const awaitAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const onAbort = () => resume(Effect.void);
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const abortable = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal,
): Effect.Effect<A, E, R> =>
  signal.aborted
    ? Effect.interrupt
    : Effect.raceFirst(
        effect,
        awaitAbort(signal).pipe(Effect.flatMap(() => Effect.interrupt)),
      );

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

class TlsHttpResponse
  extends Inspectable.Class
  implements HttpClientResponse.HttpClientResponse, Pipeable
{
  readonly [HttpIncomingMessage.TypeId]: typeof HttpIncomingMessage.TypeId;
  readonly [HttpClientResponse.TypeId]: typeof HttpClientResponse.TypeId;
  readonly request: HttpClientRequest;
  readonly url: string;
  private readonly source: TlsResponse;
  private readonly signal: AbortSignal;
  private readonly closeScope: Effect.Effect<void>;
  private readonly responseHeaders: Headers.Headers;
  private readonly responseCookies: Cookies.Cookies;
  private arrayBufferBody:
    | Effect.Effect<ArrayBuffer, HttpClientError.HttpClientError>
    | undefined;
  private textBody:
    | Effect.Effect<string, HttpClientError.HttpClientError>
    | undefined;
  private jsonBody:
    | Effect.Effect<Schema.Json, HttpClientError.HttpClientError>
    | undefined;
  private formDataBody:
    | Effect.Effect<globalThis.FormData, HttpClientError.HttpClientError>
    | undefined;
  private urlParamsBodyValue:
    | Effect.Effect<UrlParams.UrlParams, HttpClientError.HttpClientError>
    | undefined;

  constructor(
    request: HttpClientRequest,
    source: TlsResponse,
    signal: AbortSignal,
    requestScope: Scope.Scope,
  ) {
    super();
    this[HttpIncomingMessage.TypeId] = HttpIncomingMessage.TypeId;
    this[HttpClientResponse.TypeId] = HttpClientResponse.TypeId;
    this.request = request;
    this.source = source;
    this.signal = signal;
    this.closeScope = Scope.close(requestScope, Exit.void).pipe(Effect.ignore);
    this.url = source.url.split("#")[0] ?? source.url;
    this.responseHeaders = Headers.fromInput(
      combineHeaderPairs(source.headers),
    );
    this.responseCookies = source.cookies;
  }

  get status(): number {
    return this.source.status;
  }

  get headers(): Headers.Headers {
    return this.responseHeaders;
  }

  get cookies(): Cookies.Cookies {
    return this.responseCookies;
  }

  get remoteAddress(): Option.Option<string> {
    return Option.none();
  }

  private decodeError(cause: unknown): HttpClientError.HttpClientError {
    return new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request: this.request,
        response: this,
        cause,
      }),
    });
  }

  private emptyBodyError(): HttpClientError.HttpClientError {
    return new HttpClientError.HttpClientError({
      reason: new HttpClientError.EmptyBodyError({
        request: this.request,
        response: this,
        description: "can not read an empty response body",
      }),
    });
  }

  get stream(): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> {
    if (
      this.request.method === "HEAD" ||
      this.status === 204 ||
      this.status === 205 ||
      this.status === 304
    ) {
      return Stream.fail(this.emptyBodyError()).pipe(
        Stream.ensuring(this.source.close),
        Stream.ensuring(this.closeScope),
      );
    }
    return this.source.stream.pipe(
      Stream.filter((chunk) => chunk.byteLength > 0),
      Stream.mapError((cause) => this.decodeError(cause)),
      Stream.interruptWhen(awaitAbort(this.signal)),
      Stream.ensuring(this.source.close),
      Stream.ensuring(this.closeScope),
    );
  }

  get arrayBuffer(): Effect.Effect<
    ArrayBuffer,
    HttpClientError.HttpClientError
  > {
    const cached = this.arrayBufferBody;
    if (cached !== undefined) return cached;
    const body = Effect.cached(
      Effect.catchIf(
        Effect.map(Stream.runCollect(this.stream), (chunks) => {
          const bytes = concatenate(Array.from(chunks));
          const result = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(result).set(bytes);
          return result;
        }),
        (error): error is HttpClientError.HttpClientError =>
          HttpClientError.isHttpClientError(error) &&
          error.reason._tag === "EmptyBodyError",
        () => Effect.succeed(new ArrayBuffer(0)),
      ),
    ).pipe(Effect.runSync);
    this.arrayBufferBody = body;
    return body;
  }

  get text(): Effect.Effect<string, HttpClientError.HttpClientError> {
    const cached = this.textBody;
    if (cached !== undefined) return cached;
    const body = Effect.cached(
      Effect.map(this.arrayBuffer, (value) => new TextDecoder().decode(value)),
    ).pipe(Effect.runSync);
    this.textBody = body;
    return body;
  }

  get json(): Effect.Effect<Schema.Json, HttpClientError.HttpClientError> {
    const cached = this.jsonBody;
    if (cached !== undefined) return cached;
    const body = Effect.cached(
      Effect.flatMap(this.text, (text) =>
        text === ""
          ? Effect.succeed(null)
          : Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
              Effect.mapError((cause) => this.decodeError(cause)),
            ),
      ),
    ).pipe(Effect.runSync);
    this.jsonBody = body;
    return body;
  }

  get urlParamsBody(): Effect.Effect<
    UrlParams.UrlParams,
    HttpClientError.HttpClientError
  > {
    const cached = this.urlParamsBodyValue;
    if (cached !== undefined) return cached;
    const body = Effect.cached(
      Effect.flatMap(this.text, (text) =>
        Effect.try({
          try: () => UrlParams.fromInput(new URLSearchParams(text)),
          catch: (cause) => this.decodeError(cause),
        }),
      ),
    ).pipe(Effect.runSync);
    this.urlParamsBodyValue = body;
    return body;
  }

  get formData(): Effect.Effect<
    globalThis.FormData,
    HttpClientError.HttpClientError
  > {
    const cached = this.formDataBody;
    if (cached !== undefined) return cached;
    const body = Effect.cached(
      Effect.flatMap(this.arrayBuffer, (value) =>
        Effect.tryPromise({
          try: () =>
            new globalThis.Response(value, {
              headers: Object.entries(this.responseHeaders),
            })
              .formData()
              .then((decoded) => {
                const result = new globalThis.FormData();
                decoded.forEach((entry, name) => result.append(name, entry));
                return result;
              }),
          catch: (cause) => this.decodeError(cause),
        }),
      ),
    ).pipe(Effect.runSync);
    this.formDataBody = body;
    return body;
  }

  toJSON(): object {
    return HttpIncomingMessage.inspect(this, {
      _id: "effect/http/HttpClientResponse",
      request: this.request.toJSON(),
      status: this.status,
    });
  }

  pipe() {
    return pipeArguments(this, arguments);
  }
}

const makeClient = (session: TlsSession, profile: string | undefined) =>
  HttpClient.make((request, url, signal, fiber) =>
    Effect.gen(function* () {
      const configured = yield* Schema.decodeEffect(RequestOptionsSchema)(
        fiber.getRef(RequestOptions),
      ).pipe(Effect.mapError((cause) => transportError(request, cause)));
      const body = yield* bodyFromHttpBody(request.body, request);
      const headers = withBodyHeaders(
        pairsFromHeaders(request.headers),
        request.body,
      );
      const headerOrder =
        configured.headerOrder ?? headers.map(([name]) => name);
      const options: TlsRequestOptions = {
        method: request.method,
        headers,
        headerOrder,
        followRedirects: false,
        ...(configured.timeoutMs === undefined
          ? {}
          : { timeoutMs: configured.timeoutMs }),
        ...(configured.hostOverride === undefined
          ? {}
          : { hostOverride: configured.hostOverride }),
        ...(body === undefined ? {} : { body }),
      };
      const scope = Option.getOrUndefined(
        Context.getOption(fiber.context, Scope.Scope),
      );
      if (scope === undefined) {
        return yield* transportError(
          request,
          new Error("TlsHttpClient requests require an active Scope"),
        );
      }
      const requestScope = yield* Scope.fork(scope);
      const closeRequestScope = Scope.close(requestScope, Exit.void).pipe(
        Effect.ignore,
      );
      const context = yield* Effect.context<never>();
      const response = yield* abortable(
        Effect.provideService(
          session.request(url.href, options),
          Scope.Scope,
          requestScope,
        ),
        signal,
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? closeRequestScope : Effect.void,
        ),
        Effect.mapError((cause) =>
          Schema.is(TlsRequestError)(cause) && cause.kind === "Body"
            ? encodeError(request, cause)
            : transportError(request, cause),
        ),
      );
      const onAbort = () => {
        Effect.runForkWith(context)(closeRequestScope);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      yield* Scope.addFinalizer(
        requestScope,
        Effect.sync(() => signal.removeEventListener("abort", onAbort)),
      );
      if (signal.aborted) onAbort();
      yield* Effect.annotateCurrentSpan({
        "tls_client.session": session.id,
        ...(profile === undefined ? {} : { "tls_client.profile": profile }),
        "tls_client.protocol": response.protocol,
      });
      const httpResponse = new TlsHttpResponse(
        request,
        response,
        signal,
        requestScope,
      );
      switch (configured.responseMode) {
        case "bytes":
        case "text":
        case "json":
        case "formData":
        case "urlParamsBody":
          // Buffer non-stream modes without eagerly decoding a response. This
          // keeps status/redirect handling independent from body decoding.
          yield* httpResponse.arrayBuffer;
          break;
        case "stream":
        case undefined:
          break;
      }
      return httpResponse;
    }),
  );

export const fromSession = (
  session: TlsSession,
): Layer.Layer<HttpClient.HttpClient> =>
  HttpClient.layerMergedContext(Effect.succeed(makeClient(session, undefined)));

export const layer = (config: SessionConfig) =>
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const session = yield* client.session(config);
        return HttpClient.layerMergedContext(
          Effect.succeed(
            makeClient(
              session,
              config.profile === undefined ? "custom" : config.profile,
            ),
          ),
        );
      }),
    ),
    TlsClient.layer,
  );
