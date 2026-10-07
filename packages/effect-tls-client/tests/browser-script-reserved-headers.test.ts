import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import * as Browser from "../src/browser/index.js";
import { TlsClient } from "../src/index.js";

const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const describeIntegration =
  bridgePath !== undefined && process.env["TLS_CLIENT_INTEGRATION"] === "1"
    ? describe
    : describe.skip;
const reserved = [
  "sEc-Ch-Ua",
  "SEC-CH-UA-Mobile",
  "Sec-CH-UA-Platform",
  "sEc-FeTcH-SiTe",
  "SEC-FETCH-MODE",
  "Sec-Fetch-Dest",
  "sEc-FeTcH-UsEr",
  "sEc-Authored",
  "pRoXy-Authored",
  "PROXY-Authorization",
  "Proxy-Connection",
];
const headers = [
  ...reserved.map((name) => [name, "forged"]),
  ["Accept-Language", "de-DE,de;q=0.8"],
  ["X-Authored", "legal value"],
  ["Content-Type", "text/plain"],
];
const source = `
  const entries = ${JSON.stringify(headers)};
  const reserved = ${JSON.stringify(reserved)};
  const standalone = new Headers(entries);
  standalone.set("Sec-Authored", "standalone");
  standalone.append("Proxy-Authored", "standalone");
  if (standalone.get("sec-authored") !== "standalone" ||
      standalone.get("proxy-authored") !== "forged, standalone") throw new Error("standalone Headers changed");
  for (const [index, input] of [Object.fromEntries(entries), entries, standalone].entries()) {
    await fetch("/fetch-" + index, { method: "POST", headers: input, body: "fetch body " + index });
  }
  const request = new Request("/request", { method: "POST", headers: standalone, body: "request body" });
  request.headers.set("sEc-Ch-Ua", "mutated");
  request.headers.append("pRoXy-Authored", "mutated");
  if (reserved.some(name => request.headers.has(name))) throw new Error("Request retained reserved header");
  request.headers.set("X-Authored", "request value");
  const clone = request.clone();
  clone.headers.set("SEC-FETCH-MODE", "mutated clone");
  clone.headers.append("PROXY-Authored", "mutated clone");
  if (reserved.some(name => clone.headers.has(name))) throw new Error("clone lost request guard");
  await fetch(clone);
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/xhr");
    for (const [name, value] of entries) xhr.setRequestHeader(name, value);
    xhr.onload = resolve;
    xhr.onerror = () => reject(new Error("XHR failed"));
    xhr.send("xhr body");
  });
  return "finished";
`;

const fixture = Effect.fn("ReservedHeaders.fixture")(function* () {
  const hits: Array<{
    path: string;
    headers: IncomingHttpHeaders;
    body: string;
  }> = [];
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "/";
      hits.push({
        path,
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (path === "/page")
        response.writeHead(202, { "x-amzn-waf-action": "challenge" });
      response.end("authored local fixture");
    });
  });
  yield* Effect.acquireRelease(Effect.succeed(server), (server) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  const url = yield* Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string")
            reject(
              new Browser.BrowserScriptError({
                reason: "fixture address missing",
              }),
            );
          else resolve(`http://127.0.0.1:${address.port}`);
        });
      }),
    catch: (cause) =>
      new Browser.BrowserScriptError({
        reason: "fixture listen failed",
        cause,
      }),
  });
  return { url, hits };
});
const platform = Layer.mergeAll(
  NodeServices.layer,
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
  ),
);
const services = (url: string) =>
  Layer.mergeAll(
    TlsClient.layer.pipe(Layer.provide(platform)),
    Browser.BrowserMock.layer({ allowedOrigins: [url] }).pipe(
      Layer.provide(platform),
    ),
  );

