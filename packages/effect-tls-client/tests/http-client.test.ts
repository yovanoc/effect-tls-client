import { describe, expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import { NodeServices } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import type {
  RequestOptions as TlsRequestOptions,
  TlsResponse,
  TlsSession,
} from "../src/TlsClient.js";
import { TlsHttpClient, TlsRequestError } from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/bridge-fixture.mjs", import.meta.url),
);

type Call = {
  readonly url: string;
  readonly options: TlsRequestOptions | undefined;
};

const responseFor = (
  url: string,
  body: Uint8Array,
  stream: Stream.Stream<Uint8Array, never> = Stream.succeed(body),
  close: Effect.Effect<void> = Effect.void,
): TlsResponse => ({
  status: 200,
  url: `${url}#response-fragment`,
  headers: [
    ["Content-Type", "application/json"],
    ["Set-Cookie", "fixture=1; Path=/"],
    ["Link", "</one>"],
    ["link", "</two>"],
  ],
  protocol: "HTTP/1.1",
  cookies: Cookies.fromSetCookie(["fixture=1; Path=/"]),
  stream,
  bytesRead: Effect.succeed(body.byteLength),
  bytesWritten: Effect.succeed(0),
  bytes: Effect.succeed(body),
  text: Effect.succeed(new TextDecoder().decode(body)),
  json: Effect.succeed({ ok: true }),
  close,
});

const makeSession = (
  calls: Array<Call>,
  responseBody: Uint8Array = new TextEncoder().encode('{"ok":true}'),
): TlsSession => ({
  id: "test-session",
  request: (url, options) =>
    Effect.sync(() => {
      const requestUrl = typeof url === "string" ? url : url.url;
      calls.push({ url: requestUrl, options });
      return responseFor(requestUrl, responseBody);
    }),
  webSocket: () => Effect.die("unused"),
  cookies: () => Effect.die("unused"),
  setCookies: () => Effect.die("unused"),
  scriptCookies: () => Effect.die("unused"),
  exportCookies: Effect.die("unused"),
  importCookies: () => Effect.die("unused"),
  bandwidth: Effect.succeed({ read: 0, written: 0 }),
  resetBandwidth: Effect.void,
  setProxy: () => Effect.die("unused"),
});

const runWithSession = <A, E>(
  session: TlsSession,
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
) =>
  Effect.scoped(
    effect.pipe(Effect.provide(TlsHttpClient.fromSession(session))),
  );

