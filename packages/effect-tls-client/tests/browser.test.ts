import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as Cookies from "effect/unstable/http/Cookies";
import type { TlsResponse, TlsSession } from "../src/TlsClient.js";
import {
  BrowserMock,
  BrowserSessionError,
  BrowserScriptError,
  Chrome152Identity,
  fromSession,
  navigationHeaders,
  runBoundedScript,
  xhrHeaders,
  type BrowserScriptHost,
  type BrowserScriptRuntime,
} from "../src/browser/index.js";

const bodyBytes = (body: string): Uint8Array => new TextEncoder().encode(body);

type Call = {
  readonly url: string;
  readonly options: Parameters<TlsSession["request"]>[1];
};

const response = (
  url: string,
  status: number,
  body: string,
  headers: ReadonlyArray<readonly [string, string]> = [],
  onClose: () => void = () => {},
): TlsResponse => ({
  status,
  url,
  headers,
  protocol: "HTTP/1.1",
  cookies: Cookies.empty,
  bytesRead: Effect.succeed(bodyBytes(body).byteLength),
  bytesWritten: Effect.succeed(0),
  stream: Stream.succeed(bodyBytes(body)),
  bytes: Effect.succeed(bodyBytes(body)),
  text: Effect.succeed(body),
  json: Effect.succeed({}),
  close: Effect.sync(onClose),
});

const hostRuntime = (
  allowedOrigins: ReadonlyArray<string>,
  evaluate: (
    host: BrowserScriptHost,
  ) => Effect.Effect<string, BrowserScriptError>,
): BrowserScriptRuntime => ({
  allowedOrigins,
  evaluate: (_source, _context, host) =>
    host === undefined
      ? Effect.fail(
          new BrowserScriptError({ reason: "script host unavailable" }),
        )
      : evaluate(host).pipe(Effect.map((value) => ({ value, setCookies: [] }))),
});

const session = (
  calls: Array<Call>,
  respond: (url: string) => TlsResponse,
): TlsSession => ({
  id: "browser-test",
  request: (url, options) =>
    Effect.sync(() => {
      const requestUrl = typeof url === "string" ? url : url.url;
      calls.push({ url: requestUrl, options });
      return respond(requestUrl);
    }),
  webSocket: () => Effect.die("unused"),
  cookies: () => Effect.die("unused"),
  setCookies: () => Effect.die("unused"),
  scriptCookies: () => Effect.succeed(""),
  exportCookies: Effect.die("unused"),
  importCookies: () => Effect.die("unused"),
  bandwidth: Effect.succeed({ read: 0, written: 0 }),
  resetBandwidth: Effect.void,
  setProxy: () => Effect.die("unused"),
});

