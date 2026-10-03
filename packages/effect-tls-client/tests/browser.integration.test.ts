import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import path from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  type Scope,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Browser from "../src/browser/index.js";
import { awsWafChallengeHandler } from "../src/challenges/AwsWaf.js";
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
const exampleExecutables = { bun: "bun", node: "node" };
const browserExampleTestTimeoutMs = 15_000;
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

const startFixture = async (
  _signal?: AbortSignal,
  body = "challenge",
): Promise<{
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
      response.end(body);
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
    if (path === "/script/generated.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(
        `/*${"x".repeat(700 * 1024)}*/ globalThis.generatedAssetResult = "loaded";`,
      );
      return;
    }
    if (path === "/script/aggregate.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(
        `/*${"x".repeat(400 * 1024)}*/ globalThis.aggregateAssetLoaded = true;`,
      );
      return;
    }
    if (path === "/script/oversized.js") {
      response.end("x".repeat(1024 * 1024 + 1));
      return;
    }
    if (path === "/script/oversized-fetch") {
      response.end("x".repeat(64 * 1024 + 1));
      return;
    }
    if (path === "/script/escaped") {
      response.end("\0".repeat(32 * 1024));
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

type AcquisitionMode =
  | "accepted-cookie"
  | "no-cookie"
  | "rejection"
  | "rotating-always-rejected"
  | "constant-always-rejected";

const startAcquisitionFixture = async (
  mode: AcquisitionMode,
): Promise<{
  readonly url: string;
  readonly paths: Array<string>;
  readonly close: () => Promise<void>;
}> => {
  const paths: Array<string> = [];
  let verificationCount = 0;
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? "/", "http://localhost").pathname;
    paths.push(route);
    if (route === "/challenge") {
      const clearanceAccepted =
        mode === "accepted-cookie" &&
        (request.headers.cookie ?? "")
          .split(";")
          .some((cookie) => cookie.trim() === "clearance=approved");
      response.statusCode = clearanceAccepted ? 200 : 202;
      if (!clearanceAccepted) {
        response.setHeader("x-amzn-waf-action", "challenge");
      }
      response.end(clearanceAccepted ? "clearance accepted" : "challenge");
      return;
    }
    if (route === "/acq.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(`
        if (typeof window.pageCfg?.verifyUrl !== "string") {
          throw new Error("pageCfg must be initialized before loading acquisition script");
        }
        window.Acq = Object.freeze({
          start() {
            return new Promise((resolve, reject) => {
              setTimeout(async () => {
                try {
                  const result = await fetch(window.pageCfg.verifyUrl, { method: "POST" });
                  if (result.status < 200 || result.status >= 300) {
                    throw new Error("acquisition rejected");
                  }
                  document.cookie = "acquisition-marker=complete; Path=/";
                  resolve("complete");
                } catch (error) {
                  reject(error);
                }
              }, 25);
            });
          },
        });
      `);
      return;
    }
    if (route === "/verify" && request.method === "POST") {
      verificationCount += 1;
      if (mode === "rejection") {
        response.statusCode = 403;
        response.end("rejected");
        return;
      }
      if (mode === "accepted-cookie") {
        response.setHeader(
          "set-cookie",
          "clearance=approved; Path=/; HttpOnly",
        );
      } else if (mode === "rotating-always-rejected") {
        response.setHeader(
          "set-cookie",
          `clearance=rotation-${verificationCount}; Path=/; HttpOnly`,
        );
      } else if (mode === "constant-always-rejected") {
        response.setHeader(
          "set-cookie",
          "clearance=constant; Path=/; HttpOnly",
        );
      }
      response.end("verified");
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
    throw new Error("acquisition fixture did not expose an address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    close: () => close(server),
  };
};

const browserServices = (url: string) => {
  const platform = Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
    ),
  );
  return Layer.mergeAll(
    TlsClient.layer.pipe(Layer.provide(platform)),
    Browser.BrowserMock.layer({ allowedOrigins: [url] }).pipe(
      Layer.provide(platform),
    ),
  );
};

const acquisitionSource = (url: string, awaitStart = true): string =>
  [
    `window.pageCfg = { verifyUrl: ${JSON.stringify(`${url}/verify`)} };`,
    `await document.loadScript(${JSON.stringify(`${url}/acq.js`)});`,
    awaitStart ? "await window.Acq.start();" : "void window.Acq.start();",
    'return "acquisition complete";',
  ].join("\n");

const withChallengeBrowser = <A, E>(
  fixture: { readonly url: string },
  challengeHandler: Browser.BrowserChallengeHandler,
  use: (browser: Browser.BrowserSession) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E | Browser.BrowserOperationError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* Browser.BrowserMock;
      const browser = yield* Browser.open(
        {
          transport: { profile: "chrome_146", forceHttp1: true },
          identity: Browser.Chrome146Identity,
          maxChallengeRetries: 2,
        },
        { scriptRuntime: runtime, challengeHandler },
      );
      return yield* use(browser);
    }).pipe(Effect.provide(browserServices(fixture.url))),
  );

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

type AwsFixtureBehavior =
  | "success"
  | "asset-404"
  | "rejected"
  | "empty-token"
  | "no-cookie"
  | "always-challenge"
  | "asset-too-large"
  | "reload";

const startAwsWafFixture = async (
  options: {
    readonly behavior?: AwsFixtureBehavior;
    readonly pageAcquisition?: boolean;
    readonly crossOriginAsset?: boolean;
    readonly freezeSdk?: boolean;
  } = {},
): Promise<{
  readonly url: string;
  readonly assetOrigin: string;
  readonly paths: Array<string>;
  readonly assetPaths: Array<string>;
  readonly challengeCookies: Array<string>;
  readonly verifyMethods: Array<string>;
  readonly tokenWrites: Array<string>;
  readonly close: () => Promise<void>;
}> => {
  const behavior = options.behavior ?? "success";
  const paths: Array<string> = [];
  const assetPaths: Array<string> = [];
  const challengeCookies: Array<string> = [];
  const verifyMethods: Array<string> = [];
  const tokenWrites: Array<string> = [];
  let pageUrl = "";
  let assetUrl = "";

  const serveChallengeScript = (response: ServerResponse) => {
    if (behavior === "asset-404") {
      response.statusCode = 404;
      response.end("missing synthetic asset");
      return;
    }
    response.setHeader("content-type", "text/javascript");
    if (behavior === "asset-too-large") {
      response.end("x".repeat(1024 * 1024 + 1));
      return;
    }
    response.end(`
      const syntheticAcquire = (method) => new Promise((resolve, reject) => {
        setTimeout(async () => {
          try {
            const result = await fetch(window.syntheticWafConfig.verifyUrl, {
              method: "POST",
              body: method,
            });
            if (result.status < 200 || result.status >= 300) {
              throw new Error("synthetic acquisition rejected");
            }
            resolve(window.syntheticWafConfig.behavior === "empty-token" ? "" : "synthetic-token");
          } catch (error) {
            reject(error);
          }
        }, 5);
      });
      window.AwsWafIntegration = {
        getToken() { return syntheticAcquire("getToken"); },
        forceRefreshToken() {
          const pending = syntheticAcquire("forceRefreshToken");
          return window.syntheticWafConfig.behavior === "reload"
            ? pending.then(() => window.location.reload())
            : pending;
        },
      };
      ${options.freezeSdk === true ? "Object.freeze(window.AwsWafIntegration);" : ""}
    `);
  };

  const assetServer = options.crossOriginAsset
    ? createServer((request, response) => {
        const route = new URL(request.url ?? "/", "http://localhost").pathname;
        assetPaths.push(route);
        if (route === "/challenge.js") serveChallengeScript(response);
        else {
          response.statusCode = 404;
          response.end();
        }
      })
    : undefined;

  const server = createServer((request, response) => {
    const route = new URL(request.url ?? "/", "http://localhost").pathname;
    paths.push(route);
    if (route === "/challenge") {
      const hasToken = (request.headers.cookie ?? "")
        .split(";")
        .some((cookie) => cookie.trim().startsWith("aws-waf-token="));
      challengeCookies.push(request.headers.cookie ?? "");
      const accepted = hasToken && behavior !== "always-challenge";
      response.statusCode = accepted ? 200 : 202;
      if (!accepted) {
        response.setHeader("x-amzn-waf-action", "challenge");
        response.setHeader("content-type", "text/html");
        const acquisition =
          "if (window.syntheticWafConfig.pageAcquisition) window.AwsWafIntegration.forceRefreshToken();";
        response.end(
          `<!doctype html><script>window.syntheticWafConfig = ${JSON.stringify({
            behavior,
            pageAcquisition: options.pageAcquisition !== false,
            verifyUrl: `${pageUrl}/verify`,
          })};</script><script src="${assetUrl}"></script><script>${acquisition}</script>`,
        );
      } else {
        response.end("synthetic success");
      }
      return;
    }
    if (route === "/challenge.js" && assetServer === undefined) {
      serveChallengeScript(response);
      return;
    }
    if (route === "/verify" && request.method === "POST") {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        verifyMethods.push(Buffer.concat(chunks).toString("utf8"));
        if (behavior === "rejected") {
          response.statusCode = 403;
          response.end("rejected");
          return;
        }
        if (behavior !== "no-cookie") {
          const cookie = `aws-waf-token=synthetic-${verifyMethods.length}; Path=/; HttpOnly`;
          tokenWrites.push(cookie);
          response.setHeader("set-cookie", cookie);
        }
        response.end("verified");
      });
      return;
    }
    if (route === "/ping") {
      response.end("pong");
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  pageUrl = await listenLocal(server);
  const assetOrigin =
    assetServer === undefined ? pageUrl : await listenLocal(assetServer);
  assetUrl = `${assetOrigin}/challenge.js`;
  const servers = assetServer === undefined ? [server] : [server, assetServer];
  return {
    url: pageUrl,
    assetOrigin,
    paths,
    assetPaths,
    challengeCookies,
    verifyMethods,
    tokenWrites,
    close: () => Promise.all(servers.map(close)).then(() => {}),
  };
};

const awsWafHandler = (
  fixture: { readonly assetOrigin: string },
  acquisition?: "page" | "getToken",
) =>
  awsWafChallengeHandler({
    scriptOrigins: [fixture.assetOrigin],
    bootstrap: (page) => {
      expect(page.scripts.map(({ _tag }) => _tag)).toEqual([
        "Inline",
        "External",
        "Inline",
      ]);
      return Effect.succeedSome({
        scripts: page.scripts,
        ...(acquisition === undefined ? {} : { acquisition }),
      });
    },
  });

describeRealIntegration("real BrowserMock integration", () => {
  it.live(
    "opts into the entire original response document without activating markup",
    () =>
      Effect.gen(function* () {
        const body =
          '<!doctype html><html lang="en" id="root"><head id="top" class="metadata"><title>Local &amp; exact</title><meta name="fixture" content="yes"><link href="/never.css" rel="stylesheet"><style id="css">body{}</style><script id="inert" src="/never.js">window.markupRuns = 1; document.cookie = "markup=bad";</script></head><body id="page" class="main"><div id="seed" class="a b">one&amp;<span>two</span></div><a href="/never-link">link</a></body></html>';
        const fixture = yield* Effect.promise(() =>
          startFixture(undefined, body),
        );
        const inspect = `
        const root = document.documentElement, head = document.head, body = document.body;
        if (root !== document.querySelector('html#root') || root.getAttribute('lang') !== 'en') throw new Error('root');
        if (head !== document.querySelector('head.metadata') || head !== document.getElementById('top')) throw new Error('head');
        if (body !== document.querySelector('body.main') || body !== document.getElementById('page')) throw new Error('body');
        if (document.querySelector('title').textContent !== 'Local & exact' || document.querySelector('meta').getAttribute('content') !== 'yes') throw new Error('head data');
        if (document.querySelector('div.a.b') !== document.getElementById('seed') || document.getElementById('seed').textContent !== 'one&two') throw new Error('body data');
        if (document.querySelector('script#inert').getAttribute('src') !== '/never.js' || document.querySelector('link').getAttribute('href') !== '/never.css') throw new Error('inert data');
        if (window.markupRuns !== undefined || document.cookie.includes('markup=bad')) throw new Error('markup activated');
        let rejected = false; try { document.querySelector('*'); } catch(e) { rejected = e instanceof TypeError; } if (!rejected) throw new Error('selector');
        rejected = false; try { root.id = 'changed'; } catch { rejected = true; } if (!rejected) throw new Error('mutable root');
      `;
        yield* withChallengeBrowser(
          fixture,
          (_, context) =>
            Effect.gen(function* () {
              expect(context.body).toBe(body);
              const defaults = `JSON.stringify([document.documentElement === undefined, document.getElementById('root') === null, document.getElementById('seed') === null, window.markupRuns === undefined])`;
              expect(yield* context.evaluateClassic(defaults)).toBe(
                "[true,true,true,true]",
              );
              expect(yield* context.evaluate(`return ${defaults};`)).toBe(
                "[true,true,true,true]",
              );
              // Separate authored classic programs must retain their own lexical source.
              expect(
                yield* context.evaluateClassic(inspect + '\n"classic-one";', {
                  document: "response",
                }),
              ).toBe("classic-one");
              expect(
                yield* context.evaluateClassic(
                  'const authored = document.querySelector("title").textContent; authored;',
                  { document: "response" },
                ),
              ).toBe("Local & exact");
              expect(
                yield* context.evaluate(
                  inspect + '\nawait Promise.resolve(); return "async";',
                  { document: "response" },
                ),
              ).toBe("async");
              expect(
                yield* context.transport.scriptCookies(context.response.url),
              ).toBe("");
              return Option.none();
            }),
          (browser) => browser.navigate(`${fixture.url}/challenge`),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));
        expect(fixture.cookies).toEqual([""]);
      }),
  );

  it.live(
    "carries the exact body and unchanged sources only on explicit opt-in",
    () =>
      Effect.gen(function* () {
        const body =
          '<!doctype html>\n<html id="root"><head id="head"><title>exact &amp; original</title></head><body><div id="body">fixture</div></body></html>\n';
        const fixture = yield* Effect.promise(() =>
          startFixture(undefined, body),
        );
        const calls: Array<{
          readonly source: string;
          readonly context: Browser.BrowserScriptContext | undefined;
        }> = [];
        const evaluate: Browser.BrowserScriptRuntime["evaluate"] = (
          source,
          context,
        ) => {
          calls.push({ source, context });
          return Effect.succeed({ value: "authored", setCookies: [] });
        };
        const runtime: Browser.BrowserScriptRuntime = {
          evaluate,
          evaluateClassic: evaluate,
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const browser = yield* Browser.open(
              { transport: { profile: "chrome_146", forceHttp1: true } },
              {
                scriptRuntime: runtime,
                challengeHandler: (_, context) =>
                  Effect.gen(function* () {
                    for (const runEvaluation of [
                      context.evaluate,
                      context.evaluateClassic,
                    ]) {
                      const source =
                        '/* authored whitespace */\nconst lexical = "local";\nlexical;';
                      yield* runEvaluation(source);
                      yield* runEvaluation(source, { document: "response" });
                      for (const options of [
                        null,
                        1,
                        false,
                        "response",
                        [],
                        {},
                        { html: "response" },
                        { document: "response", unknown: "private" },
                      ]) {
                        const result = yield* Effect.result(
                          // @ts-expect-error exercise invalid JavaScript caller options at the public boundary
                          runEvaluation(source, options),
                        );
                        expect(Result.isFailure(result)).toBe(true);
                        if (!Result.isFailure(result))
                          return yield* Effect.die(
                            "unexpected evaluation success",
                          );
                        const failure = result.failure;
                        expect(failure).toMatchObject({
                          _tag: "BrowserScriptError",
                          reason: "invalid browser evaluation options",
                        });
                        expect(failure).not.toHaveProperty("cause");
                      }
                    }
                    expect(calls).toHaveLength(4);
                    for (const offset of [0, 2]) {
                      const original = calls[offset];
                      const opted = calls[offset + 1];
                      expect(original?.source).toBe(
                        '/* authored whitespace */\nconst lexical = "local";\nlexical;',
                      );
                      expect(opted?.source).toBe(original?.source);
                      expect(original?.context).not.toHaveProperty("document");
                      expect(original?.context).not.toHaveProperty("html");
                      expect(opted?.context).toEqual({
                        ...original?.context,
                        document: body,
                      });
                    }
                    return Option.none();
                  }),
              },
            );
            yield* browser.navigate(`${fixture.url}/challenge`);
          }).pipe(Effect.provide(browserServices(fixture.url))),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));
        expect(fixture.cookies).toEqual([""]);
      }),
  );

  it.live(
    "rejects response-document options and invalid whole bodies before guest spawn",
    () =>
      Effect.gen(function* () {
        let spawns = 0;
        const platform = Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
          ),
        );
        const services = Layer.mergeAll(
          TlsClient.layer.pipe(Layer.provide(platform)),
          Browser.BrowserMock.layer().pipe(
            Layer.provide(
              Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
                spawn: () => {
                  spawns += 1;
                  return Effect.die("unexpected guest spawn");
                },
              }),
            ),
          ),
        );
        const valid = "<!doctype html><html><head></head><body></body></html>";
        for (const body of [
          valid,
          valid.replace("<body>", "<body><template>x</template>"),
          valid + "x",
          valid.replace(
            "<body>",
            '<body><div title="' + "x".repeat(8193) + '"></div>',
          ),
          valid.replace(
            "<body>",
            '<body><div a="' +
              "x".repeat(8192) +
              '" b="' +
              "x".repeat(8192) +
              '" c="x"></div>',
          ),
          valid.replace("<body>", "<body>" + "<div></div>".repeat(30)),
          valid.replace("<body>", "<body>" + "x".repeat(128 * 1024)),
        ]) {
          const fixture = yield* Effect.promise(() =>
            startFixture(undefined, body),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* Browser.BrowserMock;
              const browser = yield* Browser.open(
                { transport: { profile: "chrome_146", forceHttp1: true } },
                {
                  scriptRuntime: runtime,
                  challengeHandler: (_, context) =>
                    Effect.gen(function* () {
                      for (const runEvaluation of [
                        context.evaluate,
                        context.evaluateClassic,
                      ]) {
                        const options =
                          body === valid
                            ? [
                                null,
                                "response",
                                [],
                                { document: "html" },
                                { html: "response" },
                                {
                                  document: "response",
                                  extra: "private-option",
                                },
                                {},
                              ]
                            : [{ document: "response" }];
                        for (const option of options) {
                          const result = yield* Effect.result(
                            runEvaluation(
                              'fetch("/must-not-run"); document.cookie = "guest=bad";',
                              // @ts-expect-error exercise invalid JavaScript caller options
                              option,
                            ),
                          );
                          expect(Result.isFailure(result)).toBe(true);
                          if (!Result.isFailure(result))
                            return yield* Effect.die(
                              "unexpected evaluation success",
                            );
                          const failure = result.failure;
                          expect(failure).toMatchObject({
                            _tag: "BrowserScriptError",
                          });
                          expect(failure).not.toHaveProperty("cause");
                          expect(failure).not.toHaveProperty("options");
                          expect(failure).not.toHaveProperty("document");
                        }
                      }
                      return Option.none();
                    }),
                },
              );
              yield* browser.navigate(`${fixture.url}/challenge`);
            }).pipe(Effect.provide(services)),
          ).pipe(Effect.ensuring(Effect.promise(fixture.close)));
          expect(fixture.cookies).toEqual([""]);
        }
        expect(spawns).toBe(0);
      }),
  );

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
          readonly path: string;
          readonly method: string;
          readonly contentType: string;
          readonly body: Buffer;
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
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const contentType = request.headers["content-type"];
            targetRequests.push({
              authorization: request.headers.authorization ?? "",
              cookie: request.headers.cookie ?? "",
              path: new URL(request.url ?? "/", "http://localhost").pathname,
              method: request.method ?? "",
              contentType: typeof contentType === "string" ? contentType : "",
              body: Buffer.concat(chunks),
            });
            response.setHeader("set-cookie", "cross=must-not-stick; Path=/");
            response.end("target");
          });
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
                      `
                        const before = await fetch("${sourceUrl}/echo").then((r) => r.text());
                        const cross = await fetch("${otherUrl}/echo").then((r) => r.text());
                        const form = new FormData();
                        form.append('naïve "name"\\r\\n', "café\\nline");
                        form.append("duplicate", "first");
                        form.append("duplicate", "second");
                        form.append("cr\\rname", "cr");
                        form.append("lf\\nname", "lf");
                        form.append("binary", new Blob([new Uint8Array([0, 255, 128, 13, 10])], { type: "application/octet-stream" }));
                        const uploaded = await fetch("${otherUrl}/upload", { method: "POST", body: form }).then((r) => r.text());
                        const after = await fetch("${sourceUrl}/echo").then((r) => r.text());
                        const redirected = await fetch("${sourceUrl}/redirect").then((r) => r.text());
                        return [before, cross, uploaded, after, redirected].join("|");
                      `,
                    );
                    expect(value).toBe("source|target|target|source|target");
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
        expect(targetRequests).toHaveLength(3);
        expect(
          targetRequests.map(({ authorization, cookie }) => ({
            authorization,
            cookie,
          })),
        ).toEqual([
          { authorization: "", cookie: "" },
          { authorization: "", cookie: "" },
          { authorization: "", cookie: "" },
        ]);
        const upload = targetRequests[1] ?? null;
        expect(upload).not.toBeNull();
        if (upload === null) return;
        expect(upload).toMatchObject({ path: "/upload", method: "POST" });
        const boundaryMatch = /^multipart\/form-data; boundary=(.+)$/u.exec(
          upload.contentType,
        );
        expect(boundaryMatch).not.toBeNull();
        if (boundaryMatch === null) return;
        const boundary = boundaryMatch[1] ?? null;
        expect(boundary).not.toBeNull();
        if (boundary === null) return;
        expect(boundary).toMatch(/^----BrowserMockFormBoundary[0-9a-f]{32}$/u);
        const expected = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="naïve %22name%22%0D%0A"\r\n\r\ncafé\r\nline\r\n--${boundary}\r\nContent-Disposition: form-data; name="duplicate"\r\n\r\nfirst\r\n--${boundary}\r\nContent-Disposition: form-data; name="duplicate"\r\n\r\nsecond\r\n--${boundary}\r\nContent-Disposition: form-data; name="cr%0D%0Aname"\r\n\r\ncr\r\n--${boundary}\r\nContent-Disposition: form-data; name="lf%0D%0Aname"\r\n\r\nlf\r\n--${boundary}\r\nContent-Disposition: form-data; name="binary"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`,
            "utf8",
          ),
          Buffer.from([0, 255, 128, 13, 10]),
          Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
        ]);
        expect(upload.body).toEqual(expected);
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

  it.live(
    "bounds large script assets, fetch bodies, aggregate data, and escaped IPC",
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
        const value = yield* Effect.scoped(
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
                    const url = (route: string) =>
                      JSON.stringify(`${fixture.url}${route}`);
                    const result = yield* context.evaluate(
                      [
                        `await document.loadScript(${url("/script/generated.js")});`,
                        `const escaped = await fetch(${url("/script/escaped")}).then((response) => response.text());`,
                        `let fetchError = ""; try { await fetch(${url("/script/oversized-fetch")}); } catch (error) { fetchError = error.message; }`,
                        `let assetError = ""; try { await document.loadScript(${url("/script/oversized.js")}); } catch (error) { assetError = error.message; }`,
                        `let aggregateError = ""; try { await document.loadScript(${url("/script/aggregate.js")}); } catch (error) { aggregateError = error.message; }`,
                        `return [window.generatedAssetResult, escaped.length === ${32 * 1024} && escaped.charCodeAt(0) === 0 && escaped.charCodeAt(escaped.length - 1) === 0, fetchError, assetError, aggregateError].join("|");`,
                      ].join("\n"),
                    );
                    expect(result).toBe(
                      [
                        "loaded",
                        "true",
                        "script fetch response exceeds the 64 KiB limit",
                        "script asset exceeds the 1 MiB limit",
                        "script network byte budget exceeded",
                      ].join("|"),
                    );
                    return Option.none();
                  }),
              },
            );
            return yield* browser.navigate(`${fixture.url}/challenge`);
          }).pipe(Effect.provide(services)),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));
        expect(value.status).toBe(202);
        expect(fixture.cookies.slice(1)).toHaveLength(5);
        expect(
          fixture.cookies
            .slice(1)
            .every((cookie) => cookie.includes("read-secret=hidden")),
        ).toBe(true);
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
    browserExampleTestTimeoutMs,
  );

  it.live(
    "awaits reviewed acquisition and retries with Go-authoritative cookies",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          startAcquisitionFixture("accepted-cookie"),
        );
        const result = yield* withChallengeBrowser(
          fixture,
          Browser.reviewedChallengeHandler({
            source: acquisitionSource(fixture.url),
            cookieNames: ["clearance"],
          }),
          (browser) =>
            Effect.gen(function* () {
              const page = yield* browser.navigate(`${fixture.url}/challenge`);
              const cookies = yield* Schema.decodeEffect(ExportedCookies)(
                yield* browser.transport.exportCookies,
              );
              return { page, cookies };
            }),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

        expect(fixture.paths).toEqual([
          "/challenge",
          "/acq.js",
          "/verify",
          "/challenge",
        ]);
        expect(result.page.status).toBe(200);
        expect(result.page.challenge).toBeUndefined();
        expect(result.page.body).toBe("clearance accepted");
        expect(result.cookies).toContainEqual(
          expect.objectContaining({
            name: "clearance",
            value: "approved",
            path: "/",
            httpOnly: true,
          }),
        );
        expect(result.cookies).toContainEqual(
          expect.objectContaining({
            name: "acquisition-marker",
            value: "complete",
            path: "/",
            httpOnly: false,
          }),
        );
      }),
  );

  it.live("does not wait for an unawaited acquisition", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        startAcquisitionFixture("no-cookie"),
      );
      const result = yield* withChallengeBrowser(
        fixture,
        Browser.reviewedChallengeHandler({
          source: acquisitionSource(fixture.url, false),
          cookieNames: ["clearance"],
        }),
        (browser) =>
          Effect.gen(function* () {
            const page = yield* browser.navigate(`${fixture.url}/challenge`);
            const cookies = yield* Schema.decodeEffect(ExportedCookies)(
              yield* browser.transport.exportCookies,
            );
            return { page, cookies };
          }),
      ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

      expect(result.page.status).toBe(202);
      expect(fixture.paths).toEqual(["/challenge", "/acq.js"]);
      expect(result.cookies).not.toContainEqual(
        expect.objectContaining({ name: "clearance" }),
      );
      expect(result.cookies).not.toContainEqual(
        expect.objectContaining({ name: "acquisition-marker" }),
      );
    }),
  );

  it.live(
    "surfaces rejected acquisition as BrowserScriptError without retry",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          startAcquisitionFixture("rejection"),
        );
        const result = yield* withChallengeBrowser(
          fixture,
          Browser.reviewedChallengeHandler({
            source: acquisitionSource(fixture.url),
            cookieNames: ["clearance"],
          }),
          (browser) =>
            Effect.result(browser.navigate(`${fixture.url}/challenge`)),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({ _tag: "BrowserScriptError" });
        }
        expect(fixture.paths).toEqual(["/challenge", "/acq.js", "/verify"]);
      }),
  );

  it.live(
    "rejects acquisition scripts that load before page configuration",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          startAcquisitionFixture("no-cookie"),
        );
        const result = yield* withChallengeBrowser(
          fixture,
          Browser.reviewedChallengeHandler({
            source: `await document.loadScript(${JSON.stringify(`${fixture.url}/acq.js`)});`,
            cookieNames: ["clearance"],
          }),
          (browser) =>
            Effect.result(browser.navigate(`${fixture.url}/challenge`)),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({ _tag: "BrowserScriptError" });
        }
        expect(fixture.paths).toEqual(["/challenge", "/acq.js"]);
      }),
  );

  it.live(
    "leaves the challenge visible when acquisition returns no clearance",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          startAcquisitionFixture("no-cookie"),
        );
        const page = yield* withChallengeBrowser(
          fixture,
          Browser.reviewedChallengeHandler({
            source: acquisitionSource(fixture.url),
            cookieNames: ["clearance"],
          }),
          (browser) => browser.navigate(`${fixture.url}/challenge`),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

        expect(page.status).toBe(202);
        expect(fixture.paths).toEqual(["/challenge", "/acq.js", "/verify"]);
      }),
  );

  it.live(
    "caps rotating clearance retries at the configured challenge limit",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          startAcquisitionFixture("rotating-always-rejected"),
        );
        const page = yield* withChallengeBrowser(
          fixture,
          Browser.reviewedChallengeHandler({
            source: acquisitionSource(fixture.url),
            cookieNames: ["clearance"],
          }),
          (browser) => browser.navigate(`${fixture.url}/challenge`),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

        expect(page.status).toBe(202);
        expect(fixture.paths).toEqual([
          "/challenge",
          "/acq.js",
          "/verify",
          "/challenge",
          "/acq.js",
          "/verify",
          "/challenge",
        ]);
      }),
  );

  it.live("stops retrying when the required clearance is unchanged", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        startAcquisitionFixture("constant-always-rejected"),
      );
      const page = yield* withChallengeBrowser(
        fixture,
        Browser.reviewedChallengeHandler({
          source: acquisitionSource(fixture.url),
          cookieNames: ["clearance"],
        }),
        (browser) => browser.navigate(`${fixture.url}/challenge`),
      ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

      expect(page.status).toBe(202);
      expect(fixture.paths).toEqual([
        "/challenge",
        "/acq.js",
        "/verify",
        "/challenge",
        "/acq.js",
        "/verify",
      ]);
    }),
  );

  it.live(
    "observes page-selected forceRefreshToken and retries with the Go Jar",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => startAwsWafFixture());
        const page = yield* withChallengeBrowser(
          fixture,
          awsWafHandler(fixture),
          (browser) => browser.navigate(`${fixture.url}/challenge`),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

        expect(fixture.paths).toEqual([
          "/challenge",
          "/challenge.js",
          "/verify",
          "/challenge",
        ]);
        expect(fixture.verifyMethods).toEqual(["forceRefreshToken"]);
        expect(fixture.challengeCookies[0]).toBe("");
        expect(fixture.challengeCookies[1]).toContain(
          "aws-waf-token=synthetic-1",
        );
        expect(page.status).toBe(200);
        expect(page.body).toBe("synthetic success");
      }),
  );

  it.live("uses the public getToken method when explicitly selected", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        startAwsWafFixture({ pageAcquisition: false, freezeSdk: true }),
      );
      const page = yield* withChallengeBrowser(
        fixture,
        awsWafHandler(fixture, "getToken"),
        (browser) => browser.navigate(`${fixture.url}/challenge`),
      ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

      expect(fixture.paths).toEqual([
        "/challenge",
        "/challenge.js",
        "/verify",
        "/challenge",
      ]);
      expect(fixture.verifyMethods).toEqual(["getToken"]);
      expect(page.status).toBe(200);
    }),
  );

  const awsFailureCases = [
    {
      name: "a missing external asset",
      behavior: "asset-404",
      pageAcquisition: true,
      freezeSdk: false,
      acquisition: undefined,
      paths: ["/challenge", "/challenge.js"],
      methods: [],
    },
    {
      name: "a rejected page acquisition",
      behavior: "rejected",
      pageAcquisition: true,
      freezeSdk: false,
      acquisition: undefined,
      paths: ["/challenge", "/challenge.js", "/verify"],
      methods: ["forceRefreshToken"],
    },
    {
      name: "an empty public token",
      behavior: "empty-token",
      pageAcquisition: false,
      freezeSdk: false,
      acquisition: "getToken",
      paths: ["/challenge", "/challenge.js", "/verify"],
      methods: ["getToken"],
    },
    {
      name: "a failed location.reload continuation",
      behavior: "reload",
      pageAcquisition: true,
      freezeSdk: false,
      acquisition: undefined,
      paths: ["/challenge", "/challenge.js", "/verify"],
      methods: ["forceRefreshToken"],
    },
    {
      name: "a page with no observed acquisition",
      behavior: "success",
      pageAcquisition: false,
      freezeSdk: false,
      acquisition: undefined,
      paths: ["/challenge", "/challenge.js"],
      methods: [],
    },
  ] as const;

  it.live.each(awsFailureCases)(
    "$name fails visibly as BrowserScriptError without retry",
    (testCase) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          startAwsWafFixture({
            behavior: testCase.behavior,
            freezeSdk: testCase.freezeSdk,
            pageAcquisition: testCase.pageAcquisition,
          }),
        );
        const result = yield* withChallengeBrowser(
          fixture,
          awsWafHandler(fixture, testCase.acquisition),
          (browser) =>
            Effect.result(browser.navigate(`${fixture.url}/challenge`)),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "BrowserScriptError",
          });
        }
        expect(fixture.paths).toEqual(testCase.paths);
        expect(fixture.verifyMethods).toEqual(testCase.methods);
      }),
  );

  it.live("leaves a nonempty getToken result without a cookie visible", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        startAwsWafFixture({
          behavior: "no-cookie",
          pageAcquisition: false,
        }),
      );
      const page = yield* withChallengeBrowser(
        fixture,
        awsWafHandler(fixture, "getToken"),
        (browser) => browser.navigate(`${fixture.url}/challenge`),
      ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

      expect(page.status).toBe(202);
      expect(page.challenge?.kind).toBe("AwsWaf");
      expect(fixture.paths).toEqual(["/challenge", "/challenge.js", "/verify"]);
      expect(fixture.verifyMethods).toEqual(["getToken"]);
      expect(fixture.challengeCookies).toEqual([""]);
      expect(fixture.tokenWrites).toEqual([]);
    }),
  );

  it.live("fails page mode when frozen SDK methods cannot be observed", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        startAwsWafFixture({ freezeSdk: true }),
      );
      const result = yield* withChallengeBrowser(
        fixture,
        awsWafHandler(fixture),
        (browser) =>
          Effect.result(browser.navigate(`${fixture.url}/challenge`)),
      ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "BrowserScriptError",
          reason: expect.stringContaining("cannot be observed"),
        });
      }
      expect(fixture.paths).toEqual(["/challenge", "/challenge.js"]);
      expect(fixture.verifyMethods).toEqual([]);
      expect(fixture.tokenWrites).toEqual([]);
      expect(fixture.challengeCookies).toEqual([""]);
    }),
  );

  it.live(
    "keeps handler origin trust separate from BrowserMock network policy",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          startAwsWafFixture({ crossOriginAsset: true }),
        );
        const result = yield* withChallengeBrowser(
          fixture,
          awsWafHandler(fixture),
          (browser) =>
            Effect.result(browser.navigate(`${fixture.url}/challenge`)),
        ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "BrowserScriptError",
            reason: expect.stringContaining(
              "script network origin is not allowed",
            ),
          });
        }
        expect(fixture.paths).toEqual(["/challenge"]);
        expect(fixture.assetPaths).toEqual([]);
      }),
  );

  it.live("enforces the existing 1 MiB AWS script-asset quota", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        startAwsWafFixture({ behavior: "asset-too-large" }),
      );
      const result = yield* withChallengeBrowser(
        fixture,
        awsWafHandler(fixture),
        (browser) =>
          Effect.result(browser.navigate(`${fixture.url}/challenge`)),
      ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

      expect(result._tag).toBe("Failure");
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserScriptError" },
      });
      if (
        result._tag === "Failure" &&
        result.failure._tag === "BrowserScriptError"
      ) {
        expect(result.failure.reason).toContain(
          "script asset exceeds the 1 MiB limit",
        );
      }
      expect(fixture.paths).toEqual(["/challenge", "/challenge.js"]);
      expect(fixture.verifyMethods).toEqual([]);
    }),
  );

  it.live("caps AWS challenge retries at the configured limit", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        startAwsWafFixture({ behavior: "always-challenge" }),
      );
      const page = yield* withChallengeBrowser(
        fixture,
        awsWafHandler(fixture),
        (browser) => browser.navigate(`${fixture.url}/challenge`),
      ).pipe(Effect.ensuring(Effect.promise(fixture.close)));

      expect(fixture.paths).toEqual([
        "/challenge",
        "/challenge.js",
        "/verify",
        "/challenge",
        "/challenge.js",
        "/verify",
        "/challenge",
      ]);
      expect(fixture.verifyMethods).toEqual([
        "forceRefreshToken",
        "forceRefreshToken",
      ]);
      expect(fixture.challengeCookies).toHaveLength(3);
      expect(fixture.challengeCookies[1]).toContain(
        "aws-waf-token=synthetic-1",
      );
      expect(fixture.challengeCookies[2]).toContain(
        "aws-waf-token=synthetic-2",
      );
      expect(page.status).toBe(202);
    }),
  );
});