describe("TlsHttpClient", () => {
  it.live("provides a scoped HttpClient layer from session configuration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get("https://fixture.test/data");
        expect(yield* response.json).toEqual({ ok: true });
      }).pipe(
        Effect.provide(
          TlsHttpClient.layer({ profile: "chrome_146" }).pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    TLS_CLIENT_BRIDGE_PATH: fixturePath,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "implements the Effect response contract and cached accessors",
    () => {
      const calls: Array<Call> = [];
      const body = new TextEncoder().encode('{"ok":true}');

      return runWithSession(
        makeSession(calls, body),
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get("https://fixture.test/data");

          expect(response.url).toBe("https://fixture.test/data");
          expect(response[HttpIncomingMessage.TypeId]).toBe(
            HttpIncomingMessage.TypeId,
          );
          expect(response[HttpClientResponse.TypeId]).toBe(
            HttpClientResponse.TypeId,
          );
          expect(response.headers["content-type"]).toBe("application/json");
          expect(response.headers["link"]).toBe("</one>, </two>");
          expect(response.cookies.cookies["fixture"]?.value).toBe("1");
          expect(yield* response.text).toBe('{"ok":true}');
          expect(yield* response.text).toBe('{"ok":true}');
          expect(yield* response.arrayBuffer).toEqual(body.buffer);
          expect(
            yield* HttpClientResponse.schemaBodyJson(
              Schema.Struct({ ok: Schema.Boolean }),
            )(response),
          ).toEqual({ ok: true });
        }),
      );
    },
  );

  it.effect("preserves empty response body accessors", () => {
    const calls: Array<Call> = [];
    const session = makeSession(calls);
    const emptySession: TlsSession = {
      ...session,
      request: (url, options) =>
        Effect.sync(() => {
          const requestUrl = typeof url === "string" ? url : url.url;
          calls.push({ url: requestUrl, options });
          return {
            ...responseFor(requestUrl, new Uint8Array(), Stream.empty),
            headers: [
              ["Content-Type", "application/octet-stream"],
              ["Content-Length", "0"],
            ],
          };
        }),
    };

    return runWithSession(
      emptySession,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get("https://fixture.test/empty");
        expect(yield* response.text).toBe("");
        expect(yield* response.json).toBeNull();
      }),
    );
  });

  it.effect("keeps no-body status streams distinct from empty bodies", () => {
    const session: TlsSession = {
      ...makeSession([]),
      request: (url, _options) =>
        Effect.sync(() => {
          const requestUrl = typeof url === "string" ? url : url.url;
          return {
            ...responseFor(requestUrl, new Uint8Array(), Stream.empty),
            status: 204,
            headers: [["Content-Type", "text/plain"]],
          };
        }),
    };

    return runWithSession(
      session,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get("https://fixture.test/no-body");
        expect(yield* response.text).toBe("");
        const result = yield* response.stream.pipe(
          Stream.runDrain,
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason._tag).toBe("EmptyBodyError");
        }
      }),
    );
  });

  it.effect("releases the request scope after the response body closes", () => {
    let releases = 0;
    const session: TlsSession = {
      ...makeSession([]),
      request: (url, _options) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              releases += 1;
            }),
          );
          const requestUrl = typeof url === "string" ? url : url.url;
          return responseFor(requestUrl, new TextEncoder().encode("body"));
        }),
    };

    return runWithSession(
      session,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get("https://fixture.test/scoped");
        expect(releases).toBe(0);
        expect(yield* response.text).toBe("body");
        expect(releases).toBe(1);
      }),
    );
  });

  it.effect("buffers response modes without eager decoding", () =>
    runWithSession(
      makeSession([], new TextEncoder().encode("not-json")),
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client
          .get("https://fixture.test/lazy-json")
          .pipe(
            Effect.provideService(TlsHttpClient.RequestOptions, {
              responseMode: "json",
            }),
          );
        const result = yield* response.json.pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason._tag).toBe("DecodeError");
        }
      }),
    ),
  );

  it.effect("maps malformed response JSON to DecodeError", () => {
    const calls: Array<Call> = [];
    return runWithSession(
      makeSession(calls, new TextEncoder().encode("not-json")),
      Effect.flip(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get("https://fixture.test/invalid");
          yield* response.json;
        }),
      ),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason._tag).toBe("DecodeError");
        }),
      ),
    );
  });

  it.effect("projects bodies and per-request transport options", () => {
    const calls: Array<Call> = [];
    const bytes = new TextEncoder().encode("bytes");
    const form = new FormData();
    form.set("field", "value");

    return runWithSession(
      makeSession(calls),
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        yield* client.post("https://fixture.test/bytes", {
          body: HttpBody.uint8Array(bytes, "application/octet-stream"),
        });
        yield* client.post("https://fixture.test/raw", {
          body: HttpBody.raw("raw", { contentType: "text/plain" }),
        });
        yield* client.post("https://fixture.test/form", {
          body: HttpBody.formData(form),
        });
        yield* client.post("https://fixture.test/stream", {
          body: HttpBody.stream(
            Stream.succeed(bytes),
            "application/octet-stream",
          ),
        });
        yield* client.get("https://fixture.test/options").pipe(
          Effect.provideService(TlsHttpClient.RequestOptions, {
            timeoutMs: 123,
            headerOrder: ["x-first", "x-second"],
            hostOverride: "fixture.test",
            responseMode: "stream",
          }),
        );

        expect(calls).toHaveLength(5);
        expect(calls[0]?.options?.body).toEqual(bytes);
        expect(calls[1]?.options?.body).toBe("raw");
        expect(calls[2]?.options?.body).toBe(form);
        expect(calls[3]?.options?.body).toBeDefined();
        expect(calls[4]?.options).toMatchObject({
          followRedirects: false,
          timeoutMs: 123,
          headerOrder: ["x-first", "x-second"],
          hostOverride: "fixture.test",
        });
      }),
    );
  });

  it.effect("follows redirects in the Effect layer, not in Bridge", () => {
    const calls: Array<Call> = [];
    let count = 0;
    const session = makeSession(calls);
    const redirectingSession: TlsSession = {
      ...session,
      request: (url, options) =>
        Effect.sync(() => {
          const requestUrl = typeof url === "string" ? url : url.url;
          calls.push({ url: requestUrl, options });
          count += 1;
          if (count === 1) {
            return {
              ...responseFor(requestUrl, new Uint8Array()),
              status: 302,
              headers: [["location", "/final"]],
            };
          }
          return responseFor(
            requestUrl,
            new TextEncoder().encode('{"ok":true}'),
          );
        }),
    };

    return runWithSession(
      redirectingSession,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* HttpClient.followRedirects(3)(client).get(
          "https://fixture.test/start",
        );
        expect(response.status).toBe(200);
        expect(calls.map((call) => call.url)).toEqual([
          "https://fixture.test/start",
          "https://fixture.test/final",
        ]);
        expect(
          calls.every((call) => call.options?.followRedirects === false),
        ).toBe(true);
      }),
    );
  });

  it.live("aborts a request while waiting for response headers", () => {
    let interrupted = 0;
    const session: TlsSession = {
      ...makeSession([]),
      request: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted += 1;
            }),
          ),
        ),
    };

    return runWithSession(
      session,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const result = yield* client
          .get("https://fixture.test/hang")
          .pipe(Effect.timeout(Duration.millis(20)), Effect.result);
        expect(result._tag).toBe("Failure");
        expect(interrupted).toBeGreaterThan(0);
      }),
    );
  });

  it.live("closes an interrupted response stream", () => {
    const calls: Array<Call> = [];
    let closes = 0;
    const session = makeSession(calls);
    const streamingSession: TlsSession = {
      ...session,
      request: (url, options) =>
        Effect.sync(() => {
          const requestUrl = typeof url === "string" ? url : url.url;
          calls.push({ url: requestUrl, options });
          return responseFor(
            requestUrl,
            new Uint8Array(),
            Stream.never,
            Effect.sync(() => {
              closes += 1;
            }),
          );
        }),
    };

    return runWithSession(
      streamingSession,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get("https://fixture.test/hang");
        const result = yield* response.stream.pipe(
          Stream.runDrain,
          Effect.timeout(Duration.millis(20)),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        expect(closes).toBeGreaterThan(0);
      }),
    );
  });

  it.effect("maps transport body failures to EncodeError", () => {
    const calls: Array<Call> = [];
    const session = makeSession(calls);
    const failingSession: TlsSession = {
      ...session,
      request: () =>
        Effect.fail(
          TlsRequestError.make({
            kind: "Body",
            message: "upload failed",
            isTransient: false,
          }),
        ),
    };

    return runWithSession(
      failingSession,
      Effect.flip(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          yield* client.post("https://fixture.test/failing", {
            body: HttpBody.stream(Stream.fail("upload failed")),
          });
        }),
      ),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason._tag).toBe("EncodeError");
        }),
      ),
    );
  });
});
