import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import * as Browser from "../src/browser/index.js";
import { makeBrowserScriptRunnerSource } from "../src/browser/BrowserScriptRunner.js";
import { TlsClient } from "../src/index.js";

const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const describeIntegration =
  bridgePath !== undefined && process.env["TLS_CLIENT_INTEGRATION"] === "1"
    ? describe
    : describe.skip;

const fixture = Effect.fnUntraced(function* () {
  const paths: Array<string> = [];
  // Control characters exercise sixfold JSON escaping without enlarging the asset.
  const asset = `/*${"\u0001".repeat(900 * 1024)}*/ window.loaded = (window.loaded || 0) + 1;`;
  const server = createServer((request, response) => {
    const route = request.url ?? "/";
    paths.push(route);
    if (route === "/page") {
      response.writeHead(202, { "x-amzn-waf-action": "challenge" });
      response.end("local budget fixture");
    } else if (route.startsWith("/redirect/")) {
      const [, , chain, rawHop] = route.split("/");
      const hop = Number(rawHop);
      if (hop < (chain === "long" ? 3 : 1)) {
        response.writeHead(302, {
          location: `/redirect/${chain}/${hop + 1}`,
        });
        response.end();
      } else {
        response.end("ok");
      }
    } else if (route.endsWith(".js")) {
      response.setHeader("content-type", "text/javascript");
      response.end(asset);
    } else {
      response.end("ok");
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

const sequence = (count: number) => `
  let completed = 0;
  let failure = "";
  for (let i = 0; i < ${count}; i++) {
    try { await fetch("/collector/" + i); completed++; }
    catch (error) { failure = error.message; break; }
  }
  return completed + "|" + failure;
`;

const redirectSource = (chain: "short" | "long") => `
  let failure = "";
  try { await fetch("/redirect/${chain}/0"); }
  catch (error) { failure = error.message; }
  return failure || "complete";
`;

const platform = Layer.mergeAll(
  NodeServices.layer,
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
  ),
);

const navigate = Effect.fnUntraced(function* (
  url: string,
  source: string,
  maxNetworkRequests?: number,
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
        ...(maxNetworkRequests === undefined ? {} : { maxNetworkRequests }),
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

const services = (url: string, maxNetworkRequests?: number) =>
  Layer.mergeAll(
    TlsClient.layer.pipe(Layer.provide(platform)),
    Browser.BrowserMock.layer({
      allowedOrigins: [url],
      ...(maxNetworkRequests === undefined ? {} : { maxNetworkRequests }),
    }).pipe(Layer.provide(platform)),
  );

describe("network budget configuration", () => {
  for (const maxNetworkRequests of [0, 17, 1.5]) {
    it.live(`rejects maxNetworkRequests=${maxNetworkRequests}`, () =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          return yield* Browser.BrowserMock;
        }).pipe(
          Effect.provide(
            Browser.BrowserMock.layer({ maxNetworkRequests }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("BrowserScriptError");
          expect(result.failure.reason).toBe("invalid BrowserMock options");
        }
      }),
    );
  }

  it.live("completes when the retention wait exceeds the output budget", () =>
    Effect.gen(function* () {
      const source = makeBrowserScriptRunnerSource({
        maxTimeoutMs: 120_000,
        maxInputLineBytes: 8 * 1024 * 1024,
        maxControlInputLineBytes: 128 * 1024,
        maxOutputLineBytes: 128 * 1024,
        maxOutputBytes: 1,
        maxCookieBytes: 64 * 1024,
        maxCookieWrites: 64,
        maxNetworkRequests: 8,
        maxRequestBodyBytes: 16 * 1024,
        maxTotalNetworkBytes: 2 * 1024 * 1024,
        maxHeaders: 128,
        maxHeaderBytes: 64 * 1024,
        maxTimers: 64,
        maxTimerDelayMs: 120_000,
      });
      const stdout = yield* Effect.promise(
        (signal) =>
          new Promise<string>((resolve, reject) => {
            const child = execFile(
              process.execPath,
              ["--permission", "-e", source],
              { timeout: 3_000, signal },
              (error, stdout) => {
                if (error !== null) reject(error);
                else resolve(stdout);
              },
            );
            child.stdin?.end(
              JSON.stringify({
                timeoutMs: 500,
                source: 'return "done";',
                url: "about:blank",
                cookie: "",
                userAgent: "fixture",
                authoritativeCookies: false,
              }) + "\n",
            );
          }),
      );
      expect(JSON.parse(stdout)).toEqual({
        type: "result",
        output: { ok: true, value: "done", setCookies: [] },
      });
    }),
  );
});

describeIntegration("per-evaluation network caps", () => {
  for (const maxNetworkRequests of [0, 17, 1.5]) {
    it.live(
      `rejects custom scriptRuntime maxNetworkRequests=${maxNetworkRequests}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { url } = yield* fixture();
            const result = yield* navigate(
              url,
              "return 'unused';",
              maxNetworkRequests,
            ).pipe(Effect.provide(services(url)), Effect.result);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(result.failure._tag).toBe("BrowserScriptError");
              if (result.failure._tag === "BrowserScriptError") {
                expect(result.failure.reason).toBe(
                  "invalid script maxNetworkRequests",
                );
              }
            }
          }),
        ),
    );
  }

  it.live("counts redirect hops toward the request cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, paths } = yield* fixture();
        const shorter = yield* navigate(url, redirectSource("short"), 3).pipe(
          Effect.provide(services(url, 16)),
        );
        expect(shorter).toBe("complete");

        const longer = yield* navigate(url, redirectSource("long"), 3).pipe(
          Effect.provide(services(url, 16)),
        );
        expect(longer).toContain(
          "script network request budget exceeds 3 requests",
        );
        expect(
          paths.filter((path) => path.startsWith("/redirect/short/")),
        ).toEqual(["/redirect/short/0", "/redirect/short/1"]);
        expect(
          paths.filter((path) => path.startsWith("/redirect/long/")),
        ).toEqual(["/redirect/long/0", "/redirect/long/1", "/redirect/long/2"]);
      }),
    ),
  );

  for (const [cap, requests, expected] of [
    [undefined, 9, 8],
    [16, 12, 12],
  ] as const) {
    it.live(
      `allows ${expected} sequential requests with cap ${cap ?? "default"}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { url, paths } = yield* fixture();
            const result = yield* navigate(url, sequence(requests)).pipe(
              Effect.provide(services(url, cap)),
            );
            expect(result).toMatch(new RegExp(`^${expected}\\|`));
            if (requests > expected) expect(result).toContain("request budget");
            else expect(result).toBe(`${expected}|`);
            expect(
              paths.filter((path) => path.startsWith("/collector/")),
            ).toHaveLength(expected);
          }),
        ),
    );
  }

  it.live("Browser.open independently enforces the configured cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, paths } = yield* fixture();
        // Runner permits 16, while Browser's host must stop at 3.
        const result = yield* navigate(url, sequence(4), 3).pipe(
          Effect.provide(services(url, 16)),
        );
        expect(result).toContain(
          "3|script network request budget exceeds 3 requests",
        );
        expect(
          paths.filter((path) => path.startsWith("/collector/")),
        ).toHaveLength(3);
      }),
    ),
  );

  for (const count of [2, 3]) {
    it.live(
      `${count === 2 ? "accepts" : "rejects"} ${count} escaped 900 KiB script loads`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { url, paths } = yield* fixture();
            const source = `let failure = ""; for (let i = 0; i < ${count}; i++) { try { await document.loadScript("/asset-" + i + ".js"); } catch (error) { failure = error.message; break; } } return window.loaded + "|" + failure;`;
            const result = yield* navigate(url, source).pipe(
              Effect.provide(services(url)),
            );
            if (count === 2) expect(result).toBe("2|");
            else
              expect(result).toContain("2|script network byte budget exceeded");
            expect(paths.filter((path) => path.endsWith(".js"))).toHaveLength(
              count,
            );
          }),
        ),
    );
  }
});
