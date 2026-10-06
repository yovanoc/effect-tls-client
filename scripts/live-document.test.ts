import { describe, expect, it } from "bun:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { createServer } from "node:http";
import { TlsClient } from "../packages/effect-tls-client/src/TlsClient.js";
import * as Browser from "../packages/effect-tls-client/src/browser/index.js";
import { inlineClassicPrograms, restrictRuntime } from "./live-challenge.js";

const integration =
  process.env.TLS_CLIENT_INTEGRATION === "1" &&
  process.env.TLS_CLIENT_BRIDGE_PATH !== undefined;
const inline = 'var fixtureConfig = { value: "authored" };';
const dynamic = `${inline} var asset = document.createElement("script"); asset.src = "/asset.js"; document.head.appendChild(asset);`;
const page = (script: string, extra = "", doctype = "<!doctype html>") =>
  `${doctype}\n<!-- authored fixture --><HTML lang=en><HEAD><meta charset=utf-8><STYLE>body { color: red; } /* < & */</STYLE><TITLE>Local fixture</TITLE><script>${script}</script></HEAD><BODY onload="throw new Error('must stay inert')"><div id=notice>Local only</div>${extra}</BODY></HTML>`;

const run = (body: string, classic: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const paths: string[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
              const server = createServer((request, response) => {
                paths.push(request.url ?? "/");
                if (request.url === "/asset.js")
                  response.end(
                    'if (fixtureConfig.value !== "authored") throw new Error("config missing"); document.cookie = "fixture=done; Path=/";',
                  );
                else
                  response
                    .writeHead(403, { "content-type": "text/html" })
                    .end(body);
              });
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
              }),
          ),
      );
      const address = server.address();
      if (address === null || typeof address === "string")
        return yield* Effect.die("fixture address missing");
      const origin = `http://127.0.0.1:${address.port}`;
      const network = { allowed: 0, denied: 0 };
      return yield* Effect.gen(function* () {
        const runtime = yield* Browser.BrowserMock;
        let evaluation: Option.Option<Browser.BrowserOperationError> =
          Option.none();
        let documentPassed = false;
        const restricted = restrictRuntime(runtime, [{ origin }], network);
        const browser = yield* Browser.open(
          { transport: { profile: "chrome_146", forceHttp1: true } },
          {
            scriptRuntime: {
              ...restricted,
              evaluateDocument: (context, host) => {
                documentPassed = context.document === body;
                if (restricted.evaluateDocument === undefined)
                  return Effect.fail(
                    new Browser.BrowserScriptError({
                      reason: "fixture capability missing",
                    }),
                  );
                return restricted.evaluateDocument(context, host);
              },
            },
            responseHandler: (_, context) =>
              Effect.gen(function* () {
                const result = yield* Effect.result(
                  classic
                    ? context.evaluateClassic(
                        inlineClassicPrograms(context.body).join("\n"),
                      )
                    : context.evaluateDocument(),
                );
                if (result._tag === "Failure")
                  evaluation = Option.some(result.failure);
                return Option.none();
              }),
          },
        );
        const response = yield* browser.navigate(`${origin}/page`);
        const cookies = yield* browser.transport.scriptCookies(
          `${origin}/page`,
        );
        return {
          evaluation,
          documentPassed,
          network,
          paths,
          status: response.status,
          cookies,
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TlsClient.layer.pipe(Layer.provide(NodeServices.layer)),
            Browser.BrowserMock.layer({ allowedOrigins: [origin] }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      );
    }),
  );

describe.skipIf(!integration)("local harness document path", () => {
  for (const [name, body] of [
    ["static asset", page(inline + "</script><script src=/asset.js>")],
    ["dynamic asset", page(dynamic)],
    [
      "body noscript and CDATA-like raw text",
      page(
        dynamic + ' var text = "<![CDATA[ authored ]]>";',
        "<noscript><div>Enable scripting</div></noscript>",
      ),
    ],
    ["doctype trailing whitespace", page(dynamic, "", "<!DOCTYPE html >")],
  ] as const) {
    it(name, async () => {
      const result = await Effect.runPromise(run(body, false));
      expect(result.status).toBe(403);
      expect(result.documentPassed).toBe(true);
      expect(result.evaluation).toEqual(Option.none());
      expect(result.network).toEqual({ allowed: 1, denied: 0 });
      expect(result.paths).toEqual(["/page", "/asset.js"]);
      expect(result.cookies).toContain("fixture=done");
    });
  }
  for (const [name, body, reason, rule] of [
    [
      "head noscript",
      page(dynamic).replace(
        "<meta charset=utf-8>",
        "<noscript>Enable scripting</noscript>",
      ),
      "unsupported HTML document",
      "HeadContentSubset",
    ],
    [
      "CDATA outside raw text",
      page(dynamic, "<![CDATA[ authored ]]>"),
      "unsupported HTML document",
      "MarkupSyntax",
    ],
    [
      "element ceiling",
      page(dynamic, "<div></div>".repeat(32)),
      "HTML document exceeds elements limit",
      undefined,
    ],
  ] as const) {
    it(`classic runs but document rejects ${name} before networking`, async () => {
      const rejected = await Effect.runPromise(run(body, false));
      expect(rejected.network).toEqual({ allowed: 0, denied: 0 });
      expect(rejected.paths).toEqual(["/page"]);
      expect(Option.isSome(rejected.evaluation)).toBe(true);
      if (Option.isSome(rejected.evaluation)) {
        expect(rejected.evaluation.value).toMatchObject({ reason });
        if (rule !== undefined)
          expect(rejected.evaluation.value).toMatchObject({
            documentInputRule: rule,
          });
      }
      const result = await Effect.runPromise(run(body, true));
      expect(result.evaluation).toEqual(Option.none());
      expect(result.network.allowed).toBe(1);
    });
  }
});
