import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { createServer } from "node:http";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import * as Browser from "../src/browser/index.js";
import {
  AllowedRequestKinds,
  resolveAllowedUrl,
} from "../src/browser/ScriptPolicy.js";
import { TlsClient } from "../src/index.js";

const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const describeIntegration =
  bridgePath !== undefined && process.env["TLS_CLIENT_INTEGRATION"] === "1"
    ? describe
    : describe.skip;
const origin = "https://ct.captcha-delivery.com";
const kinds = ["fetch", "script", "frame"] as const;

describe("script request-kind policy", () => {
  it("restricts kinds independently of origin and path grants", () => {
    for (const kind of kinds) {
      const resolve = (policy?: AllowedRequestKinds, origins = [origin]) =>
        resolveAllowedUrl(
          "/sdk.js",
          `${origin}/page`,
          origins,
          undefined,
          kind,
          policy,
        );
      expect(resolve().pathname).toBe("/sdk.js");
      expect(resolve({}).pathname).toBe("/sdk.js");
      expect(resolve({ "https://other.test": [] }).pathname).toBe("/sdk.js");
      expect(() => resolve({ [origin]: [] })).toThrow();
      expect(() => resolve({ [origin]: [kind] }, [])).toThrow();
      if (kind === "script")
        expect(resolve({ [origin]: ["script"] }).pathname).toBe("/sdk.js");
      else expect(() => resolve({ [origin]: ["script"] })).toThrow();
      expect(() =>
        resolveAllowedUrl(
          "/denied",
          `${origin}/page`,
          [origin],
          { [origin]: ["/trusted/"] },
          kind,
          { [origin]: [kind] },
        ),
      ).toThrow();
      expect(() =>
        resolveAllowedUrl(
          "/trusted/../trusted/sdk.js",
          `${origin}/page`,
          [origin],
          { [origin]: ["/trusted/"] },
          kind,
          { [origin]: [kind] },
        ),
      ).toThrow();
    }
  });

  it("validates canonical origin keys, exact enums and bounded records/arrays", () => {
    for (const key of [
      "https://ct.captcha-delivery.com/",
      "https://CT.captcha-delivery.com",
      "https://ct.captcha-delivery.com/path",
      "https://user@ct.captcha-delivery.com",
      "http://remote.test",
      "bad",
    ])
      expect(() =>
        Schema.decodeSync(AllowedRequestKinds)({ [key]: ["script"] }),
      ).toThrow();
    for (const value of [
      null,
      "script",
      ["xhr"],
      ["Script"],
      ["script", "script", "script", "script"],
    ])
      expect(() =>
        Schema.decodeUnknownSync(AllowedRequestKinds)({ [origin]: value }),
      ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AllowedRequestKinds)(
        Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [
            `https://fixture${index}.test`,
            ["script"],
          ]),
        ),
      ),
    ).toThrow();
    expect(Schema.decodeSync(AllowedRequestKinds)({ [origin]: [] })).toEqual({
      [origin]: [],
    });
  });

  it("does not inherit a grant or grant origins through a role map", () => {
    const inherited: AllowedRequestKinds = Object.create({
      [origin]: ["script"],
    });
    expect(Schema.decodeSync(AllowedRequestKinds)(inherited)).toEqual({});
    expect(() =>
      resolveAllowedUrl(
        "/sdk.js",
        `${origin}/page`,
        [],
        undefined,
        "script",
        inherited,
      ),
    ).toThrow();
    const denied: AllowedRequestKinds = Object.assign(
      Object.create({ [origin]: ["script"] }),
      { [origin]: [] },
    );
    expect(() =>
      resolveAllowedUrl(
        "/sdk.js",
        `${origin}/page`,
        [origin],
        undefined,
        "script",
        denied,
      ),
    ).toThrow();
  });

  it.live("rejects malformed BrowserMock options", () =>
    Effect.gen(function* () {
      const result = yield* Effect.service(Browser.BrowserMock).pipe(
        Effect.provide(
          Browser.BrowserMock.layer({
            allowedRequestKinds: { [`${origin}/`]: ["script"] },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.live(
    "denies native fetch/XHR/frame before custom host dispatch, but permits script loads",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Browser.BrowserMock;
        const calls: Array<string> = [];
        const result = yield* runtime.evaluate(
          `
        try { await fetch("/sdk.js", { kind: "script", purpose: "script" }); } catch {}
        await new Promise(resolve => { const xhr = new XMLHttpRequest(); xhr.open("GET", "/sdk.js"); xhr.onload = resolve; xhr.onerror = resolve; xhr.send(); });
        await new Promise(resolve => { const frame = document.createElement("iframe"); frame.src = "/sdk.js"; frame.onload = resolve; frame.onerror = resolve; document.body.appendChild(frame); });
        await document.loadScript("/sdk.js");
        await new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = "/sdk.js"; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
        return "finished";
      `,
          { url: `${origin}/page`, cookie: "", userAgent: "fixture" },
          {
            request: (request) => {
              calls.push(request.kind);
              return Effect.succeed({
                status: 200,
                url: request.url,
                headers: [],
                body: "window.localFixture = true;",
                cookie: "",
              });
            },
            loadFrame: () => {
              calls.push("frame");
              return Effect.fail(
                new Browser.BrowserScriptError({ reason: "must not dispatch" }),
              );
            },
            setCookie: () => Effect.succeed(""),
          },
        );
        expect(result.value).toBe("finished");
        expect(calls).toEqual(["script", "script"]);
      }).pipe(
        Effect.provide(
          Browser.BrowserMock.layer({
            allowedOrigins: [origin],
            allowedRequestKinds: { [origin]: ["script"] },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
  );
  it.live(
    "permits original static document script dispatch at a script-only origin",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Browser.BrowserMock;
        const calls: Array<string> = [];
        yield* Browser.runBoundedScript(
          runtime,
          "",
          {
            url: "https://page.test/",
            cookie: "",
            userAgent: "fixture",
            document: `<html><head><script src="${origin}/sdk.js"></script></head><body></body></html>`,
          },
          {
            request: (request) => {
              calls.push(`${request.kind}:${request.url}`);
              return Effect.succeed({
                status: 200,
                url: request.url,
                headers: [],
                body: "window.localFixture = true;",
                cookie: "",
              });
            },
            setCookie: () => Effect.succeed(""),
          },
          "document",
        );
        expect(calls).toEqual([`script:${origin}/sdk.js`]);
      }).pipe(
        Effect.provide(
          Browser.BrowserMock.layer({
            allowedOrigins: [origin],
            allowedRequestKinds: { [origin]: ["script"] },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
  );
});

const fixture = Effect.fnUntraced(function* (destination?: string) {
  const paths: Array<string> = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    paths.push(path);
    if (path === "/page") {
      response.writeHead(202, { "x-amzn-waf-action": "challenge" });
      response.end("local request-kind fixture");
    } else if (path === "/redirect") {
      response.writeHead(302, { location: `${destination}/sdk.js` });
      response.end();
    } else response.end("window.localFixture = true;");
  });
  const url = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<string>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string")
              reject(new Error("fixture address missing"));
            else resolve(`http://127.0.0.1:${address.port}`);
          });
        }),
    ),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
  );
  return { url, paths };
});
const platform = Layer.mergeAll(
  NodeServices.layer,
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
  ),
);