describe("browser layer", () => {
  it("applies strict-origin referrer policy", () => {
    const source = "https://user:secret@example.test/source?token=1#fragment";
    const referer = (headers: ReadonlyArray<readonly [string, string]>) =>
      headers.find(([name]) => name.toLowerCase() === "referer")?.[1];

    expect(
      referer(navigationHeaders([], "https://example.test/next", source)),
    ).toBe("https://example.test/source?token=1");
    expect(referer(xhrHeaders([], "https://other.test/api", source))).toBe(
      "https://example.test",
    );
    expect(
      referer(navigationHeaders([], "http://example.test/next", source)),
    ).toBeUndefined();
  });

  it.effect("applies fromSession identity headers and order", () => {
    const calls: Array<Call> = [];
    const browser = fromSession(
      session(calls, (url) => response(url, 204, "")),
      Chrome152Identity,
    );
    const userAgent = Chrome152Identity.headers.find(
      ([name]) => name === "user-agent",
    );

    return Effect.gen(function* () {
      yield* browser.get("https://example.test/api");
      expect(calls[0]?.options?.headers).toContainEqual(userAgent);
      expect(calls[0]?.options?.headerOrder).toEqual(
        Chrome152Identity.headerOrder,
      );
    });
  });

  it.effect(
    "stamps browser request kinds without manual Cookie headers",
    () => {
      const calls: Array<Call> = [];
      const browser = fromSession(
        session(calls, (url) => response(url, 204, "")),
        Chrome152Identity,
      );

      return Effect.gen(function* () {
        yield* browser.get("https://example.test/api", {
          referer: "https://example.test/page",
          origin: "https://example.test",
          headers: [["x-requested-with", "XMLHttpRequest"]],
        });
        expect(calls[0]?.options?.headers).toContainEqual([
          "sec-fetch-mode",
          "cors",
        ]);
        expect(calls[0]?.options?.headers).toContainEqual([
          "x-requested-with",
          "XMLHttpRequest",
        ]);
        expect(
          calls[0]?.options?.headers?.some(
            ([name]) => name.toLowerCase() === "cookie",
          ),
        ).toBe(false);
      });
    },
  );

  it.effect("only follows Location from redirect statuses", () => {
    let closed = 0;
    const calls: Array<Call> = [];
    const browser = fromSession(
      session(calls, (url) =>
        response(url, 200, "kept", [["Location", "/other"]], () => {
          closed += 1;
        }),
      ),
      Chrome152Identity,
    );

    return Effect.gen(function* () {
      const page = yield* browser.navigate("https://example.test/start");
      expect(page.body).toBe("kept");
      expect(calls).toHaveLength(1);
      expect(closed).toBe(0);
    });
  });

  it.effect(
    "does not navigate from JavaScript text or hidden form fields",
    () => {
      const calls: Array<Call> = [];
      const html =
        '<form><input type="hidden" id="hfRedirectURL" value="/unsupported"></form>' +
        '<script>if (false) { window.location = "/unsupported"; }</script>' +
        '<!-- window.location = "/comment"; -->' +
        '<noscript><script>window.location = "/noscript";</script></noscript>';
      const browser = fromSession(
        session(calls, (url) =>
          response(
            url,
            200,
            url.endsWith("/unsupported") ? "unexpected navigation" : html,
          ),
        ),
        Chrome152Identity,
      );

      return Effect.gen(function* () {
        const page = yield* browser.navigate("https://example.test/");
        expect(page.url).toBe("https://example.test/");
        expect(page.body).toBe(html);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ url: "https://example.test/" });
      });
    },
  );

  it.effect("closes a response when Location is invalid", () => {
    let closed = 0;
    const browser = fromSession(
      session([], (url) =>
        response(url, 302, "", [["Location", "javascript:alert(1)"]], () => {
          closed += 1;
        }),
      ),
      Chrome152Identity,
    );

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        browser.navigate("https://example.test/start"),
      );
      expect(error).toBeInstanceOf(BrowserSessionError);
      if (error._tag === "BrowserSessionError") {
        expect(error.kind).toBe("Redirect");
      }
      expect(closed).toBe(1);
    });
  });

  it.effect("follows Location and HTML redirects with a referer chain", () => {
    const calls: Array<Call> = [];
    const browser = fromSession(
      session(calls, (url) =>
        url.endsWith("/start")
          ? response(url, 302, "", [["Location", "/html"]])
          : url.endsWith("/html")
            ? response(
                url,
                200,
                '<meta http-equiv="refresh" content="0;url=/final">',
              )
            : response(url, 200, "final"),
      ),
      Chrome152Identity,
    );

    return Effect.gen(function* () {
      const page = yield* browser.navigate("https://example.test/start");
      expect(page.url).toBe("https://example.test/final");
      expect(page.body).toBe("final");
      expect(calls.map(({ url }) => url)).toEqual([
        "https://example.test/start",
        "https://example.test/html",
        "https://example.test/final",
      ]);
      expect(calls[1]?.options?.headers).toContainEqual([
        "referer",
        "https://example.test/start",
      ]);
      expect(calls[2]?.options?.headers).toContainEqual([
        "referer",
        "https://example.test/html",
      ]);
    });
  });

  it.effect(
    "surfaces an AWS WAF challenge and does not claim a 403 is solved",
    () => {
      const calls: Array<Call> = [];
      const browser = fromSession(
        session(calls, (url) =>
          response(url, 202, "challenge", [["x-amzn-waf-action", "challenge"]]),
        ),
        Chrome152Identity,
        {
          challengeHandler: () => Effect.succeedNone,
        },
      );

      return Effect.gen(function* () {
        const page = yield* browser.navigate("https://example.test/");
        expect(page.status).toBe(202);
        expect(page.challenge?.kind).toBe("AwsWaf");
        expect(calls).toHaveLength(1);
      });
    },
  );

  it.effect(
    "keeps a CloudFront 403 distinct from an explicit WAF challenge",
    () => {
      const calls: Array<Call> = [];
      const browser = fromSession(
        session(calls, (url) =>
          response(url, 403, "forbidden", [["server", "CloudFront"]]),
        ),
        Chrome152Identity,
      );

      return Effect.gen(function* () {
        const page = yield* browser.navigate("https://example.test/");
        expect(page.status).toBe(403);
        expect(page.challenge).toBeUndefined();
        expect(page.cloudFrontForbidden).toBe(true);
      });
    },
  );

  it.effect("does not charge challenge retries to redirect budget", () => {
    const calls: Array<Call> = [];
    const browser = fromSession(
      session(calls, (url) => {
        if (url.endsWith("/challenge")) {
          return response(url, 202, "challenge", [
            ["x-amzn-waf-action", "challenge"],
          ]);
        }
        const index = Number(/\/redirect-(\d+)$/.exec(url)?.[1]);
        return index < 15
          ? response(url, 302, "", [["Location", `/redirect-${index + 1}`]])
          : response(url, 200, "final");
      }),
      Chrome152Identity,
      {
        challengeHandler: () =>
          Effect.succeedSome({ url: "https://example.test/redirect-0" }),
      },
    );

    return Effect.gen(function* () {
      const page = yield* browser.navigate("https://example.test/challenge");
      expect(page.body).toBe("final");
      expect(calls).toHaveLength(17);
    });
  });

  it.effect("bounds challenge retries without a fake success response", () => {
    const calls: Array<Call> = [];
    const browser = fromSession(
      session(calls, (url) =>
        response(url, 202, "challenge", [["x-amzn-waf-action", "challenge"]]),
      ),
      Chrome152Identity,
      {
        challengeHandler: () =>
          Effect.succeedSome({ url: "https://example.test/" }),
      },
    );

    return Effect.gen(function* () {
      const page = yield* browser.navigate("https://example.test/");
      expect(page.status).toBe(202);
      expect(page.challenge?.kind).toBe("AwsWaf");
      expect(calls).toHaveLength(2);
    });
  });

  it.effect("rejects Cookie headers in the browser identity", () => {
    const calls: Array<Call> = [];
    const browser = fromSession(
      session(calls, (url) => response(url, 204, "")),
      { headers: [["Cookie", "sid=manual"]] },
    );

    return Effect.flip(browser.get("https://example.test/")).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(BrowserSessionError);
          if (error._tag === "BrowserSessionError") {
            expect(error.kind).toBe("CookieHeader");
          }
          expect(calls).toHaveLength(0);
        }),
      ),
    );
  });

  it.effect("rejects browser-owned Cookie headers", () => {
    const browser = fromSession(
      session([], (url) => response(url, 204, "")),
      Chrome152Identity,
    );

    return Effect.flip(
      browser.get("https://example.test/", {
        headers: [["Cookie", "sid=manual"]],
      }),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(BrowserSessionError);
          if (error._tag === "BrowserSessionError") {
            expect(error.kind).toBe("CookieHeader");
          }
        }),
      ),
    );
  });

  it.effect("reassembles fragmented script response bodies", () => {
    const calls: Array<Call> = [];
    const content = "fragment-".repeat(512);
    const chunks = Array.from(bodyBytes(content), (byte) =>
      Uint8Array.of(byte),
    );
    let scriptValue = "";
    const runtime = hostRuntime(["https://example.test"], (host) =>
      host
        .request({
          kind: "fetch",
          url: "https://example.test/asset",
          method: "GET",
          headers: [],
          body: null,
        })
        .pipe(Effect.map(({ body }) => body)),
    );
    const browser = fromSession(
      session(calls, (url) =>
        url.endsWith("/asset")
          ? {
              ...response(url, 200, content),
              stream: Stream.fromIterable(chunks),
            }
          : response(url, 202, "challenge", [
              ["x-amzn-waf-action", "challenge"],
            ]),
      ),
      Chrome152Identity,
      {
        scriptRuntime: runtime,
        challengeHandler: (_challenge, context) =>
          context.evaluate("read fragmented response").pipe(
            Effect.tap((value) => Effect.sync(() => (scriptValue = value))),
            Effect.flatMap(() => Effect.succeedNone),
          ),
      },
    );

    return Effect.gen(function* () {
      yield* browser.navigate("https://example.test/challenge");
      expect(scriptValue).toBe(content);
      expect(calls.filter(({ url }) => url.endsWith("/asset"))).toHaveLength(1);
    });
  });

  it.effect("enforces the script request quota", () => {
    const calls: Array<Call> = [];
    const runtime = hostRuntime(["https://example.test"], (host) =>
      Effect.gen(function* () {
        for (let index = 0; index < 9; index += 1) {
          yield* host.request({
            kind: "fetch",
            url: `https://example.test/${index}`,
            method: "GET",
            headers: [],
            body: null,
          });
        }
        return "unreachable";
      }),
    );
    const browser = fromSession(
      session(calls, (url) =>
        url.endsWith("/challenge")
          ? response(url, 202, "challenge", [
              ["x-amzn-waf-action", "challenge"],
            ])
          : response(url, 200, "ok"),
      ),
      Chrome152Identity,
      {
        scriptRuntime: runtime,
        challengeHandler: (_challenge, context) =>
          context
            .evaluate("exceed request quota")
            .pipe(Effect.flatMap(() => Effect.succeedNone)),
      },
    );

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        browser.navigate("https://example.test/challenge"),
      );
      expect(error).toBeInstanceOf(BrowserScriptError);
      if (error._tag === "BrowserScriptError") {
        expect(error.reason).toContain("8 requests");
      }
      expect(
        calls.filter(({ url }) => !url.endsWith("/challenge")),
      ).toHaveLength(8);
    });
  });

  it.effect("denies a redirect outside the script origin allowlist", () => {
    const calls: Array<Call> = [];
    let redirectClosed = 0;
    const runtime = hostRuntime(["https://example.test"], (host) =>
      host
        .request({
          kind: "fetch",
          url: "https://example.test/redirect",
          method: "GET",
          headers: [],
          body: null,
        })
        .pipe(Effect.map(({ body }) => body)),
    );
    const browser = fromSession(
      session(calls, (url) =>
        url.endsWith("/redirect")
          ? response(
              url,
              302,
              "",
              [["location", "https://blocked.test/target"]],
              () => (redirectClosed += 1),
            )
          : response(url, 202, "challenge", [
              ["x-amzn-waf-action", "challenge"],
            ]),
      ),
      Chrome152Identity,
      {
        scriptRuntime: runtime,
        challengeHandler: (_challenge, context) =>
          context
            .evaluate("follow redirect")
            .pipe(Effect.flatMap(() => Effect.succeedNone)),
      },
    );

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        browser.navigate("https://example.test/challenge"),
      );
      expect(error).toBeInstanceOf(BrowserScriptError);
      if (error._tag === "BrowserScriptError") {
        expect(error.reason).toContain("not allowed");
      }
      expect(calls).toHaveLength(2);
      expect(redirectClosed).toBe(1);
    });
  });

  it.effect("bounds an optional caller-supplied script runtime", () => {
    const runtime = {
      evaluate: (source: string) =>
        Effect.succeed({ value: source, setCookies: [] }),
    };

    return Effect.gen(function* () {
      expect((yield* runBoundedScript(runtime, "return 1")).value).toBe(
        "return 1",
      );
      const error = yield* Effect.flip(
        runBoundedScript(runtime, "x".repeat(64 * 1024 + 1)),
      );
      expect(error).toBeInstanceOf(BrowserScriptError);
      expect(error.reason).toContain("64 KiB");
    });
  });

  it.effect("runs the process-backed BrowserMock with only small globals", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(
        'document.cookie = "clearance=ok; Path=/"; document.cookie = "hidden=no; HttpOnly"; return `${document.cookie}|${typeof fetch}|${typeof process}`;',
        {
          url: "http://localhost/",
          cookie: "visible=yes",
          userAgent: "fixture",
        },
      );
      expect(result.value).toBe("visible=yes; clearance=ok|function|undefined");
      expect(result.setCookies).toEqual(["clearance=ok; Path=/"]);
      const unsupportedFetchCredentials = yield* runtime.evaluate(
        'try { await fetch("https://example.test/", { credentials: "include" }); return "accepted"; } catch (error) { return error.message; }',
      );
      expect(unsupportedFetchCredentials.value).toContain("credentials mode");
      const unsupportedXhrCredentials = yield* runtime.evaluate(
        'const xhr = new XMLHttpRequest(); try { xhr.withCredentials = true; return "accepted"; } catch (error) { return error.message; }',
      );
      expect(unsupportedXhrCredentials.value).toContain("withCredentials");
      const blocked = yield* Effect.flip(
        runtime.evaluate(
          'return this.constructor.constructor("return process")().pid;',
        ),
      );
      expect(blocked.reason).toContain("Code generation");
      const urlEscape = yield* Effect.flip(
        runtime.evaluate(
          `try { new URL("invalid"); } catch (error) { return error.constructor.constructor("return process")().version; }`,
        ),
      );
      expect(urlEscape.reason).toContain("Code generation");
      expect(urlEscape.reason).not.toContain(process.version);
      const typedArrayEscape = yield* Effect.flip(
        runtime.evaluate(
          `try { Uint8Array.from = (value) => value; new TextEncoder().encode("x"); } catch (error) { return error.constructor.constructor("return process")().version; }`,
        ),
      );
      expect(typedArrayEscape.reason).toContain("Code generation");
      expect(typedArrayEscape.reason).not.toContain(process.version);
      const functionError = yield* Effect.flip(
        runtime.evaluate("return Function('return 1')();"),
      );
      expect(functionError.reason).toContain("Code generation");
      const hidden = yield* runtime.evaluate(
        "return `${typeof __URL}|${typeof __cookieRead}|${typeof URL}|${typeof TextEncoder}|${typeof setTimeout}`;",
      );
      expect(hidden.value).toBe(
        "undefined|undefined|undefined|undefined|function",
      );
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.effect("dispatches context-local document and window events", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const events = yield* runtime.evaluate(`
        const order = [];
        const listener = (event) => order.push("document:" + event.type + ":" + (event.currentTarget === document) + ":" + event.isTrusted);
        const once = () => order.push("once");
        const removed = () => order.push("removed");
        document.addEventListener("synthetic", listener);
        document.addEventListener("synthetic", listener);
        document.addEventListener("synthetic", once, { once: true });
        document.addEventListener("synthetic", removed);
        document.removeEventListener("synthetic", removed);
        document.dispatchEvent(new Event("synthetic"));
        document.dispatchEvent(new Event("synthetic"));
        window.addEventListener("window-event", (event) => order.push("window:" + (event.target === window)));
        window.dispatchEvent(new Event("window-event"));
        document.addEventListener("capture-order", () => order.push("bubble"));
        document.addEventListener("capture-order", () => order.push("capture"), true);
        document.dispatchEvent(new Event("capture-order"));
        return order.join("|");
      `);
      expect(events.value).toBe(
        "document:synthetic:true:false|once|document:synthetic:true:false|window:true|capture|bubble",
      );
      const listenerError = yield* Effect.flip(
        runtime.evaluate(`
          document.addEventListener("listener-error", () => {
            throw new Error("event listener failed");
          });
          document.dispatchEvent(new Event("listener-error"));
          return "unreachable";
        `),
      );
      expect(listenerError).toBeInstanceOf(BrowserScriptError);
      expect(listenerError.reason).toContain("event listener failed");
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.live("bridges fetch, script loading, cookies, and timers", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      let cookie = "";
      const requests: Array<string> = [];
      const host: BrowserScriptHost = {
        request: (request) => {
          requests.push(`${request.kind}:${request.url}`);
          return Effect.succeed({
            status: 200,
            url: request.url,
            headers: [],
            body:
              request.kind === "script"
                ? 'globalThis.scriptLoaded = "yes";'
                : "payload",
            cookie,
          });
        },
        setCookie: (value) => {
          cookie = value.split(";", 1)[0] ?? "";
          return Effect.succeed(cookie);
        },
      };
      const result = yield* runtime.evaluate(
        'document.cookie = "clearance=ok; Path=/"; await document.loadScript("/script.js"); const body = await fetch("/data").then((response) => response.text()); return `${window.scriptLoaded}|${body}|${document.cookie}`;',
        {
          url: "https://allowed.test/page",
          cookie: "",
          userAgent: "fixture",
        },
        host,
      );
      expect(result.value).toBe("yes|payload|clearance=ok");
      expect(result.setCookies).toEqual([]);
      expect(requests).toEqual([
        "script:https://allowed.test/script.js",
        "fetch:https://allowed.test/data",
      ]);
      const blocked = yield* runtime.evaluate(
        'try { await fetch("https://blocked.test/data"); } catch (error) { return error.message; }',
        {
          url: "https://allowed.test/page",
          cookie: "",
          userAgent: "fixture",
        },
        host,
      );
      expect(blocked.value).toContain("not allowed");
      expect(requests).toHaveLength(2);
      const timer = yield* runtime.evaluate(
        'return await new Promise((resolve) => setTimeout(() => resolve("fired"), 5));',
      );
      expect(timer.value).toBe("fired");
      expect(
        (yield* runtime.evaluate(
          "return await new Promise((resolve) => { let ticks = 0; const id = setInterval(() => { if (++ticks === 2) { clearInterval(id); resolve(ticks); } }, 1); });",
        )).value,
      ).toBe("2");
    }).pipe(
      Effect.provide(
        BrowserMock.layer({ allowedOrigins: ["https://allowed.test"] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("does not overwrite a newer cookie with an in-flight fetch", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const staleRequestStarted = yield* Deferred.make<void>();
      const cookieWriteApplied = yield* Deferred.make<void>();
      const cookieSyncObserved = yield* Deferred.make<void>();
      const releaseStaleResponse = yield* Deferred.make<void>();
      let cookie = "session=old";
      const host: BrowserScriptHost = {
        request: (request) => {
          const responseCookie = cookie;
          if (request.url.endsWith("/stale")) {
            return Effect.gen(function* () {
              yield* Deferred.succeed(staleRequestStarted, undefined);
              yield* Deferred.await(releaseStaleResponse);
              return {
                status: 200,
                url: request.url,
                headers: [],
                body: "stale",
                cookie: responseCookie,
              };
            });
          }
          if (request.url.endsWith("/after-write")) {
            return Effect.gen(function* () {
              yield* Deferred.succeed(cookieSyncObserved, undefined);
              return {
                status: 200,
                url: request.url,
                headers: [],
                body: "after-write",
                cookie,
              };
            });
          }
          return Effect.die(`unexpected script request: ${request.url}`);
        },
        setCookie: (value) =>
          Effect.gen(function* () {
            yield* Deferred.await(staleRequestStarted);
            cookie = value.split(";", 1)[0] ?? "";
            yield* Deferred.succeed(cookieWriteApplied, undefined);
            return cookie;
          }),
      };
      const fiber = yield* runtime
        .evaluate(
          'const stale = fetch("/stale"); await Promise.resolve(); document.cookie = "session=new; Path=/"; await stale; await fetch("/after-write"); return document.cookie;',
          {
            url: "https://allowed.test/page",
            cookie,
            userAgent: "fixture",
          },
          host,
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(staleRequestStarted);
      yield* Deferred.await(cookieWriteApplied);
      yield* Deferred.succeed(releaseStaleResponse, undefined);
      yield* Deferred.await(cookieSyncObserved);
      expect((yield* Fiber.join(fiber)).value).toBe("session=new");
    }).pipe(
      Effect.provide(
        BrowserMock.layer({ allowedOrigins: ["https://allowed.test"] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("orders concurrent host cookie snapshots", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const staleRequestStarted = yield* Deferred.make<void>();
      const releaseStaleResponse = yield* Deferred.make<void>();
      let cookie = "sid=private";
      let activeRequests = 0;
      let maximumConcurrentRequests = 0;
      const host: BrowserScriptHost = {
        request: (request) =>
          Effect.gen(function* () {
            activeRequests += 1;
            maximumConcurrentRequests = Math.max(
              maximumConcurrentRequests,
              activeRequests,
            );
            if (request.url.endsWith("/stale")) {
              const responseCookie = cookie;
              yield* Deferred.succeed(staleRequestStarted, undefined);
              yield* Deferred.await(releaseStaleResponse);
              return {
                status: 200,
                url: request.url,
                headers: [],
                body: "stale",
                cookie: responseCookie,
              };
            }
            cookie = "sid=private; sid=root";
            return {
              status: 200,
              url: request.url,
              headers: [],
              body: "latest",
              cookie,
            };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeRequests -= 1;
              }),
            ),
          ),
        setCookie: () => Effect.succeed(cookie),
      };
      const fiber = yield* runtime
        .evaluate(
          'const stale = fetch("/stale"); const latest = fetch("/latest"); await Promise.all([stale, latest]); return document.cookie;',
          {
            url: "https://allowed.test/page",
            cookie,
            userAgent: "fixture",
          },
          host,
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(staleRequestStarted);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseStaleResponse, undefined);
      expect((yield* Fiber.join(fiber)).value).toBe("sid=private; sid=root");
      expect(maximumConcurrentRequests).toBe(1);
    }).pipe(
      Effect.provide(
        BrowserMock.layer({ allowedOrigins: ["https://allowed.test"] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live(
    "preserves duplicate authoritative cookies during pending writes",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const writeStarted = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const cookies = "sid=private; sid=root";
        const host: BrowserScriptHost = {
          request: () => Effect.die("unused"),
          setCookie: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(writeStarted, undefined);
              yield* Deferred.await(releaseWrite);
              return cookies;
            }),
        };
        const fiber = yield* runtime
          .evaluate(
            'document.cookie = "sid=changed; Path=/private"; return document.cookie;',
            {
              url: "https://allowed.test/page",
              cookie: cookies,
              userAgent: "fixture",
            },
            host,
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(writeStarted);
        yield* Deferred.succeed(releaseWrite, undefined);
        expect((yield* Fiber.join(fiber)).value).toBe(cookies);
      }).pipe(
        Effect.provide(
          BrowserMock.layer({ allowedOrigins: ["https://allowed.test"] }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
  );

  it.live(
    "keeps rejected cookie writes out of authoritative script state",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        let writes = 0;
        const host: BrowserScriptHost = {
          request: (request) =>
            Effect.succeed({
              status: 200,
              url: request.url,
              headers: [],
              body: "ok",
              cookie: "session=stored",
            }),
          setCookie: () =>
            Effect.sync(() => {
              writes += 1;
              return "session=stored";
            }),
        };
        const result = yield* runtime.evaluate(
          'const before = document.cookie; document.cookie = "rejected=shown; Domain=other.test; Path=/"; const immediate = document.cookie; await fetch("/data"); return [before, immediate, document.cookie].join("|");',
          {
            url: "https://allowed.test/page",
            cookie: "session=stored",
            userAgent: "fixture",
          },
          host,
        );
        expect(result.value).toBe(
          "session=stored|session=stored|session=stored",
        );
        expect(result.setCookies).toEqual([]);
        expect(writes).toBe(1);
      }).pipe(
        Effect.provide(
          BrowserMock.layer({ allowedOrigins: ["https://allowed.test"] }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
  );

  it.live(
    "terminates timed-out scripts and cleans up before the next run",
    () =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const timeoutContext = yield* Layer.buildWithScope(
          BrowserMock.layer({ timeoutMs: 100 }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          scope,
        );
        const timeoutRuntime = Context.get(timeoutContext, BrowserMock);
        const error = yield* Effect.flip(
          timeoutRuntime.evaluate("while (true) {}"),
        );
        expect(error.reason).toContain("terminated");

        const runtimeContext = yield* Layer.buildWithScope(
          BrowserMock.layer({ timeoutMs: 2_000 }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          scope,
        );
        const runtime = Context.get(runtimeContext, BrowserMock);
        const result = yield* runtime.evaluate('return "after-timeout";');
        expect(result.value).toBe("after-timeout");
      }),
  );
});
