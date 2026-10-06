import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createServer, type ServerResponse } from "node:http";
import { BrowserMock } from "../src/browser/BrowserMock.js";
import {
  BrowserScriptError,
  runBoundedScript,
  type BrowserScriptHost,
} from "../src/browser/BrowserScript.js";

const document = (scripts: string) =>
  `<!doctype html><html><head></head><body>${scripts}</body></html>`;

const fixture = (assets: Readonly<Record<string, string>>, delayed = "") =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          url: string;
          close: () => Promise<void>;
          paths: string[];
        }>((resolve, reject) => {
          const paths: string[] = [];
          let pending: ServerResponse | undefined;
          const server = createServer((request, response) => {
            const path = request.url ?? "/";
            paths.push(path);
            const body = assets[path];
            if (path === delayed) {
              pending = response;
              // Explicitly release the blocking asset on the next server turn.
              setImmediate(() => {
                pending?.end(body);
                pending = undefined;
              });
            } else if (body !== undefined) response.end(body);
            else response.writeHead(404).end();
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("fixture address missing"));
              return;
            }
            resolve({
              url: `http://127.0.0.1:${address.port}`,
              paths,
              close: () =>
                new Promise<void>((done) => {
                  server.close(() => done());
                  server.closeAllConnections();
                }),
            });
          });
        }),
    ),
    (server) => Effect.promise(server.close),
  );