const operation = (kind: "fetch" | "xhr" | "script" | "frame", url: string) => {
  const input = JSON.stringify(url);
  if (kind === "fetch")
    return `await fetch(${input}, { kind: "script", purpose: "script" })`;
  if (kind === "script") return `await document.loadScript(${input})`;
  if (kind === "xhr")
    return `await new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open("GET", ${input}); xhr.onload = resolve; xhr.onerror = reject; xhr.send(); })`;
  return `await new Promise((resolve, reject) => { const frame = document.createElement("iframe"); frame.src = ${input}; frame.onload = resolve; frame.onerror = reject; document.body.appendChild(frame); })`;
};

const navigate = Effect.fnUntraced(function* (
  url: string,
  source: string,
  policy?: AllowedRequestKinds,
) {
  const runtime = yield* Browser.BrowserMock;
  let completion = "";
  let reviews = 0;
  const browser = yield* Browser.open(
    {
      transport: { profile: "chrome_146", forceHttp1: true },
      identity: Browser.Chrome146Identity,
    },
    {
      scriptRuntime: {
        ...runtime,
        ...(policy === undefined ? {} : { allowedRequestKinds: policy }),
      },
      frameReviewer: () => {
        reviews += 1;
        return Effect.succeedSome({ scripts: [] });
      },
      challengeHandler: (_, context) =>
        Effect.gen(function* () {
          completion = yield* context.evaluate(source);
          return Option.none();
        }),
    },
  );
  yield* browser.navigate(`${url}/page`);
  return { completion, reviews };
});
const services = (
  origins: ReadonlyArray<string>,
  policy?: AllowedRequestKinds,
) =>
  Layer.mergeAll(
    TlsClient.layer.pipe(Layer.provide(platform)),
    Browser.BrowserMock.layer({
      allowedOrigins: origins,
      ...(policy === undefined ? {} : { allowedRequestKinds: policy }),
    }).pipe(Layer.provide(platform)),
  );