// Authored local programs only; these fixtures do not measure provider clearance.
describeIntegration(
  "reserved guest request headers through the Go Bridge",
  () => {
    it.live(
      "silently suppresses reserved Fetch/XHR assignments without changing standalone Headers, legal values or bodies",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { url, hits } = yield* fixture();
            let completion = "";
            yield* Effect.gen(function* () {
              const scriptRuntime = yield* Browser.BrowserMock;
              const browser = yield* Browser.open(
                { transport: { profile: "chrome_152", forceHttp1: true } },
                {
                  scriptRuntime,
                  challengeHandler: (_, context) =>
                    Effect.gen(function* () {
                      completion = yield* context.evaluate(source);
                      return Option.none();
                    }),
                },
              );
              yield* browser.navigate(`${url}/page`);
            }).pipe(Effect.provide(services(url)));
            expect(completion).toBe("finished");
            expect(hits.map((hit) => hit.path)).toEqual([
              "/page",
              "/fetch-0",
              "/fetch-1",
              "/fetch-2",
              "/request",
              "/xhr",
            ]);
            expect(hits.slice(1).map((hit) => hit.body)).toEqual([
              "fetch body 0",
              "fetch body 1",
              "fetch body 2",
              "request body",
              "xhr body",
            ]);
            for (const hit of hits.slice(1)) {
              expect(hit.headers["sec-ch-ua"]).toBe(
                Browser.Chrome152Identity.headers.find(
                  ([name]) => name === "sec-ch-ua",
                )?.[1],
              );
              expect(hit.headers["sec-ch-ua-mobile"]).toBe("?0");
              expect(hit.headers["sec-ch-ua-platform"]).toBe('"macOS"');
              expect(hit.headers["sec-fetch-site"]).toBe("same-origin");
              expect(hit.headers["sec-fetch-mode"]).toBe("cors");
              expect(hit.headers["sec-fetch-dest"]).toBe("empty");
              for (const name of [
                "sec-fetch-user",
                "sec-authored",
                "proxy-authored",
                "proxy-authorization",
                "proxy-connection",
              ])
                expect(hit.headers[name]).toBeUndefined();
              expect(hit.headers["accept-language"]).toBe("de-DE,de;q=0.8");
              expect(hit.headers["x-authored"]).toBe(
                hit.path === "/request" ? "request value" : "legal value",
              );
              expect(hit.headers["content-type"]).toBe("text/plain");
            }
          }),
        ),
    );

    it.live(
      "rejects every forged reserved native-host header before sending, even when a custom runtime bypasses the runner",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { url, hits } = yield* fixture();
            let rejected = 0;
            const runtime: Browser.BrowserScriptRuntime = {
              allowedOrigins: [url],
              maxNetworkRequests: 16,
              evaluate: Effect.fn("ReservedHeaders.forgedRuntime")(
                function* (_source, _context, host) {
                  if (host === undefined)
                    return yield* new Browser.BrowserScriptError({
                      reason: "fixture host missing",
                    });
                  for (const name of reserved) {
                    const result = yield* host
                      .request({
                        kind: "fetch",
                        url: `${url}/forged`,
                        method: "POST",
                        headers: [[name, "forged"]],
                        body: "retained body",
                        bodyBytes: null,
                      })
                      .pipe(Effect.result);
                    expect(result._tag).toBe("Failure");
                    if (result._tag === "Failure") {
                      expect(result.failure).toBeInstanceOf(
                        Browser.BrowserScriptError,
                      );
                      expect(result.failure.reason).toBe(
                        `script cannot set the ${name.toLowerCase()} header`,
                      );
                    }
                    rejected++;
                  }
                  return { value: "denied", setCookies: [] };
                },
              ),
            };
            const browser = yield* Browser.open(
              { transport: { profile: "chrome_152", forceHttp1: true } },
              {
                scriptRuntime: runtime,
                challengeHandler: (_, context) =>
                  context
                    .evaluate("authored bypass")
                    .pipe(Effect.as(Option.none())),
              },
            );
            yield* browser.navigate(`${url}/page`);
            expect(rejected).toBe(reserved.length);
            expect(hits.map((hit) => hit.path)).toEqual(["/page"]);
            expect(hits.filter((hit) => hit.path === "/forged")).toHaveLength(
              0,
            );
          }).pipe(
            Effect.provide(TlsClient.layer.pipe(Layer.provide(platform))),
          ),
        ),
    );

    it.live(
      "preserves trusted identity, navigation and retry header configuration",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { url, hits } = yield* fixture();
            const identity = Browser.BrowserIdentity.make({
              headers: [
                ...Browser.Chrome152Identity.headers.filter(
                  ([name]) =>
                    name !== "sec-ch-ua" && name !== "accept-language",
                ),
                ["Sec-CH-UA", '"Caller";v="152"'],
                ["Accept-Language", "es-ES"],
                ["Proxy-Authored", "trusted identity"],
              ],
            });
            const browser = yield* Browser.open(
              {
                transport: { profile: "chrome_152", forceHttp1: true },
                identity,
              },
              {
                challengeHandler: () =>
                  Effect.succeedSome({
                    headers: [
                      ["Sec-CH-UA", "trusted retry"],
                      ["Proxy-Authored", "trusted retry"],
                      ["Accept-Language", "it-IT"],
                    ],
                  }),
              },
            );
            yield* browser.navigate(`${url}/page`, {
              headers: [
                ["sEc-CH-UA", "trusted navigation"],
                ["pRoXy-Authored", "trusted navigation"],
                ["Accept-Language", "de-DE"],
              ],
            });
            const pageHeaders = hits.map((hit) => hit.headers);
            expect(pageHeaders).toHaveLength(2);
            expect(pageHeaders[0]?.["sec-ch-ua"]).toBe("trusted navigation");
            expect(pageHeaders[0]?.["proxy-authored"]).toBe(
              "trusted navigation",
            );
            expect(pageHeaders[0]?.["accept-language"]).toBe("de-DE");
            expect(pageHeaders[1]?.["sec-ch-ua"]).toBe("trusted retry");
            expect(pageHeaders[1]?.["proxy-authored"]).toBe("trusted retry");
            expect(pageHeaders[1]?.["accept-language"]).toBe("it-IT");
            const response = yield* browser.get(`${url}/trusted`);
            yield* response.text;
            expect(hits[2]?.headers["sec-ch-ua"]).toBe('"Caller";v="152"');
            expect(hits[2]?.headers["proxy-authored"]).toBe("trusted identity");
            expect(hits[2]?.headers["accept-language"]).toBe("es-ES");
            expect(Schema.is(Browser.BrowserIdentity)(identity)).toBe(true);
          }).pipe(
            Effect.provide(TlsClient.layer.pipe(Layer.provide(platform))),
          ),
        ),
    );
  },
);
