import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { createServer } from "node:http";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
import * as Cookies from "effect/unstable/http/Cookies";
import { TestClock } from "effect/testing";
import type { TlsResponse, TlsSession } from "../src/TlsClient.js";
import { TlsClient } from "../src/index.js";
import * as Browser from "../src/browser/index.js";

const URL = "https://example.test/";
const HTML =
  "<!doctype html><html><head></head><body><script>unreviewed()</script></body></html>";
const response = (
  url = URL,
  status = 403,
  headers: TlsResponse["headers"] = [],
  body = HTML,
  close: Effect.Effect<void> = Effect.void,
): TlsResponse => {
  const bytes = new TextEncoder().encode(body);
  return {
    url,
    status,
    headers,
    protocol: "HTTP/2.0",
    cookies: Cookies.empty,
    bytesRead: Effect.succeed(bytes.length),
    bytesWritten: Effect.succeed(0),
    stream: Stream.succeed(bytes),
    bytes: Effect.succeed(bytes),
    text: Effect.succeed(body),
    json: Effect.succeed({}),
    close,
  };
};
const session = (
  requests: Array<string>,
  respond: (url: string) => TlsResponse,
): TlsSession => ({
  id: "response-hook-test",
  request: (input) =>
    Effect.gen(function* () {
      const url = Predicate.isString(input) ? input : input.url;
      requests.push(url);
      const result = respond(url);
      yield* Effect.addFinalizer(() => result.close);
      return result;
    }),
  webSocket: () => Effect.die("unused"),
  cookies: () => Effect.die("unexpected cookie read"),
  setCookies: () => Effect.die("unexpected cookie write"),
  scriptCookies: () => Effect.die("unexpected script cookie access"),
  exportCookies: Effect.die("unused"),
  importCookies: () => Effect.die("unused"),
  bandwidth: Effect.succeed({ read: 0, written: 0 }),
  resetBandwidth: Effect.void,
  setProxy: () => Effect.void,
});

describe("handler deadline", () => {
  for (const challengeHandlerTimeoutMs of [999, 60_001, 1.5]) {
    it.effect(`rejects timeout ${challengeHandlerTimeoutMs} at open`, () =>
      Effect.gen(function* () {
        const error = yield* Browser.open({
          transport: { profile: "chrome_152_PSK" },
          challengeHandlerTimeoutMs,
        }).pipe(
          Effect.provide(
            Layer.mock(TlsClient, {
              session: () => Effect.die("unexpected transport acquisition"),
            }),
          ),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(Browser.BrowserSessionError);
        expect(error).toHaveProperty("kind", "Config");
      }),
    );
  }

  for (const hook of ["challengeHandler", "responseHandler"] as const) {
    for (const extended of [false, true]) {
      it.effect(
        `${hook} uses ${extended ? "configured" : "default"} deadline`,
        () =>
          Effect.gen(function* () {
            const requests: Array<string> = [];
            let closed = false;
            const original = response(
              URL,
              403,
              hook === "challengeHandler"
                ? [["cf-mitigated", "challenge"]]
                : [],
              HTML,
              Effect.sync(() => {
                closed = true;
              }),
            );
            const started = yield* Deferred.make<void>();
            const handler = () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.sleep("6 seconds")),
                Effect.andThen(Effect.succeedNone),
              );
            const browser = yield* Browser.open(
              extended
                ? {
                    transport: { profile: "chrome_152_PSK" },
                    challengeHandlerTimeoutMs: 8_000,
                  }
                : { transport: { profile: "chrome_152_PSK" } },
              { [hook]: handler },
            ).pipe(
              Effect.provide(
                Layer.mock(TlsClient, {
                  session: () =>
                    Effect.succeed(session(requests, () => original)),
                }),
              ),
            );
            if (extended) {
              const fiber = yield* browser.navigate(URL).pipe(Effect.forkChild);
              yield* Deferred.await(started);
              yield* TestClock.adjust("6 seconds");
              const page = yield* Fiber.join(fiber);
              expect(page.response).toBe(original);
              expect(closed).toBe(false);
            } else {
              const fiber = yield* browser
                .navigate(URL)
                .pipe(Effect.flip, Effect.forkChild);
              yield* Deferred.await(started);
              yield* TestClock.adjust("5 seconds");
              const error = yield* Fiber.join(fiber);
              expect(error).toBeInstanceOf(Browser.BrowserSessionError);
              expect(error).toHaveProperty("kind", "ChallengeLimit");
              expect(error).toHaveProperty(
                "message",
                `${hook === "challengeHandler" ? "challenge" : "response"} handler timed out`,
              );
              expect(closed).toBe(true);
            }
            expect(requests).toEqual([URL]);
          }),
      );
    }
  }
});