describeIntegration("before-send request-kind policy", () => {
  for (const enforcement of ["native-and-host", "host"] as const) {
    for (const kind of ["fetch", "xhr", "script", "frame"] as const) {
      for (const redirect of [false, true]) {
        it.live(
          `${enforcement}: ${kind} ${redirect ? "redirect" : "initial"} at script-only origin`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const restricted = yield* fixture();
                const page = yield* fixture(restricted.url);
                const policy: AllowedRequestKinds = {
                  [restricted.url]: ["script"],
                };
                const url = redirect
                  ? `${page.url}/redirect`
                  : `${restricted.url}/sdk.js`;
                const { completion, reviews } = yield* navigate(
                  page.url,
                  `try { ${operation(kind, url)}; return "allowed"; } catch { return "denied"; }`,
                  policy,
                ).pipe(
                  Effect.provide(
                    services(
                      [page.url, restricted.url],
                      enforcement === "host" ? undefined : policy,
                    ),
                  ),
                );
                expect(completion).toBe(
                  kind === "script" ? "allowed" : "denied",
                );
                expect(restricted.paths).toEqual(
                  kind === "script" ? ["/sdk.js"] : [],
                );
                expect(page.paths).toEqual([
                  "/page",
                  ...(redirect ? ["/redirect"] : []),
                ]);
                expect(reviews).toBe(0);
              }),
            ),
        );
      }
    }
  }
  it.live(
    "empty entries deny all; missing field/entry preserves defaults",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const page = yield* fixture();
          for (const kind of ["fetch", "xhr", "script", "frame"] as const) {
            const result = yield* navigate(
              page.url,
              `try { ${operation(kind, "/sdk.js")}; return "allowed"; } catch { return "denied"; }`,
              { [page.url]: [] },
            ).pipe(Effect.provide(services([page.url])));
            expect(result.completion).toBe("denied");
          }
          expect(page.paths.filter((path) => path === "/sdk.js")).toEqual([]);
          for (const policy of [undefined, {}]) {
            for (const kind of ["fetch", "xhr", "script", "frame"] as const) {
              const result = yield* navigate(
                page.url,
                `${operation(kind, "/sdk.js")}; return "allowed";`,
                policy,
              ).pipe(Effect.provide(services([page.url])));
              expect(result.completion).toBe("allowed");
              expect(result.reviews).toBe(kind === "frame" ? 1 : 0);
            }
          }
          expect(page.paths.filter((path) => path === "/sdk.js")).toHaveLength(
            8,
          );
        }),
      ),
  );
  it.live(
    "Browser host rejects malformed custom-runtime policy before evaluation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const page = yield* fixture();
          const result = yield* navigate(page.url, 'return "unused";', {
            [`${page.url}/`]: ["script"],
          }).pipe(Effect.provide(services([page.url])), Effect.result);
          expect(result._tag).toBe("Failure");
          expect(page.paths).toEqual(["/page"]);
        }),
      ),
  );
});
