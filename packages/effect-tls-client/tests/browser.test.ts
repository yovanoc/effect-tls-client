import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import * as Cookies from "effect/unstable/http/Cookies";
import type { TlsResponse, TlsSession } from "../src/TlsClient.js";
import {
  BrowserSessionError,
  BrowserScriptError,
  Chrome152Identity,
  fromSession,
  navigationHeaders,
  runBoundedScript,
  xhrHeaders,
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

  it.effect("bounds an optional caller-supplied script runtime", () => {
    const runtime = {
      evaluate: (source: string) => Effect.succeed(source),
    };

    return Effect.gen(function* () {
      expect(yield* runBoundedScript(runtime, "return 1")).toBe("return 1");
      const error = yield* Effect.flip(
        runBoundedScript(runtime, "x".repeat(64 * 1024 + 1)),
      );
      expect(error).toBeInstanceOf(BrowserScriptError);
      expect(error.reason).toContain("64 KiB");
    });
  });
});
