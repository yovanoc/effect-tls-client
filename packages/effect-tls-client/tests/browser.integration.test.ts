import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import { createServer, type Server } from "node:http";
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
    if (path === "/challenge") {
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

describeRealIntegration("real BrowserMock integration", () => {
  it.live(
    "executes a script, writes a safe cookie, and follows up through Go",
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
          Browser.BrowserMock.layer().pipe(Layer.provide(platform)),
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
                      'if (document.cookie.includes("read-secret")) return "leaked"; document.cookie = "server-secret=overwritten; Path=/private"; document.cookie = "server-secret=allowed; Path=/"; document.cookie = "clearance=ok; Path=/"; document.cookie = "forbidden=no; HttpOnly; Path=/"; return "ready";',
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
        expect(fixture.cookies).toHaveLength(2);
        expect(fixture.cookies[1]).toContain("server-secret=hidden");
        expect(fixture.cookies[1]).not.toContain("server-secret=overwritten");
        expect(fixture.cookies[1]).toContain("clearance=ok");
      }),
  );
});
