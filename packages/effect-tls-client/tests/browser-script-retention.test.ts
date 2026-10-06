import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { createServer } from "node:http";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import * as Browser from "../src/browser/index.js";
import { TlsClient } from "../src/index.js";

const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const describeLocal =
  bridgePath !== undefined && process.env["TLS_CLIENT_INTEGRATION"] === "1"
    ? describe
    : describe.skip;
const Cookies = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
);

describeLocal("bounded natural script work", () => {
  for (const mode of ["cookie", "nested", "fetch", "xhr", "expiry"] as const) {
    it.live(`retains unawaited script work: ${mode}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const paths: Array<string> = [];
          let followCookie = "";
          const server = createServer((request, response) => {
            const route = request.url ?? "/";
            paths.push(route);
            if (route === "/page") {
              response.writeHead(202, { "x-amzn-waf-action": "challenge" });
              response.end("local retention fixture");
            } else if (route === "/late.js") {
              if (mode === "expiry") return; // Hold until evaluation closes the request.
              response.setHeader("content-type", "text/javascript");
              response.end(
                mode === "nested"
                  ? 'document.cookie = "first=done; Path=/"; const next = document.createElement("script"); next.src = "/second.js"; document.head.appendChild(next);'
                  : mode === "fetch"
                    ? 'fetch("/collector", { method: "POST" }).then(r => r.text()).then(value => { document.cookie = value; });'
                    : mode === "xhr"
                      ? 'const xhr = new XMLHttpRequest(); xhr.open("POST", "/collector"); xhr.onload = () => { document.cookie = xhr.responseText; }; xhr.send();'
                      : 'document.cookie = "late=done; Path=/";',
              );
            } else if (route === "/second.js") {
              response.end('document.cookie = "late=done; Path=/";');
            } else if (route === "/collector") {
              expect(request.method).toBe("POST");
              response.end("late=done; Path=/");
            } else if (route === "/follow") {
              followCookie = request.headers.cookie ?? "";
              response.end("follow-up");
            } else {
              response.writeHead(404);
              response.end();
            }
          });
          const url = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<string>((resolve, reject) => {
                  server.once("error", reject);
                  server.listen(0, "127.0.0.1", () => {
                    const address = server.address();
                    if (address === null || typeof address === "string") {
                      reject(new Error("fixture address missing"));
                    } else resolve(`http://127.0.0.1:${address.port}`);
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
          const platform = Layer.mergeAll(
            NodeServices.layer,
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                TLS_CLIENT_BRIDGE_PATH: bridgePath,
              }),
            ),
          );
          const services = Layer.mergeAll(
            TlsClient.layer.pipe(Layer.provide(platform)),
            Browser.BrowserMock.layer({
              allowedOrigins: [url],
              timeoutMs: 1_000,
            }).pipe(Layer.provide(platform)),
          );
          yield* Effect.gen(function* () {
            const runtime = yield* Browser.BrowserMock;
            let completion = "";
            const browser = yield* Browser.open(
              {
                transport: { profile: "chrome_146", forceHttp1: true },
                identity: Browser.Chrome146Identity,
              },
              {
                scriptRuntime: runtime,
                challengeHandler: (_, context) =>
                  Effect.gen(function* () {
                    completion = yield* context.evaluateClassic(`
                      if ("__waitForIdle" in globalThis || "__naturalWork" in globalThis) throw new Error("idle hook leaked");
                      const script = document.createElement("script");
                      script.src = "/late.js";
                      ${mode === "cookie" ? 'document.cookie = "root=done; Path=/";' : ""}
                      document.head.appendChild(script);
                      "root finished";
                    `);
                    return Option.none();
                  }),
              },
            );
            const started = performance.now();
            const page = yield* browser.navigate(`${url}/page`);
            expect(completion).toBe("root finished");
            expect(page.status).toBe(202);
            const cookies = yield* Schema.decodeEffect(Cookies)(
              yield* browser.transport.exportCookies,
            );
            yield* browser.navigate(`${url}/follow`);
            if (mode === "expiry") {
              expect(performance.now() - started).toBeGreaterThan(700);
              expect(performance.now() - started).toBeLessThan(2_000);
              expect(cookies).toEqual([]);
              expect(followCookie).toBe("");
              expect(paths).toEqual(["/page", "/late.js", "/follow"]);
            } else {
              expect(cookies).toContainEqual({ name: "late", value: "done" });
              expect(followCookie).toContain("late=done");
              if (mode === "cookie") {
                expect(cookies).toContainEqual({ name: "root", value: "done" });
                expect(followCookie).toContain("root=done");
              }
              if (mode === "nested") {
                expect(cookies).toContainEqual({
                  name: "first",
                  value: "done",
                });
                expect(paths).toContain("/second.js");
              }
              if (mode === "fetch" || mode === "xhr")
                expect(paths).toContain("/collector");
            }
          }).pipe(Effect.provide(services));
        }),
      ),
    );
  }
});

describe("natural timer retention", () => {
  const services = Browser.BrowserMock.layer({ timeoutMs: 500 }).pipe(
    Layer.provide(NodeServices.layer),
  );
  for (const mode of ["nested", "cleared", "interval", "failure"] as const) {
    it.live(`handles ${mode} timers after classic completion`, () =>
      Effect.gen(function* () {
        const runtime = yield* Browser.BrowserMock;
        const started = performance.now();
        const result = yield* Effect.result(
          Browser.runBoundedScript(
            runtime,
            mode === "failure"
              ? 'setInterval(() => {}, 100); throw new Error("root failed");'
              : mode === "interval"
                ? 'setInterval(() => { document.cookie = "timer=done"; }, 100); "done";'
                : mode === "cleared"
                  ? 'const timer = setTimeout(() => { document.cookie = "unexpected=yes"; }, 1000); clearTimeout(timer); "done";'
                  : 'setTimeout(() => { setTimeout(() => { document.cookie = "timer=done"; }, 10); }, 10); "done";',
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            undefined,
            "classic",
          ),
        );
        if (mode === "failure") {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({ reason: "root failed" });
          expect(performance.now() - started).toBeLessThan(350);
        } else {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success") {
            expect(result.success.value).toBe("done");
            expect(result.success.setCookies).toEqual(
              mode === "cleared" ? [] : expect.arrayContaining(["timer=done"]),
            );
          }
          if (mode === "interval")
            expect(performance.now() - started).toBeGreaterThan(350);
          if (mode === "cleared")
            expect(performance.now() - started).toBeLessThan(350);
        }
      }).pipe(Effect.provide(services)),
    );
  }
});