const run = (
  scripts: string,
  assets: Readonly<Record<string, string>> = {},
  classic = false,
  allowedPathPrefixes?: ReadonlyArray<string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* fixture(assets, "/blocking.js");
      const writes: string[] = [];
      const requests: string[] = [];
      const host: BrowserScriptHost = {
        request: (request) =>
          Effect.tryPromise({
            try: async () => {
              requests.push(request.url);
              const url = new URL(request.url);
              if (url.origin !== server.url)
                throw new Error("fixture origin is not allowed");
              const response = await fetch(url);
              return {
                status: response.status,
                url: response.url,
                headers: [],
                body: await response.text(),
                cookie: "",
              };
            },
            catch: (cause) =>
              new BrowserScriptError({
                reason: "fixture request failed",
                cause,
              }),
          }),
        setCookie: (value) =>
          Effect.sync(() => {
            writes.push(value);
            return "";
          }),
      };
      const result = yield* Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const context = {
          url: `${server.url}/page`,
          cookie: "",
          userAgent: "fixture",
          document: document(scripts),
        };
        if (classic && runtime.evaluateClassic !== undefined)
          return yield* runtime.evaluateClassic(
            'document.cookie = "classic=done";',
            context,
            host,
          );
        if (runtime.evaluateDocument === undefined)
          return yield* new BrowserScriptError({
            reason: "capability missing",
          });
        return yield* runtime.evaluateDocument(context, host);
      }).pipe(
        Effect.result,
        Effect.provide(
          BrowserMock.layer({
            allowedOrigins: [server.url],
            ...(allowedPathPrefixes === undefined
              ? {}
              : { allowedPathPrefixes: { [server.url]: allowedPathPrefixes } }),
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      return { result, writes, paths: server.paths, requests };
    }),
  );

describe("explicit document script evaluation", () => {
  it.live(
    "keeps external and completion Promise species executors guest-local",
    () =>
      Effect.gen(function* () {
        const output = yield* run(
          `<script>var speciesCalls = 0; const NativePromise = Promise;
         Object.defineProperty(Promise, Symbol.species, { value: function Species(executor) {
           if (executor.constructor("return typeof process")() !== "undefined") throw "foreign executor";
           speciesCalls++;
           return new NativePromise(executor);
         } });</script>
         <script src="/species.js"></script>
         <script>document.cookie = "species=" + (speciesCalls > 0);</script>`,
          {
            "/species.js":
              'Promise.resolve().then(() => { document.cookie = "external=done"; });',
          },
        );
        expect(output.result._tag).toBe("Success");
        expect(output.writes).toEqual(["external=done", "species=true"]);
        expect(output.paths).toEqual(["/species.js"]);
      }),
  );

  for (const nested of [false, true]) {
    it.live(
      `checkpoints ${nested ? "nested" : "single"} Promise reactions between inline scripts`,
      () =>
        Effect.gen(function* () {
          const output = yield* run(
            `<script>var trace = ["first"];
           Promise.resolve().then(() => {
             trace.push("microtask");
             ${nested ? 'return Promise.resolve().then(() => trace.push("nested"));' : ""}
           })${nested ? '.then(() => trace.push("last"))' : ""};</script>
           <script>trace.push("second"); document.cookie = "trace=" + trace.join(",");</script>`,
          );
          expect(output.result._tag).toBe("Success");
          expect(output.writes).toEqual([
            nested
              ? "trace=first,microtask,nested,last,second"
              : "trace=first,microtask,second",
          ]);
        }),
    );
  }

  it.live(
    "checkpoints Promise reactions without interleaving timer tasks",
    () =>
      Effect.gen(function* () {
        const output = yield* run(
          `<script>var trace = ["first"];
         setTimeout(() => { trace.push("timer"); document.cookie = "timer=" + trace.join(","); }, 0);
         Promise.resolve().then(() => trace.push("microtask"));</script>
         <script>trace.push("second"); document.cookie = "trace=" + trace.join(",");</script>`,
        );
        expect(output.result._tag).toBe("Success");
        expect(output.writes).toEqual([
          "trace=first,microtask,second",
          "timer=first,microtask,second,timer",
        ]);
      }),
  );

  it.live(
    "checkpoints external classic reactions before the next inline script",
    () =>
      Effect.gen(function* () {
        const output = yield* run(
          '<script src="/microtasks.js"></script><script>trace.push("inline"); document.cookie = "trace=" + trace.join(",");</script>',
          {
            "/microtasks.js":
              'var trace = ["external"]; Promise.resolve().then(() => Promise.resolve().then(() => trace.push("nested")));',
          },
        );
        expect(output.result._tag).toBe("Success");
        expect(output.writes).toEqual(["trace=external,nested,inline"]);
        expect(output.paths).toEqual(["/microtasks.js"]);
      }),
  );

  it.live("bounds an infinite Promise checkpoint", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const started = performance.now();
      const result = yield* Effect.result(
        runBoundedScript(
          runtime,
          "",
          {
            url: "https://allowed.test/page",
            cookie: "",
            userAgent: "fixture",
            document: document(
              '<script>function again() { Promise.resolve().then(again); } again();</script><script>document.cookie = "unexpected=second";</script>',
            ),
          },
          undefined,
          "document",
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(performance.now() - started).toBeLessThan(2000);
    }).pipe(
      Effect.provide(
        BrowserMock.layer({ timeoutMs: 500 }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("dispatches bounded document mode without an async fallback", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const context = {
        url: "https://allowed.test/page",
        cookie: "",
        userAgent: "fixture",
        document: document(
          '<script>document.cookie = "document=done";</script>',
        ),
      };
      const result = yield* runBoundedScript(
        runtime,
        "",
        context,
        undefined,
        "document",
      );
      expect(result).toEqual({ value: "", setCookies: ["document=done"] });
      const unsupported = yield* Effect.result(
        runBoundedScript(
          {
            evaluate: () =>
              Effect.succeed({ value: "wrong fallback", setCookies: [] }),
          },
          "",
          context,
          undefined,
          "document",
        ),
      );
      expect(unsupported._tag).toBe("Failure");
      if (unsupported._tag === "Failure")
        expect(unsupported.failure.reason).toBe(
          "Runtime does not support document script evaluation",
        );
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  it.live("requires a complete document", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      if (runtime.evaluateDocument === undefined)
        return yield* new BrowserScriptError({ reason: "capability missing" });
      const result = yield* Effect.result(
        runtime.evaluateDocument({
          url: "https://allowed.test/page",
          cookie: "",
          userAgent: "fixture",
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.reason).toBe(
          "document evaluation requires a complete document",
        );
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.live(
    "reports external parse/runtime errors and continues in the same realm",
    () =>
      Effect.gen(function* () {
        const output = yield* run(
          `<script>var count = 0; window.addEventListener("error", (event) => {
          count++; document.cookie = "error=" + (event.error instanceof Error) + ":" + event.message;
        });</script>
        <script src="/syntax.js"></script><script src="/throw.js"></script>
        <script>document.cookie = "continued=" + count;</script>`,
          {
            "/syntax.js": "const = ;",
            "/throw.js": 'throw new Error("external boom");',
          },
        );
        expect(output.result._tag).toBe("Success");
        expect(output.writes).toHaveLength(3);
        expect(output.writes[0]).toMatch(/^error=true:/);
        expect(output.writes.slice(1)).toEqual([
          "error=true:external boom",
          "continued=2",
        ]);
      }),
  );

  it.live(
    "shares globals and blocks later inline scripts until an external completes",
    () =>
      Effect.gen(function* () {
        const output = yield* run(
          `<script>var order = ["A"]; let shared = "lexical";</script>
         <script src="/blocking.js"></script>
         <script>order.push("C"); document.cookie = "trace=" + order.join(",");</script>`,
          {
            "/blocking.js": 'order.push(shared === "lexical" ? "B" : "wrong");',
          },
        );
        expect(output.writes).toEqual(["trace=A,B,C"]);
        expect(output.paths).toEqual(["/blocking.js"]);
        expect(output.result._tag).toBe("Success");
        if (output.result._tag === "Success")
          expect(output.result.success.value).toBe("");
      }),
  );

  for (const src of [
    "trusted/../trusted/asset.js",
    "/trusted/%2e/asset.js",
    "/trusted/%2e%2e/trusted/asset.js",
    "/trusted/%252fasset.js",
  ] as const) {
    it.live(`denies raw ambiguous static src before the host: ${src}`, () =>
      Effect.gen(function* () {
        const output = yield* run(
          `<script src="${src}"></script><script>document.cookie = "later=done";</script>`,
          { "/trusted/asset.js": 'document.cookie = "unexpected=loaded";' },
          false,
          ["/trusted/"],
        );
        expect(output.requests).toEqual([]);
        expect(output.paths).toEqual([]);
        expect(output.writes).toEqual(["later=done"]);
        expect(output.result._tag).toBe("Failure");
        if (output.result._tag === "Failure")
          expect(output.result.failure.reason).toBe(
            "document script resource load failed",
          );
      }),
    );
  }

  it.live("allows canonical relative static src under the path policy", () =>
    Effect.gen(function* () {
      const output = yield* run(
        '<script src="trusted/asset.js"></script><script>document.cookie = "later=done";</script>',
        { "/trusted/asset.js": 'document.cookie = "external=done";' },
        false,
        ["/trusted/"],
      );
      expect(output.result._tag).toBe("Success");
      expect(output.requests).toHaveLength(1);
      expect(output.paths).toEqual(["/trusted/asset.js"]);
      expect(output.writes).toEqual(["external=done", "later=done"]);
    }),
  );

  it.live(
    "uses the validated script reply URL for relative error filenames",
    () =>
      Effect.gen(function* () {
        const output = yield* run(
          `<script>window.addEventListener("error", event => {
          document.cookie = "filename=" + (event.filename === location.origin + "/trusted/asset.js");
        });</script><script src="trusted/asset.js"></script>`,
          { "/trusted/asset.js": 'throw "authored fixture";' },
          false,
          ["/trusted/"],
        );
        expect(output.result._tag).toBe("Success");
        expect(output.writes).toEqual(["filename=true"]);
      }),
  );

  for (const src of [
    "/trusted/../trusted/frame",
    "/trusted/%2e/frame",
  ] as const) {
    it.live(
      `preserves raw frame src for denial before the frame host: ${src}`,
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          let frameCalls = 0;
          const host: BrowserScriptHost = {
            request: () =>
              Effect.fail(
                new BrowserScriptError({ reason: "unexpected request" }),
              ),
            setCookie: () => Effect.succeed(""),
            loadFrame: () => {
              frameCalls++;
              return Effect.fail(
                new BrowserScriptError({ reason: "no frame grant" }),
              );
            },
          };
          const result = yield* runtime.evaluate(
            `const frame = document.createElement("iframe");
           frame.src = ${JSON.stringify(src)};
           const denied = new Promise(resolve => { frame.onerror = () => resolve("denied"); });
           document.body.appendChild(frame);
           return await denied;`,
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            host,
          );
          expect(result.value).toBe("denied");
          expect(frameCalls).toBe(0);
        }).pipe(
          Effect.provide(
            BrowserMock.layer({
              allowedOrigins: ["https://allowed.test"],
              allowedPathPrefixes: { "https://allowed.test": ["/trusted/"] },
            }).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
    );
  }

  it.live("runs defer after inline, async on load, and awaits both", () =>
    Effect.gen(function* () {
      const output = yield* run(
        `<script>var order = ["A"];</script>
         <script defer src="/defer.js"></script>
         <script>order.push("C");</script>
         <script async defer src="/async.js"></script>
         <script src="/blocking.js"></script>`,
        {
          "/async.js":
            'order.push("async"); document.cookie = "trace=" + order.join(",");',
          "/blocking.js": 'order.push("blocking");',
          "/defer.js":
            'order.push("defer"); document.cookie = "trace=" + order.join(",");',
        },
      );
      expect(output.writes).toEqual([
        "trace=A,C,async",
        "trace=A,C,async,blocking,defer",
      ]);
      expect(output.paths).toEqual(["/async.js", "/blocking.js", "/defer.js"]);
      expect(output.result._tag).toBe("Success");
    }),
  );

  it.live(
    "continues after denied resources, HTTP failures, and reported inline errors",
    () =>
      Effect.gen(function* () {
        const output = yield* run(
          `<script>window.onerror = (message, url, line, column, error) => {
           document.cookie = "error=" + message + ":" + (url === location.href) + ":" + (error instanceof Error);
         };</script>
         <script src="https://denied.test/asset.js"></script>
         <script src="/missing.js"></script>
         <script>throw new Error("fixture boom");</script>
         <script>document.cookie = "later=done";</script>`,
        );
        expect(output.writes).toEqual([
          "error=fixture boom:true:true",
          "later=done",
        ]);
        expect(output.paths).toEqual(["/missing.js"]);
        expect(output.result._tag).toBe("Failure");
        if (output.result._tag === "Failure") {
          expect(output.result.failure._tag).toBe("BrowserScriptError");
          expect(output.result.failure.reason).toBe(
            "document script resource load failed",
          );
        }
      }),
  );

  for (const scheduling of ["", "defer", "async"] as const) {
    for (const src of [
      "https://denied.test/asset.js",
      "/missing.js",
    ] as const) {
      it.live(
        `fails after later scripts finish: ${scheduling || "blocking"} ${src}`,
        () =>
          Effect.gen(function* () {
            const output = yield* run(
              `<script ${scheduling} src="${src}"></script>
             <script>document.cookie = "later=inline";</script>
             <script defer src="/later.js"></script>`,
              { "/later.js": 'document.cookie = "later=external";' },
            );
            expect(output.writes).toEqual(["later=inline", "later=external"]);
            expect(output.paths).toEqual(
              src === "/missing.js"
                ? ["/missing.js", "/later.js"]
                : ["/later.js"],
            );
            expect(output.result._tag).toBe("Failure");
            if (output.result._tag === "Failure") {
              expect(output.result.failure._tag).toBe("BrowserScriptError");
              expect(output.result.failure.reason).toBe(
                "document script resource load failed",
              );
            }
          }),
      );
    }
  }

  it.live(
    "reports inline throws without treating them as resource failures",
    () =>
      Effect.gen(function* () {
        const output = yield* run(
          `<script>window.addEventListener("error", () => { document.cookie = "reported=inline"; });</script>
         <script>throw new Error("authored inline failure");</script>
         <script>document.cookie = "later=done";</script>`,
        );
        expect(output.result._tag).toBe("Success");
        expect(output.writes).toEqual(["reported=inline", "later=done"]);
        expect(output.paths).toEqual([]);
      }),
  );

  it.live(
    "flushes external cookie writes and retained timers before returning",
    () =>
      Effect.gen(function* () {
        const output = yield* run('<script async src="/cookie.js"></script>', {
          "/cookie.js":
            'document.cookie = "external=done"; setTimeout(() => { document.cookie = "timer=done"; }, 0);',
        });
        expect(output.writes).toEqual(["external=done", "timer=done"]);
        expect(output.result._tag).toBe("Success");
        if (output.result._tag === "Success")
          expect(output.result.success.setCookies).toEqual([]);
      }),
  );

  it.live("skips module, nomodule, and non-JavaScript types", () =>
    Effect.gen(function* () {
      const output = yield* run(
        `<script type="module" src="/module.js"></script>
         <script nomodule src="/legacy.js"></script>
         <script type="application/json">throw new Error("not code");</script>
         <script type="TEXT/JAVASCRIPT">document.cookie = "classic=one";</script>
         <script type=" Application/JavaScript ">document.cookie = "classic=two";</script>
         <script type="">document.cookie = "classic=three";</script>`,
      );
      expect(output.result._tag).toBe("Success");
      expect(output.paths).toEqual([]);
      expect(output.writes).toEqual([
        "classic=one",
        "classic=two",
        "classic=three",
      ]);
    }),
  );

  it.live("keeps response scripts inert during evaluateClassic", () =>
    Effect.gen(function* () {
      const output = yield* run(
        '<script>document.cookie = "unexpected=inline";</script><script src="/unexpected.js"></script>',
        {},
        true,
      );
      expect(output.paths).toEqual([]);
      expect(output.writes).toEqual(["classic=done"]);
      expect(output.result._tag).toBe("Success");
    }),
  );

  it.live("removes trusted helpers before the first document script", () =>
    Effect.gen(function* () {
      const output = yield* run(
        `<script>
        if (["__loadDocumentScript", "__scriptErrorReporter", "__cookieFlush", "__waitForIdle"].some(key => key in globalThis)) throw new Error("helper leaked");
        globalThis.__loadDocumentScript = () => { throw new Error("tampered"); };
      </script><script src="/safe.js"></script>`,
        {
          "/safe.js": 'document.cookie = "trusted=done";',
        },
      );
      expect(output.writes).toEqual(["trusted=done"]);
      expect(output.result._tag).toBe("Success");
    }),
  );
});
