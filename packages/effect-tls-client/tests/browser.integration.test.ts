import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { execFile } from "node:child_process";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import * as Browser from "../src/browser/index.js";
import { TlsClient } from "../src/index.js";

const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const describeRealIntegration =
  bridgePath === undefined || process.env["TLS_CLIENT_INTEGRATION"] !== "1"
    ? describe.skip
    : describe;

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const examplePath = path.resolve(repositoryRoot, "examples/browser.mjs");
const exampleExecutables = { bun: "bun", node: process.execPath };
const execFileAsync = promisify(execFile);
const runExample = (runtime: "node" | "bun", url: string) =>
  Effect.promise(() =>
    execFileAsync(exampleExecutables[runtime], [examplePath], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: Object.assign({}, process.env, {
        TLS_CLIENT_EXAMPLE_PROFILE: "chrome_146",
        TLS_CLIENT_EXAMPLE_URL: url,
      }),
      timeout: 30_000,
    }),
  );

const ExportedCookies = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.String,
      path: Schema.String,
      httpOnly: Schema.Boolean,
    }),
  ),
);

const startFixture = async (): Promise<{
  readonly url: string;
  readonly cookies: Array<string>;
  readonly close: () => Promise<void>;
}> => {
  const cookies: Array<string> = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    cookies.push(request.headers.cookie ?? "");
    if (path === "/challenge" || path.startsWith("/challenge/")) {
      response.statusCode = 202;
      response.setHeader("x-amzn-waf-action", "challenge");
      response.setHeader("set-cookie", [
        "server-secret=hidden; Path=/private; HttpOnly",
        "read-secret=hidden; Path=/; HttpOnly",
      ]);
      response.end("challenge");
      return;
    }
    if (path === "/private/success") {
      const header = request.headers.cookie ?? "";
      const valid =
        header.includes("server-secret=hidden") &&
        header.includes("clearance=ok") &&
        !header.includes("forbidden=no");
      response.statusCode = valid ? 200 : 403;
      response.end(valid ? "ok" : "not-ok");
      return;
    }
    if (path === "/script/redirect-header-count") {
      response.statusCode = 302;
      response.setHeader("location", "/script/xhr");
      response.setHeader(
        "set-cookie",
        Array.from({ length: 65 }, (_, index) => `cookie-${index}=one; Path=/`),
      );
      response.setHeader(
        "set-cookie2",
        Array.from({ length: 65 }, (_, index) => `legacy-${index}=one; Path=/`),
      );
      response.end();
      return;
    }
    if (path === "/script/cookie-header-bytes") {
      response.setHeader(
        "set-cookie",
        `quota=${"x".repeat(64 * 1024)}; Path=/`,
      );
      response.end("ignored");
      return;
    }
    if (path === "/script.js") {
      response.setHeader("content-type", "text/javascript");
      response.end('globalThis.scriptLoaded = "loaded";');
      return;
    }
    if (path === "/script/fetch") {
      response.setHeader(
        "set-cookie",
        "bridge-cookie=network; Path=/; HttpOnly",
      );
      response.end("fetched");
      return;
    }
    if (path === "/script/xhr") {
      response.end("xhr-response");
      return;
    }
    if (path === "/private/script-success") {
      const header = request.headers.cookie ?? "";
      const valid =
        header.includes("server-secret=hidden") &&
        header.includes("bridge-cookie=network");
      response.statusCode = valid ? 200 : 403;
      response.end(valid ? "script-ok" : "script-not-ok");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("browser fixture did not expose an address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    cookies,
    close: () => close(server),
  };
};

const listenLocal = (server: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("local fixture did not expose an address"));
      } else {
        resolve(`http://127.0.0.1:${address.port}`);
      }
    });
  });