describe("final navigation response hook", () => {
  it.effect("omitting the hook is inert for a plain forbidden response", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const original = response();
      const page = yield* Browser.fromSession(
        session(requests, () => original),
        Browser.Chrome152Identity,
        {
          scriptRuntime: {
            evaluate: () => Effect.die("unexpected script execution"),
          },
          challengeHandler: () => Effect.die("unexpected challenge handler"),
        },
      ).navigate(URL);
      expect(page.response).toBe(original);
      expect(page.body).toBe(HTML);
      expect(page.challenge).toBeUndefined();
      expect(requests).toEqual([URL]);
    }),
  );

  it.effect("runs only after Location and HTML redirects settle", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const seen: Array<string> = [];
      const finalUrl = `${URL}final`;
      const original = response(finalUrl);
      const page = yield* Browser.fromSession(
        session(requests, (url) => {
          if (url === URL) return response(url, 302, [["location", "/meta"]]);
          if (url === `${URL}meta`)
            return response(
              url,
              200,
              [],
              '<meta http-equiv="refresh" content="0;url=/final">',
            );
          return original;
        }),
        Browser.Chrome152Identity,
        {
          responseHandler: (received, context) =>
            Effect.sync(() => {
              expect(received).toBe(original);
              expect(context.response).toBe(received);
              expect(context.body).toBe(HTML);
              seen.push(received.url);
              return Option.none();
            }),
        },
      ).navigate(URL);
      expect(page.response).toBe(original);
      expect(page.status).toBe(403);
      expect(seen).toEqual([finalUrl]);
      expect(requests).toEqual([URL, `${URL}meta`, finalUrl]);
    }),
  );

  it.effect(
    "Some retries the same URL once and returns the retried response",
    () =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        let closed = false;
        const first = response(
          URL,
          403,
          [],
          HTML,
          Effect.sync(() => {
            closed = true;
          }),
        );
        const retried = response(URL, 200, [], "cleared");
        const page = yield* Browser.fromSession(
          session(requests, () => {
            if (requests.length === 1) return first;
            expect(closed).toBe(true);
            return retried;
          }),
          Browser.Chrome152Identity,
          {
            responseHandler: () => Effect.succeedSome({}),
          },
        ).navigate(URL);
        expect(requests).toEqual([URL, URL]);
        expect(page.response).toBe(retried);
        expect(page.body).toBe("cleared");
      }),
  );

  it.effect(
    "recognized CF and AWS challenges retain precedence even without a challenge handler",
    () =>
      Effect.gen(function* () {
        for (const headers of [
          [["cf-mitigated", "challenge"]],
          [["x-amzn-waf-action", "challenge"]],
        ] satisfies Array<TlsResponse["headers"]>) {
          for (const enabled of [false, true]) {
            const requests: Array<string> = [];
            let calls = 0;
            const original = response(URL, 403, headers);
            const handlers: Browser.BrowserHandlers = {
              responseHandler: () => Effect.die("unexpected response hook"),
              ...(enabled
                ? {
                    challengeHandler: () =>
                      Effect.sync(() => {
                        calls += 1;
                        return Option.none();
                      }),
                  }
                : {}),
            };
            const page = yield* Browser.fromSession(
              session(requests, () => original),
              Browser.Chrome152Identity,
              handlers,
            ).navigate(URL);
            expect(page.challenge).toBeDefined();
            expect(page.response).toBe(original);
            expect(calls).toBe(enabled ? 1 : 0);
            expect(requests).toEqual([URL]);
          }
        }
      }),
  );

  it.effect(
    "bounds response retries and shares the challenge retry budget",
    () =>
      Effect.gen(function* () {
        for (const challengeOnRetry of [false, true]) {
          const requests: Array<string> = [];
          let calls = 0;
          const page = yield* Browser.fromSession(
            session(requests, () =>
              response(
                URL,
                403,
                challengeOnRetry && requests.length > 1
                  ? [["cf-mitigated", "challenge"]]
                  : [],
              ),
            ),
            Browser.Chrome152Identity,
            {
              responseHandler: () =>
                Effect.sync(() => {
                  calls += 1;
                  return Option.some({});
                }),
              challengeHandler: () =>
                Effect.die("retry budget already exhausted"),
            },
          ).navigate(URL);
          expect(calls).toBe(1);
          expect(requests).toEqual([URL, URL]);
          expect(page.status).toBe(403);
        }
      }),
  );
});

const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const describeIntegration =
  bridgePath === undefined || process.env["TLS_CLIENT_INTEGRATION"] !== "1"
    ? describe.skip
    : describe;
const ExportedCookies = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
);

describeIntegration("response hook Go cookie integration", () => {
  it.effect(
    "evaluateClassic on a plain 403 writes the authoritative Go Jar",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<{
                readonly server: ReturnType<typeof createServer>;
                readonly url: string;
              }>((resolve, reject) => {
                const server = createServer((_request, reply) => {
                  reply.writeHead(403, { "content-type": "text/html" });
                  reply.end(HTML);
                });
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address();
                  if (address === null || Predicate.isString(address)) {
                    reject(new Error("fixture address unavailable"));
                    return;
                  }
                  resolve({ server, url: `http://127.0.0.1:${address.port}/` });
                });
              }),
          ),
          ({ server }) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => server.close(() => resolve())),
            ),
        );
        const platform = Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
          ),
        );
        yield* Effect.gen(function* () {
          const runtime = yield* Browser.BrowserMock;
          let calls = 0;
          const browser = yield* Browser.open(
            { transport: { profile: "chrome_152_PSK" } },
            {
              scriptRuntime: runtime,
              responseHandler: (_response, context) =>
                Effect.gen(function* () {
                  calls += 1;
                  expect(context.response.status).toBe(403);
                  expect(
                    yield* context.evaluateClassic(
                      'document.cookie = "datadome=fixture; Path=/"; "done";',
                      { document: "response" },
                    ),
                  ).toBe("done");
                  return Option.none();
                }),
            },
          );
          const page = yield* browser.navigate(fixture.url);
          expect(page.challenge).toBeUndefined();
          expect(calls).toBe(1);
          const cookies = yield* browser.transport.exportCookies.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ExportedCookies)),
          );
          expect(cookies).toContainEqual({
            name: "datadome",
            value: "fixture",
          });
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              TlsClient.layer.pipe(Layer.provide(platform)),
              Browser.BrowserMock.layer().pipe(Layer.provide(platform)),
            ),
          ),
        );
      }),
  );
});
