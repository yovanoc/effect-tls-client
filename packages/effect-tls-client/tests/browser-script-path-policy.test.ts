import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { createServer } from "node:http";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import * as Browser from "../src/browser/index.js";
import {
  AllowedPathPrefixes,
  resolveAllowedUrl,
} from "../src/browser/ScriptPolicy.js";
import { TlsClient } from "../src/index.js";

const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const describeIntegration =
  bridgePath !== undefined && process.env["TLS_CLIENT_INTEGRATION"] === "1"
    ? describe
    : describe.skip;
const fixture = Effect.fnUntraced(function* () {
  const paths: Array<string> = [];
  const server = createServer((request, response) => {
    const route = request.url ?? "/";
    paths.push(route);
    if (route === "/page") {
      response.writeHead(202, { "x-amzn-waf-action": "challenge" });
      response.end("local path fixture");
    } else if (route.startsWith("/trusted/redirect-")) {
      const destination = route.slice("/trusted/redirect-".length);
      response.writeHead(302, {
        location:
          destination === "denied"
            ? "/denied"
            : destination === "origin"
              ? "http://localhost:1/denied"
              : "/trusted/ok",
      });
      response.end();
    } else {
      response.end("window.pathFixture = true;");
    }
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

const navigate = Effect.fnUntraced(function* (
  url: string,
  source: string,
  policy?: Readonly<Record<string, ReadonlyArray<string>>>,
) {
  const runtime = yield* Browser.BrowserMock;
  let completion = "";
  const browser = yield* Browser.open(
    {
      transport: { profile: "chrome_146", forceHttp1: true },
      identity: Browser.Chrome146Identity,
    },
    {
      scriptRuntime: {
        ...runtime,
        ...(policy === undefined ? {} : { allowedPathPrefixes: policy }),
      },
      challengeHandler: (_, context) =>
        Effect.gen(function* () {
          completion = yield* context.evaluate(source);
          return Option.none();
        }),
    },
  );
  yield* browser.navigate(`${url}/page`);
  return completion;
});

const services = (
  url: string,
  policy?: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  Layer.mergeAll(
    TlsClient.layer.pipe(Layer.provide(platform)),
    Browser.BrowserMock.layer({
      allowedOrigins: [url],
      ...(policy === undefined ? {} : { allowedPathPrefixes: policy }),
    }).pipe(Layer.provide(platform)),
  );

describe("script path policy", () => {
  const origin = "https://fixture.test";
  const resolve = (path: string, prefixes = ["/trusted/"]) =>
    resolveAllowedUrl(path, `${origin}/page`, [origin], { [origin]: prefixes });
  it("matches exact/segment prefixes and keeps origin permission separate", () => {
    expect(resolve("/trusted/ok?value=%2f").pathname).toBe("/trusted/ok");
    expect(resolve("/trusted", ["/trusted"]).pathname).toBe("/trusted");
    expect(resolve("/trusted/ok", ["/trusted"]).pathname).toBe("/trusted/ok");
    for (const path of ["/trusted", "/trusted-other", "/denied"])
      expect(() => resolve(path)).toThrow();
    expect(() => resolve("/trusted/ok", [])).toThrow();
    expect(() => resolve("https://denied.test/trusted/ok")).toThrow();
    expect(
      resolveAllowedUrl("/other", `${origin}/page`, [origin], {}).pathname,
    ).toBe("/other");
    expect(
      resolveAllowedUrl("/other", `${origin}/page`, [origin]).pathname,
    ).toBe("/other");
  });
  it("rejects ambiguity before URL normalization", () => {
    for (const path of [
      "/trusted/../trusted/ok",
      "/trusted/%2e/ok",
      "/trusted/%2fdenied",
      "/trusted/%252fdenied",
      "/trusted//ok",
      "/trusted/\\ok",
      "/trusted/\tok",
      "/trusted/é",
    ])
      expect(() => resolve(path)).toThrow();
  });
  it("rejects malformed origin keys and prefixes at the Schema boundary", () => {
    for (const key of [
      "https://fixture.test/",
      "https://FIXTURE.test",
      "https://fixture.test/path",
      "https://user@fixture.test",
      "http://remote.test",
      "bad",
    ])
      expect(() =>
        Schema.decodeUnknownSync(AllowedPathPrefixes)({ [key]: ["/trusted/"] }),
      ).toThrow();
    for (const prefix of [
      "",
      "trusted",
      "//trusted",
      "/trusted/..",
      "/trusted/%2f",
      "/trusted?query",
      "/trusted#hash",
      "/trusted/\\ok",
    ])
      expect(() =>
        Schema.decodeUnknownSync(AllowedPathPrefixes)({ [origin]: [prefix] }),
      ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AllowedPathPrefixes)({ [origin]: "wrong" }),
    ).toThrow();
  });
  it.live("rejects invalid BrowserMock configuration", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        return yield* Browser.BrowserMock;
      }).pipe(
        Effect.provide(
          Browser.BrowserMock.layer({
            allowedPathPrefixes: { [origin]: ["/../"] },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});

describeIntegration("before-send path policy", () => {
  for (const kind of ["fetch", "script", "xhr"] as const) {
    for (const destination of ["denied", "allowed", "origin"] as const) {
      it.live(`${kind} redirect to ${destination}`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { url, paths } = yield* fixture();
            const path = `/trusted/redirect-${destination}`;
            const operation =
              kind === "fetch"
                ? `await fetch(${JSON.stringify(path)})`
                : kind === "script"
                  ? `await document.loadScript(${JSON.stringify(path)})`
                  : `await new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open("GET", ${JSON.stringify(path)}); xhr.onload = resolve; xhr.onerror = reject; xhr.send(); })`;
            const completion = yield* navigate(
              url,
              `try { ${operation}; return "allowed"; } catch { return "denied"; }`,
            ).pipe(Effect.provide(services(url, { [url]: ["/trusted/"] })));
            expect(completion).toBe(
              destination === "allowed" ? "allowed" : "denied",
            );
            expect(paths.filter((path) => path === "/denied")).toHaveLength(0);
            expect(paths).toEqual([
              "/page",
              path,
              ...(destination === "allowed" ? ["/trusted/ok"] : []),
            ]);
          }),
        ),
      );
    }
  }
  it.live(
    "Browser host independently validates custom runtime paths and configuration",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { url, paths } = yield* fixture();
          const completion = yield* navigate(
            url,
            'try { await fetch("/trusted/redirect-denied"); return "allowed"; } catch { return "denied"; }',
            { [url]: ["/trusted/"] },
          ).pipe(Effect.provide(services(url)));
          expect(completion).toBe("denied");
          expect(paths).toEqual(["/page", "/trusted/redirect-denied"]);
          const result = yield* navigate(url, 'return "unused";', {
            [url]: ["/../"],
          }).pipe(Effect.provide(services(url)), Effect.result);
          expect(result._tag).toBe("Failure");
          if (
            result._tag === "Failure" &&
            result.failure._tag === "BrowserScriptError"
          )
            expect(result.failure.reason).toBe(
              "invalid script network path policy",
            );
        }),
      ),
  );
  it.live("rejects ambiguous initial references without sending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, paths } = yield* fixture();
        const completion = yield* navigate(
          url,
          'for (const path of ["/trusted/../trusted/ok", "/trusted/%2fok", "/trusted//ok"]) { try { await fetch(path); return "allowed"; } catch {} } return "denied";',
        ).pipe(Effect.provide(services(url, { [url]: ["/trusted/"] })));
        expect(completion).toBe("denied");
        expect(paths).toEqual(["/page"]);
      }),
    ),
  );
  it.live(
    "denies initial paths and empty entries without sending; absent policy is unchanged",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { url, paths } = yield* fixture();
          for (const prefixes of [["/trusted/"], []]) {
            const completion = yield* navigate(
              url,
              'try { await fetch("/denied"); return "allowed"; } catch { return "denied"; }',
            ).pipe(Effect.provide(services(url, { [url]: prefixes })));
            expect(completion).toBe("denied");
          }
          expect(paths.filter((path) => path === "/denied")).toHaveLength(0);
          const completion = yield* navigate(
            url,
            'await fetch("/trusted/redirect-denied"); return "allowed";',
          ).pipe(Effect.provide(services(url)));
          expect(completion).toBe("allowed");
          expect(paths.filter((path) => path === "/denied")).toHaveLength(1);
        }),
      ),
  );
});