describeRealIntegration("real BrowserMock integration", () => {
  it.live(
    "sends session credentials only to the page origin, including redirects",
    () =>
      Effect.gen(function* () {
        const sourceRequests: Array<{
          readonly path: string;
          readonly authorization: string;
          readonly cookie: string;
        }> = [];
        const targetRequests: Array<{
          readonly authorization: string;
          readonly cookie: string;
        }> = [];
        let targetUrl = "";
        const source = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://localhost");
          sourceRequests.push({
            path: url.pathname,
            authorization: request.headers.authorization ?? "",
            cookie: request.headers.cookie ?? "",
          });
          if (url.pathname === "/challenge") {
            response.statusCode = 202;
            response.setHeader("x-amzn-waf-action", "challenge");
            response.setHeader("set-cookie", "page=fixture; Path=/");
            response.end("challenge");
          } else if (url.pathname === "/redirect") {
            response.statusCode = 302;
            response.setHeader("location", `${targetUrl}/echo`);
            response.end();
          } else {
            response.end("source");
          }
        });
        const target = createServer((request, response) => {
          targetRequests.push({
            authorization: request.headers.authorization ?? "",
            cookie: request.headers.cookie ?? "",
          });
          response.setHeader("set-cookie", "cross=must-not-stick; Path=/");
          response.end("target");
        });
        const servers = [source, target];
        const [sourceUrl, otherUrl] = yield* Effect.promise(async () =>
          Promise.all([listenLocal(source), listenLocal(target)]),
        );
        targetUrl = otherUrl;
        const platform = Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
          ),
        );
        const services = Layer.mergeAll(
          TlsClient.layer.pipe(Layer.provide(platform)),
          Browser.BrowserMock.layer({
            allowedOrigins: [sourceUrl, otherUrl],
          }).pipe(Layer.provide(platform)),
        );
        const identity = {
          ...Browser.Chrome146Identity,
          headers: [
            ...Browser.Chrome146Identity.headers,
            ["authorization", "Bearer fixture"] as const,
          ],
        };
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* Browser.BrowserMock;
            const browser = yield* Browser.open(
              {
                transport: { profile: "chrome_146", forceHttp1: true },
                identity,
              },
              {
                scriptRuntime: runtime,
                challengeHandler: (_challenge, context) =>
                  Effect.gen(function* () {
                    const value = yield* context.evaluate(
                      `const before = await fetch("${sourceUrl}/echo").then((r) => r.text()); const cross = await fetch("${otherUrl}/echo").then((r) => r.text()); const after = await fetch("${sourceUrl}/echo").then((r) => r.text()); const redirected = await fetch("${sourceUrl}/redirect").then((r) => r.text()); return [before, cross, after, redirected].join("|");`,
                    );
                    expect(value).toBe("source|target|source|target");
                    return Option.none();
                  }),
              },
            );
            return yield* browser.navigate(`${sourceUrl}/challenge`);
          }).pipe(Effect.provide(services)),
        ).pipe(
          Effect.ensuring(
            Effect.promise(() =>
              Promise.all(servers.map((server) => close(server))).then(
                () => {},
              ),
            ),
          ),
        );
        expect(result.status).toBe(202);
        const sameOrigin = sourceRequests.filter(
          ({ path }) => path === "/echo",
        );
        expect(sameOrigin).toHaveLength(2);
        expect(sameOrigin[0]).toMatchObject({
          authorization: "Bearer fixture",
          cookie: "page=fixture",
        });
        expect(sameOrigin[1]).toMatchObject({
          authorization: "Bearer fixture",
          cookie: "page=fixture",
        });
        expect(targetRequests).toHaveLength(2);
        expect(targetRequests).toEqual([
          { authorization: "", cookie: "" },
          { authorization: "", cookie: "" },
        ]);
      }),
  );

  it.live("enforces raw response header quotas on redirects and cookies", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(startFixture);
      const platform = Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
        ),
      );
      const services = Layer.mergeAll(
        TlsClient.layer.pipe(Layer.provide(platform)),
        Browser.BrowserMock.layer({ allowedOrigins: [fixture.url] }).pipe(
          Layer.provide(platform),
        ),
      );
      const pages = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Browser.BrowserMock;
          const browser = yield* Browser.open(
            {
              transport: { profile: "chrome_146", forceHttp1: true },
              identity: Browser.Chrome146Identity,
            },
            {
              scriptRuntime: runtime,
              challengeHandler: (challenge, context) =>
                Effect.gen(function* () {
                  const countLimit = challenge.url.endsWith("/header-count");
                  const requestPath = countLimit
                    ? "/script/redirect-header-count"
                    : "/script/cookie-header-bytes";
                  const expectedReason = countLimit
                    ? "script response exceeds the header-count limit"
                    : "script response headers exceed the 64 KiB limit";
                  const evaluation = yield* Effect.result(
                    context.evaluate(
                      `await fetch("${fixture.url}${requestPath}"); return "unexpected";`,
                    ),
                  );
                  if (evaluation._tag === "Failure") {
                    expect(evaluation.failure).toMatchObject({
                      _tag: "BrowserScriptError",
                      reason: expectedReason,
                    });
                  } else {
                    expect.fail("script request unexpectedly succeeded");
                  }
                  return Option.none();
                }),
            },
          );
          return yield* Effect.forEach(
            ["/challenge/header-count", "/challenge/header-bytes"] as const,
            (route) => browser.navigate(`${fixture.url}${route}`),
            { concurrency: 1 },
          );
        }).pipe(Effect.provide(services)),
      ).pipe(Effect.ensuring(Effect.promise(fixture.close)));
      expect(pages.map(({ status }) => status)).toEqual([202, 202]);
    }),
  );

  it.live(
    "bridges script loading, fetch, XHR, and Go-authoritative cookies through one session",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(startFixture);
        const platform = Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
          ),
        );
        const services = Layer.mergeAll(
          TlsClient.layer.pipe(Layer.provide(platform)),
          Browser.BrowserMock.layer({ allowedOrigins: [fixture.url] }).pipe(
            Layer.provide(platform),
          ),
        );
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* Browser.BrowserMock;
            const browser = yield* Browser.open(
              {
                transport: { profile: "chrome_146", forceHttp1: true },
                identity: Browser.Chrome146Identity,
              },
              {
                scriptRuntime: runtime,
                challengeHandler: (_challenge, context) =>
                  Effect.gen(function* () {
                    const value = yield* context.evaluate(
                      `await document.loadScript("${fixture.url}/script.js");\nconst fetched = await fetch("${fixture.url}/script/fetch").then((response) => response.text());\nconst xhr = new XMLHttpRequest();\nconst xhrValue = await new Promise((resolve, reject) => { xhr.onload = () => resolve(xhr.status + ":" + xhr.responseText); xhr.onerror = () => reject(new Error("xhr failed")); xhr.open("GET", "${fixture.url}/script/xhr"); xhr.send(); });\nreturn [window.scriptLoaded, fetched, xhrValue, document.cookie].join("|");`,
                    );
                    expect(value).toBe("loaded|fetched|200:xhr-response|");
                    return Option.some({
                      url: `${fixture.url}/private/script-success`,
                    });
                  }),
              },
            );
            return yield* browser.navigate(`${fixture.url}/challenge`);
          }).pipe(Effect.provide(services)),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));
        expect(result.status).toBe(200);
        expect(result.body).toBe("script-ok");
        expect(fixture.cookies[4]).toContain("bridge-cookie=network");
      }),
  );

  it.live("synchronizes accepted and rejected script cookies through Go", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(startFixture);
      const platform = Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
        ),
      );
      const services = Layer.mergeAll(
        TlsClient.layer.pipe(Layer.provide(platform)),
        Browser.BrowserMock.layer({ allowedOrigins: [fixture.url] }).pipe(
          Layer.provide(platform),
        ),
      );
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Browser.BrowserMock;
          const browser = yield* Browser.open(
            {
              transport: { profile: "chrome_146", forceHttp1: true },
              identity: Browser.Chrome146Identity,
            },
            {
              scriptRuntime: runtime,
              challengeHandler: (_challenge, context) =>
                Effect.gen(function* () {
                  const value = yield* context.evaluate(
                    `if (document.cookie.includes("read-secret")) return "leaked"; document.cookie = "server-secret=overwritten; Path=/private"; document.cookie = "server-secret=allowed; Path=/"; document.cookie = "clearance=ok; Path=/"; document.cookie = "forbidden=no; HttpOnly; Path=/"; document.cookie = "rejected=no; Domain=other.test; Path=/"; await fetch("${fixture.url}/script/xhr"); return document.cookie.includes("rejected=") ? "rejected-cookie-visible" : "ready";`,
                  );
                  expect(value).toBe("ready");
                  return Option.some({
                    url: `${fixture.url}/private/success`,
                  });
                }),
            },
          );
          const page = yield* browser.navigate(`${fixture.url}/challenge`);
          const cookies = yield* Schema.decodeEffect(ExportedCookies)(
            yield* browser.transport.exportCookies,
          );
          return { page, cookies };
        }).pipe(Effect.provide(services)),
      ).pipe(Effect.ensuring(Effect.promise(fixture.close)));
      expect(result.page.status).toBe(200);
      expect(result.page.body).toBe("ok");
      expect(result.cookies).toContainEqual(
        expect.objectContaining({
          name: "server-secret",
          value: "hidden",
          path: "/private",
          httpOnly: true,
        }),
      );
      expect(result.cookies).toContainEqual(
        expect.objectContaining({
          name: "server-secret",
          value: "allowed",
          path: "/",
          httpOnly: false,
        }),
      );
      expect(result.cookies).not.toContainEqual(
        expect.objectContaining({ name: "forbidden" }),
      );
      expect(result.cookies).not.toContainEqual(
        expect.objectContaining({ name: "rejected" }),
      );
      expect(fixture.cookies).toHaveLength(3);
      expect(fixture.cookies[1]).not.toContain("server-secret=hidden");
      expect(fixture.cookies[2]).toContain("server-secret=hidden");
      expect(fixture.cookies[1]).not.toContain("server-secret=overwritten");
      expect(fixture.cookies[1]).toContain("clearance=ok");
      expect(fixture.cookies[2]).toContain("server-secret=allowed");
      expect(fixture.cookies[2]).not.toContain("rejected=no");
    }),
  );

  it.live(
    "runs the browser example with Node and Bun against the local fixture",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(startFixture);
        yield* Effect.forEach(
          ["node", "bun"] as const,
          (runtime) =>
            runExample(runtime, `${fixture.url}/challenge`).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  expect(result.stdout).toContain(`${fixture.url}/challenge`);
                  expect(result.stdout).toContain("Challenge: AwsWaf");
                }),
              ),
            ),
          { concurrency: 1, discard: true },
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));
      }),
  );
});
