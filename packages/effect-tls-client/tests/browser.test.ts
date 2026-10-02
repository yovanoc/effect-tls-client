import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Stream,
} from "effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { NodeServices } from "@effect/platform-node";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Cookies from "effect/unstable/http/Cookies";
import type { TlsResponse, TlsSession } from "../src/TlsClient.js";
import {
  BrowserMock,
  BrowserSessionError,
  BrowserScriptError,
  Chrome152Identity,
  fromSession,
  navigationHeaders,
  reviewedChallengeHandler,
  runBoundedScript,
  xhrHeaders,
  type BrowserHandlers,
  type BrowserFrameReviewer,
  type FrameLoadResult,
  type BrowserScriptHost,
  type BrowserScriptRuntime,
  type ReviewedChallengeOptions,
} from "../src/browser/index.js";

const bodyBytes = (body: string): Uint8Array => new TextEncoder().encode(body);

const multipartRequestBytes = (
  request: Parameters<BrowserScriptHost["request"]>[0],
): Uint8Array => {
  if (request.bodyBytes === null) {
    throw new TypeError("request does not contain raw multipart bytes");
  }
  return new Uint8Array(request.bodyBytes);
};

const concatBytes = (...chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

type Call = {
  readonly url: string;
  readonly options: Parameters<TlsSession["request"]>[1];
};

const cryptoRandomValuesSource = `
  const localTypeError = (value) => {
    try {
      crypto.getRandomValues(value);
      return false;
    } catch (error) {
      return error instanceof TypeError && error.constructor === TypeError &&
        Object.getPrototypeOf(error) === TypeError.prototype;
    }
  };
  const blocked = (probe) => {
    try {
      probe();
      return false;
    } catch (error) {
      return error instanceof ReferenceError && error.message === "process is not defined";
    }
  };
  const changed = (array, fill) => {
    array.fill(fill);
    return crypto.getRandomValues(array) === array &&
      Array.from(array).some((value) => value !== fill);
  };
  const supported = [
    changed(new Int8Array(32), -1),
    changed(new Uint8Array(32), 255),
    changed(new Uint8ClampedArray(32), 255),
    changed(new Int16Array(32), -1),
    changed(new Uint16Array(32), 65535),
    changed(new Int32Array(32), -1),
    changed(new Uint32Array(32), 4294967295),
    changed(new BigInt64Array(32), -1n),
    changed(new BigUint64Array(32), 18446744073709551615n),
  ];
  const floatRejected = localTypeError(new Float32Array(1));
  const dataViewRejected = localTypeError(new DataView(new ArrayBuffer(4)));
  let quotaRejected = false;
  try {
    crypto.getRandomValues(new Uint8Array(65537));
  } catch (error) {
    quotaRejected = error.name === "QuotaExceededError" &&
      error instanceof Error && error.constructor === Error &&
      Object.getPrototypeOf(error) === Error.prototype;
  }
  const atLimit = new Uint8Array(65536);
  const limitAccepted = crypto.getRandomValues(atLimit) === atLimit;
  const backing = new Uint8Array(48);
  backing.fill(0xa5);
  const view = new Uint16Array(backing.buffer, 8, 16);
  const offsetRespected = crypto.getRandomValues(view) === view &&
    backing.subarray(0, 8).every((byte) => byte === 0xa5) &&
    backing.subarray(8, 40).some((byte) => byte !== 0xa5) &&
    backing.subarray(40).every((byte) => byte === 0xa5);
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const IntrinsicUint8Array = Uint8Array;
  Object.getPrototypeOf(IntrinsicUint8Array.prototype).set = () => {
    throw new Error("mutated set was used");
  };
  ArrayBuffer.isView = () => false;
  Uint8Array = () => { throw new Error("mutated constructor was used"); };
  const afterMutation = new IntrinsicUint8Array(32).fill(255);
  const capturedIntrinsicsWork = crypto.getRandomValues(afterMutation) === afterMutation &&
    Array.from(afterMutation).some((byte) => byte !== 255);
  return [
    crypto === window.crypto,
    supported.every(Boolean),
    floatRejected,
    dataViewRejected,
    quotaRejected,
    limitAccepted,
    offsetRespected,
    bytes instanceof IntrinsicUint8Array,
    blocked(() => crypto.getRandomValues.constructor("return process")()),
    blocked(() => crypto.constructor.constructor("return process")()),
    capturedIntrinsicsWork,
  ].join("|");
`;

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

const recordingScriptHost = (
  requests: Parameters<BrowserScriptHost["request"]>[0][],
): BrowserScriptHost => ({
  request: (input) =>
    Effect.sync(() => {
      requests.push(input);
      return {
        body: "ok",
        cookie: "",
        headers: [],
        status: 200,
        url: input.url,
      };
    }),
  setCookie: () => Effect.succeed(""),
});

const SCRIPT_URL_INPUT_LIMIT = 8_192;

const session = (
  calls: Array<Call>,
  respond: (url: string) => TlsResponse,
  readCookies: TlsSession["cookies"] = () => Effect.die("unused"),
): TlsSession => ({
  id: "browser-test",
  request: (url, options) =>
    Effect.sync(() => {
      const requestUrl = typeof url === "string" ? url : url.url;
      calls.push({ url: requestUrl, options });
      return respond(requestUrl);
    }),
  webSocket: () => Effect.die("unused"),
  cookies: readCookies,
  setCookies: () => Effect.die("unused"),
  scriptCookies: () => Effect.succeed(""),
  exportCookies: Effect.die("unused"),
  importCookies: () => Effect.die("unused"),
  bandwidth: Effect.succeed({ read: 0, written: 0 }),
  resetBandwidth: Effect.void,
  setProxy: () => Effect.die("unused"),
});

const cookieReader = (
  values: ReadonlyArray<Cookies.Cookies>,
  urls: Array<string>,
): TlsSession["cookies"] => {
  let index = 0;
  return (url) =>
    Effect.sync(() => {
      urls.push(url);
      return values[index++] ?? Cookies.empty;
    });
};

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
    "passes the sanitized navigation referrer into challenge scripts",
    () => {
      const calls: Call[] = [];
      let scriptReferrer = "";
      let scriptLanguages: ReadonlyArray<string> | undefined;
      const runtime: BrowserScriptRuntime = {
        evaluate: (_source, context) =>
          Effect.sync(() => {
            scriptReferrer = context?.referrer ?? "";
            scriptLanguages = context?.languages;
            return { value: "ok", setCookies: [] };
          }),
      };
      const browser = fromSession(
        session(calls, (url) =>
          response(url, 202, "challenge", [["x-amzn-waf-action", "challenge"]]),
        ),
        Chrome152Identity,
        {
          scriptRuntime: runtime,
          challengeHandler: (_challenge, context) =>
            context
              .evaluate("document.referrer")
              .pipe(Effect.flatMap(() => Effect.succeedNone)),
        },
      );

      return Effect.gen(function* () {
        const page = yield* browser.navigate("https://auth.example.test/", {
          referer: "https://source.example.test/private?secret=1",
        });
        expect(page.status).toBe(202);
        expect(scriptReferrer).toBe("https://source.example.test");
        expect(scriptLanguages).toEqual(["fr-FR", "fr", "en-US", "en"]);
        expect(calls[0]?.options?.headers).toContainEqual([
          "referer",
          "https://source.example.test",
        ]);
        yield* page.close;
      });
    },
  );

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

  it.effect("stamps the initiating origin on script POST requests", () => {
    const calls: Call[] = [],
      runtime = hostRuntime(["https://challenge.example.test"], (host) =>
        host
          .request({
            body: "payload",
            bodyBytes: null,
            headers: [],
            kind: "fetch",
            method: "POST",
            url: "https://challenge.example.test/solution",
          })
          .pipe(Effect.as("submitted")),
      ),
      browser = fromSession(
        session(calls, (url) =>
          response(url, 202, "challenge", [["x-amzn-waf-action", "challenge"]]),
        ),
        Chrome152Identity,
        {
          challengeHandler: (_challenge, context) =>
            context
              .evaluate("submit")
              .pipe(Effect.flatMap(() => Effect.succeedNone)),
          scriptRuntime: runtime,
        },
      );

    return Effect.gen(function* originHeaderTest() {
      const page = yield* browser.navigate("https://example.test/challenge"),
        submit = calls.find(
          (call) => call.url === "https://challenge.example.test/solution",
        );
      yield* page.close;
      assert.ok(submit);
      assert.ok(submit.options);
      expect(submit.options.headers).toContainEqual([
        "origin",
        "https://example.test",
      ]);
    });
  });

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

  it.effect("does not evaluate scripts without a challenge handler", () => {
    const calls: Array<Call> = [];
    let evaluated = 0;
    const browser = fromSession(
      session(calls, (url) =>
        response(url, 202, "challenge", [["x-amzn-waf-action", "challenge"]]),
      ),
      Chrome152Identity,
      {
        scriptRuntime: hostRuntime([], () =>
          Effect.sync(() => {
            evaluated += 1;
            return "unused";
          }),
        ),
      },
    );

    return Effect.gen(function* () {
      const page = yield* browser.navigate("https://example.test/");
      expect(page.challenge?.kind).toBe("AwsWaf");
      expect(evaluated).toBe(0);
      expect(calls).toHaveLength(1);
      yield* page.close;
    });
  });

  it.effect("fails without a runtime and does not retry", () => {
    const calls: Array<Call> = [];
    const cookieUrls: Array<string> = [];
    const url = "https://example.test/";
    const browser = fromSession(
      session(
        calls,
        (requestUrl) =>
          response(requestUrl, 202, "challenge", [
            ["x-amzn-waf-action", "challenge"],
          ]),
        cookieReader(
          [Cookies.fromSetCookie("clearance=before; Path=/")],
          cookieUrls,
        ),
      ),
      Chrome152Identity,
      {
        challengeHandler: reviewedChallengeHandler({
          source: "solve challenge",
          cookieNames: ["clearance"],
        }),
      },
    );

    return Effect.gen(function* () {
      const error = yield* Effect.flip(browser.navigate(url));
      expect(error).toBeInstanceOf(BrowserScriptError);
      if (error._tag === "BrowserScriptError") {
        expect(error.reason).toBe("script runtime unavailable");
      }
      expect(calls.map(({ url: requestUrl }) => requestUrl)).toEqual([url]);
      expect(cookieUrls).toEqual([url]);
    });
  });

  it.effect("rejects invalid reviewed challenge options as Config", () => {
    const emptyCookieNames: ReviewedChallengeOptions = {
      source: "solve challenge",
      cookieNames: ["clearance"],
    };
    const nonStringSource: ReviewedChallengeOptions = {
      source: "solve challenge",
      cookieNames: ["clearance"],
    };
    // Model JavaScript callers bypassing the compile-time type without casts.
    Reflect.set(emptyCookieNames, "cookieNames", []);
    Reflect.set(nonStringSource, "source", 42);

    return Effect.gen(function* () {
      for (const options of [emptyCookieNames, nonStringSource]) {
        const calls: Array<Call> = [];
        let evaluated = 0;
        let closed = 0;
        const browser = fromSession(
          session(calls, (url) =>
            response(
              url,
              202,
              "challenge",
              [["x-amzn-waf-action", "challenge"]],
              () => {
                closed += 1;
              },
            ),
          ),
          Chrome152Identity,
          {
            challengeHandler: reviewedChallengeHandler(options),
            scriptRuntime: hostRuntime([], () =>
              Effect.sync(() => {
                evaluated += 1;
                return "unused";
              }),
            ),
          },
        );
        const error = yield* Effect.flip(
          browser.navigate("https://example.test/"),
        );

        expect(error).toBeInstanceOf(BrowserSessionError);
        if (error._tag === "BrowserSessionError") {
          expect(error.kind).toBe("Config");
        }
        expect(evaluated).toBe(0);
        expect(calls).toHaveLength(1);
        expect(closed).toBe(1);
      }
    });
  });

  it.effect("retries the same URL after configured cookies change", () => {
    const calls: Array<Call> = [];
    const cookieUrls: Array<string> = [];
    const scriptSources: Array<string> = [];
    let evaluated = false;
    const url = "https://example.test/";
    const options: ReviewedChallengeOptions = {
      source: "solve challenge",
      cookieNames: ["clearance"],
    };
    const browser = fromSession(
      session(
        calls,
        (requestUrl) =>
          calls.length === 1
            ? response(requestUrl, 202, "challenge", [
                ["x-amzn-waf-action", "challenge"],
              ])
            : response(requestUrl, 200, "final"),
        (requestUrl) =>
          Effect.sync(() => {
            cookieUrls.push(requestUrl);
            return Cookies.fromSetCookie(
              `clearance=${evaluated ? "after" : "before"}; Path=/`,
            );
          }),
      ),
      Chrome152Identity,
      {
        challengeHandler: reviewedChallengeHandler(options),
        scriptRuntime: {
          evaluate: (source) =>
            Effect.sync(() => {
              scriptSources.push(source);
              evaluated = true;
              return { value: "evaluated", setCookies: [] };
            }),
        },
      },
    );

    return Effect.gen(function* () {
      const page = yield* browser.navigate(url);
      expect(page.status).toBe(200);
      expect(page.body).toBe("final");
      expect(calls.map(({ url: requestUrl }) => requestUrl)).toEqual([
        url,
        url,
      ]);
      expect(cookieUrls).toEqual([url, url]);
      expect(scriptSources).toEqual([options.source]);
      yield* page.close;
    });
  });

  it.effect(
    "declines missing, empty, unchanged, or incomplete cookie changes",
    () => {
      const cases: ReadonlyArray<{
        readonly cookieNames: ReviewedChallengeOptions["cookieNames"];
        readonly before: Cookies.Cookies;
        readonly after: Cookies.Cookies;
      }> = [
        {
          cookieNames: ["clearance"],
          before: Cookies.fromSetCookie("clearance=before; Path=/"),
          after: Cookies.empty,
        },
        {
          cookieNames: ["clearance"],
          before: Cookies.fromSetCookie("clearance=before; Path=/"),
          after: Cookies.fromSetCookie("clearance=; Path=/"),
        },
        {
          cookieNames: ["clearance"],
          before: Cookies.fromSetCookie("clearance=same; Path=/"),
          after: Cookies.fromSetCookie("clearance=same; Path=/"),
        },
        {
          cookieNames: ["clearance", "device"],
          before: Cookies.fromSetCookie([
            "clearance=before; Path=/",
            "device=before; Path=/",
          ]),
          after: Cookies.fromSetCookie("clearance=changed; Path=/"),
        },
      ];

      return Effect.gen(function* () {
        for (const testCase of cases) {
          const calls: Array<Call> = [];
          const cookieUrls: Array<string> = [];
          let evaluated = 0;
          const url = "https://example.test/";
          const browser = fromSession(
            session(
              calls,
              (requestUrl) =>
                response(requestUrl, 202, "challenge", [
                  ["x-amzn-waf-action", "challenge"],
                ]),
              cookieReader([testCase.before, testCase.after], cookieUrls),
            ),
            Chrome152Identity,
            {
              challengeHandler: reviewedChallengeHandler({
                source: "solve challenge",
                cookieNames: testCase.cookieNames,
              }),
              scriptRuntime: hostRuntime([], () =>
                Effect.sync(() => {
                  evaluated += 1;
                  return "evaluated";
                }),
              ),
            },
          );
          const page = yield* browser.navigate(url);

          expect(page.status).toBe(202);
          expect(page.challenge?.kind).toBe("AwsWaf");
          expect(evaluated).toBe(1);
          expect(calls.map(({ url: requestUrl }) => requestUrl)).toEqual([url]);
          expect(cookieUrls).toEqual([url, url]);
          yield* page.close;
        }
      });
    },
  );

  it.effect(
    "closes the challenge response when script evaluation rejects",
    () => {
      const calls: Array<Call> = [];
      const cookieUrls: Array<string> = [];
      let closed = 0;
      const browser = fromSession(
        session(
          calls,
          (url) =>
            response(
              url,
              202,
              "challenge",
              [["x-amzn-waf-action", "challenge"]],
              () => {
                closed += 1;
              },
            ),
          cookieReader(
            [Cookies.fromSetCookie("clearance=before; Path=/")],
            cookieUrls,
          ),
        ),
        Chrome152Identity,
        {
          challengeHandler: reviewedChallengeHandler({
            source: "solve challenge",
            cookieNames: ["clearance"],
          }),
          scriptRuntime: {
            evaluate: () =>
              Effect.fail(
                new BrowserScriptError({ reason: "evaluation failed" }),
              ),
          },
        },
      );

      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          browser.navigate("https://example.test/"),
        );
        expect(error).toBeInstanceOf(BrowserScriptError);
        if (error._tag === "BrowserScriptError") {
          expect(error.reason).toBe("evaluation failed");
        }
        expect(calls).toHaveLength(1);
        expect(cookieUrls).toHaveLength(1);
        expect(closed).toBe(1);
      });
    },
  );

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
          bodyBytes: null,
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
            bodyBytes: null,
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
          bodyBytes: null,
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

  it.live(
    "supports direct eval and Function in classic root and external scripts",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const source = `
        var rootValue = 3;
        eval("var evalGlobal = 4; rootValue += evalGlobal;");
        const generated = Function("return rootValue + evalGlobal")();
        const script = document.createElement("script"); script.src = "/authored.js";
        const loaded = new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; });
        document.head.appendChild(script);
        loaded.then(() => [window.rootValue, window.evalGlobal, generated,
          window.externalGlobal, window.externalEval, window.externalResult,
          Function("var functionLocal = 1; return typeof functionLocal")(),
          typeof window.functionLocal].join("|"));
      `;
        const host: BrowserScriptHost = {
          setCookie: () => Effect.succeed(""),
          request: (input) =>
            Effect.succeed({
              status: 200,
              url: input.url,
              headers: [],
              cookie: "",
              body: 'var externalGlobal = rootValue; eval("var externalEval = 5"); window.externalResult = Function("return externalGlobal + externalEval")();',
            }),
        };
        const result = yield* runBoundedScript(
          runtime,
          source,
          {
            url: "https://allowed.test/page",
            cookie: "",
            userAgent: "fixture",
          },
          host,
          "classic",
        );
        expect(result.value).toBe("7|4|11|7|5|12|number|undefined");
      }).pipe(
        Effect.provide(
          BrowserMock.layer({ allowedOrigins: ["https://allowed.test"] }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
  );

  it.live(
    "keeps Node globals unavailable through guest-reachable constructors",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(`
        const key = await crypto.subtle.importKey("raw", new Uint8Array(16), { name: "AES-GCM" }, false, ["encrypt"]);
        const output = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, new Uint8Array(0));
        const script = document.createElement("script");
        const frame = document.createElement("iframe");
        const reader = new FileReader();
        const event = new Event("authored");
        const objects = [globalThis, window, document, crypto, key, key.algorithm, output,
          new Uint8Array(output), Promise.resolve(key), new URL("https://allowed.test"),
          new URLSearchParams("a=b"), new TextEncoder(), new XMLHttpRequest(),
          new Headers(), new Request("/authored"), new Response("authored"),
          new Blob(["authored"]), new FormData(), reader, event, script, frame,
          document.getElementsByTagName("head"), document.getElementsByTagName("script")];
        const failures = [];
        const seen = new Set();
        const visit = (value) => {
          if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
          seen.add(value);
          if (typeof value === "function") {
            try {
              if (value.constructor.constructor("return typeof process === 'undefined' && typeof require === 'undefined' && typeof Buffer === 'undefined'")() !== true) failures.push("host constructor");
            } catch (error) { failures.push(error.name); }
          }
          visit(Object.getPrototypeOf(value));
          for (const property of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, property);
            visit(descriptor.value); visit(descriptor.get); visit(descriptor.set);
          }
        };
        for (const value of objects) visit(value);
        window.addEventListener("authored", (callbackEvent) => { visit(callbackEvent); visit(callbackEvent.target); });
        window.dispatchEvent(event);
        await new Promise((resolve) => setTimeout(() => { visit(resolve); resolve(); }, 0));
        return JSON.stringify(failures);
      `);
        expect(result.value).toBe("[]");
      }).pipe(
        Effect.provide(
          BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
  );

  it.live("bounds generated code by the VM deadline", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const error = yield* runtime
        .evaluate("return Function('while (true) {}')();")
        .pipe(Effect.flip);
      expect(error.reason).toMatch(/terminated|timed out|timeout/i);
    }).pipe(
      Effect.provide(
        BrowserMock.layer({ timeoutMs: 100 }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

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
      const referrer = yield* runtime.evaluate("return document.referrer;", {
        url: "http://localhost/",
        cookie: "",
        userAgent: "fixture",
        referrer: "https://source.example.test/page",
      });
      expect(referrer.value).toBe("https://source.example.test/page");
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
      expect(blocked.reason).toContain("process is not defined");
      const urlEscape = yield* Effect.flip(
        runtime.evaluate(
          `try { new URL("invalid"); } catch (error) { return error.constructor.constructor("return process")().version; }`,
        ),
      );
      expect(urlEscape.reason).toContain("process is not defined");
      expect(urlEscape.reason).not.toContain(process.version);
      const typedArrayMutation = yield* runtime.evaluate(
        `Uint8Array.from = (value) => value; return Array.from(new TextEncoder().encode("x")).join(",");`,
      );
      expect(typedArrayMutation.value).toBe("120");
      const dynamicCode = yield* runtime.evaluate(
        'return `${eval("1 + 1")}|${Function("return 1")()}`;',
      );
      expect(dynamicCode.value).toBe("2|1");
      const hidden = yield* runtime.evaluate(
        "return `${typeof __URL}|${typeof __cookieRead}|${typeof __randomBytes}|${typeof URL}|${typeof TextEncoder}|${typeof setTimeout}`;",
      );
      expect(hidden.value).toBe(
        "undefined|undefined|undefined|function|function|function",
      );
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.effect(
    "rejects oversized UTF-8 language startup input before spawning",
    () => {
      const controlLimitBytes = 128 * 1024;
      const source = 'return "unused";';
      const url = "http://localhost/";
      const cookie = "";
      const userAgent = "fixture";
      const language = "☃".repeat(44_000);
      const languages = [language];
      const preliminaryCodeUnits =
        source.length +
        url.length +
        cookie.length +
        userAgent.length +
        language.length;
      const serializedStartLineBytes =
        new TextEncoder().encode(
          JSON.stringify({
            type: "start",
            source,
            url,
            cookie,
            userAgent,
            languages,
            referrer: "",
            authoritativeCookies: false,
          }),
        ).byteLength + 1;
      let spawnCount = 0;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "process",
              method: "spawn",
            }),
          );
        }),
      );

      return Effect.gen(function* () {
        expect(preliminaryCodeUnits).toBeLessThan(controlLimitBytes);
        expect(serializedStartLineBytes).toBeGreaterThan(controlLimitBytes);
        const runtime = yield* BrowserMock;
        const error = yield* Effect.flip(
          runtime.evaluate(source, { url, cookie, userAgent, languages }),
        );
        expect(error).toBeInstanceOf(BrowserScriptError);
        expect(error.reason).toBe(
          "script IPC start input exceeds its 128 KiB limit",
        );
        expect(spawnCount).toBe(0);
      }).pipe(
        Effect.provide(BrowserMock.layer().pipe(Layer.provide(spawnerLayer))),
      );
    },
  );

  it.effect("passes languages through BrowserMock and defaults to en-US", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const source =
        'return `${navigator.language}|${navigator.languages.join(",")}|${Object.isFrozen(navigator.languages)}|${typeof __languages}`;';
      const explicit = yield* runtime.evaluate(source, {
        url: "http://localhost/",
        cookie: "",
        userAgent: "fixture",
        languages: ["fr-FR", "fr", "en-US", "en"],
      });
      expect(explicit.value).toBe("fr-FR|fr-FR,fr,en-US,en|true|undefined");

      const fallback = yield* runtime.evaluate(source, {
        url: "http://localhost/",
        cookie: "",
        userAgent: "fixture",
      });
      expect(fallback.value).toBe("en-US|en-US|true|undefined");
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.layer(BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)), {
    excludeTestServices: true,
  })("context-local URL", ({ effect: testEffect }) => {
    testEffect(
      "exposes URL-derived read-only location and secure-context state",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const locationSnapshot = Schema.fromJsonString(
            Schema.Struct({
              href: Schema.String,
              origin: Schema.String,
              protocol: Schema.String,
              host: Schema.String,
              hostname: Schema.String,
              port: Schema.String,
              pathname: Schema.String,
              search: Schema.String,
              hash: Schema.String,
              same: Schema.Boolean,
              frozen: Schema.Boolean,
              locationWritable: Schema.Boolean,
              documentLocationWritable: Schema.Boolean,
              isSecureContext: Schema.Boolean,
              isSecureContextWritable: Schema.Boolean,
            }),
          );
          const decodeLocation = (value: string) =>
            Schema.decodeEffect(locationSnapshot)(value);
          const script = `
          const location = window.location;
          try { location.href = "https://changed.example/"; } catch {}
          try { location.pathname = "/changed"; } catch {}
          try { document.location = {}; } catch {}
          try { window.location = {}; } catch {}
          try { window.isSecureContext = false; } catch {}
          return JSON.stringify({
            href: document.location.href,
            origin: location.origin,
            protocol: location.protocol,
            host: location.host,
            hostname: location.hostname,
            port: location.port,
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            same: window.location === document.location,
            frozen: Object.isFrozen(location),
            locationWritable: Object.getOwnPropertyDescriptor(window, "location").writable,
            documentLocationWritable: Object.getOwnPropertyDescriptor(document, "location").writable,
            isSecureContext: window.isSecureContext,
            isSecureContextWritable: Object.getOwnPropertyDescriptor(window, "isSecureContext").writable,
          });
        `;
          const evaluate = (url: string) =>
            runtime.evaluate(script, { url, cookie: "", userAgent: "fixture" });
          const https = yield* evaluate(
            "https://example.test:8443/path?q=one#frag",
          );
          const httpsLocation = yield* decodeLocation(https.value);
          expect(httpsLocation).toEqual({
            href: "https://example.test:8443/path?q=one#frag",
            origin: "https://example.test:8443",
            protocol: "https:",
            host: "example.test:8443",
            hostname: "example.test",
            port: "8443",
            pathname: "/path",
            search: "?q=one",
            hash: "#frag",
            same: true,
            frozen: true,
            locationWritable: false,
            documentLocationWritable: false,
            isSecureContext: true,
            isSecureContextWritable: false,
          });

          const http = yield* evaluate(
            "http://example.test:8080/path?q=two#part",
          );
          const httpLocation = yield* decodeLocation(http.value);
          expect(httpLocation.isSecureContext).toBe(false);
          for (const url of [
            "http://localhost/",
            "http://localhost./",
            "http://service.localhost/",
            "http://127.10.1.2/",
            "http://[::1]/",
          ]) {
            const loopback = yield* evaluate(url);
            const loopbackLocation = yield* decodeLocation(loopback.value);
            expect(loopbackLocation.isSecureContext).toBe(true);
          }
          for (const url of [
            "http://127.example.test/",
            "http://localhost.evil.test/",
            "http://evillocalhost/",
            "http://[::2]/",
            "http://[::ffff:7f00:1]/",
            "http://localhost../",
          ]) {
            const nonLoopback = yield* evaluate(url);
            const nonLoopbackLocation = yield* decodeLocation(
              nonLoopback.value,
            );
            expect(nonLoopbackLocation.isSecureContext).toBe(false);
          }

          const longUrl = `https://example.test/${"x".repeat(9_000)}?q=${"y".repeat(9_000)}`;
          const longPage = yield* runtime.evaluate(
            `return JSON.stringify({ href: window.location.href.length, path: window.location.pathname.length, search: window.location.search.length });`,
            { url: longUrl, cookie: "", userAgent: "fixture" },
          );
          const longPageLocation = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                href: Schema.Finite,
                path: Schema.Finite,
                search: Schema.Finite,
              }),
            ),
          )(longPage.value);
          expect(longPageLocation).toEqual({
            href: longUrl.length,
            path: 9_001,
            search: 9_003,
          });
        }),
    );

    testEffect("provides bounded, read-only URL APIs", () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(`
          const url = new URL("../next?query=one+two&query=%2B#part", "https://EXAMPLE.test:443/base/path");
          const nonDefaultPort = new URL("/asset", "http://example.test:8080/base/");
          const params = new URLSearchParams(url.search);
          const localTypeError = (error) => error instanceof TypeError && error.constructor === TypeError &&
            Object.getPrototypeOf(error) === TypeError.prototype;
          const blocked = (value) => {
            try { value.constructor.constructor("return process")(); return false; }
            catch (error) { return error instanceof ReferenceError && error.message === "process is not defined"; }
          };
          let urlWriteRejected = false;
          try { url.pathname = "/changed"; } catch (error) { urlWriteRejected = localTypeError(error); }
          let paramsWriteRejected = false;
          try { params.set("query", "changed"); } catch (error) { paramsWriteRejected = localTypeError(error); }
          let invalidIsLocal = false;
          try { new URL("http://["); } catch (error) { invalidIsLocal = localTypeError(error) && error.message === "Invalid URL" && blocked(error); }
          let inputQuotaRejected = false;
          try { new URL("x".repeat(8193), "https://example.test/"); }
          catch (error) { inputQuotaRejected = localTypeError(error); }
          let resultQuotaRejected = false;
          try { new URL("/" + String.fromCharCode(0x800).repeat(8180), "https://a/"); }
          catch (error) { resultQuotaRejected = localTypeError(error); }
          const fields = [url.href, url.origin, url.protocol, url.host, url.hostname, url.port, url.pathname, url.search, url.hash, url.toString()].join("~");
          const paramsView = [params.get("query"), params.get("missing") === null].join("~");
          return [
            fields,
            url.href.startsWith("https://example.test/"),
            [nonDefaultPort.origin, nonDefaultPort.host, nonDefaultPort.hostname, nonDefaultPort.port].join("~"),
            paramsView,
            URL === window.URL && URLSearchParams === window.URLSearchParams && url.searchParams === url.searchParams &&
              Object.getPrototypeOf(url) === URL.prototype && Object.getPrototypeOf(params) === URLSearchParams.prototype,
            urlWriteRejected && paramsWriteRejected && url.pathname === "/next" && params.get("query") === "one two",
            invalidIsLocal && inputQuotaRejected && resultQuotaRejected,
            typeof __urlOperation === "undefined" && blocked(url) && blocked(params),
          ].join("|");
        `);
        expect(result.value).toBe(
          "https://example.test/next?query=one+two&query=%2B#part~https://example.test~https:~example.test~example.test~~/next~?query=one+two&query=%2B~#part~https://example.test/next?query=one+two&query=%2B#part|true|http://example.test:8080~example.test:8080~example.test~8080|one two~true|true|true|true|true",
        );
      }),
    );
  });

  it.live("supports the bounded context-local Request subset", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
      const host: BrowserScriptHost = {
        request: (input) =>
          Effect.sync(() => {
            requests.push(input);
            return {
              status: 200,
              url: input.url,
              headers: [],
              body: "ok",
              cookie: "",
            };
          }),
        setCookie: () => Effect.succeed(""),
      };
      const result = yield* runtime.evaluate(
        `
        const request = new Request("/upload", {
          method: "post",
          headers: { "x-base": "first" },
          body: "payload",
        });
        const clone = request.clone();
        clone.headers.set("x-base", "second");
        const response = await fetch(clone);
        const localTypeError = (error) => error instanceof TypeError &&
          error.constructor === TypeError && Object.getPrototypeOf(error) === TypeError.prototype;
        let credentialsRejected = false, modeRejected = false, getBodyRejected = false;
        try { new Request("/", { credentials: "include" }); }
        catch (error) { credentialsRejected = localTypeError(error); }
        try { new Request("/", { mode: "cors" }); }
        catch (error) { modeRejected = localTypeError(error); }
        try { new Request("/", { body: "payload" }); }
        catch (error) { getBodyRejected = localTypeError(error); }
        let usedCloneRejected = false;
        try { clone.clone(); } catch (error) { usedCloneRejected = localTypeError(error); }
        let hostEscapeBlocked = false;
        try { request.constructor.constructor("return process")(); }
        catch (error) { hostEscapeBlocked = error instanceof ReferenceError && error.message === "process is not defined"; }
        return [
          Request === window.Request && request instanceof Request && Object.getPrototypeOf(request) === Request.prototype,
          request.url, request.method, request.credentials, request.redirect, request.mode,
          request.bodyUsed, clone.bodyUsed, usedCloneRejected, response.status,
          credentialsRejected, modeRejected, getBodyRejected, hostEscapeBlocked,
        ].join("|");
        `,
        { url: "https://example.test/page", cookie: "", userAgent: "fixture" },
        host,
      );
      expect(result.value).toBe(
        "true|/upload|POST|same-origin|follow|cors|false|true|true|200|true|true|true|true",
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://example.test/upload");
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.headers).toContainEqual(["x-base", "second"]);
      expect(requests[0]?.body).toBe("payload");
      expect(requests[0]?.bodyBytes).toBeNull();
    }).pipe(
      Effect.provide(
        BrowserMock.layer({ allowedOrigins: ["https://example.test"] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("resolves Request URLs on the host with a page URL over 8 KiB", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
      const host = recordingScriptHost(requests);
      const pageUrl = `https://example.test/${"p".repeat(SCRIPT_URL_INPUT_LIMIT)}`;
      const result = yield* runtime.evaluate(
        `await fetch("https://example.test/fetch"); await fetch(new Request("https://example.test/request")); return "done";`,
        { cookie: "", url: pageUrl, userAgent: "fixture" },
        host,
      );

      expect(pageUrl.length).toBeGreaterThan(SCRIPT_URL_INPUT_LIMIT);
      expect(result.value).toBe("done");
      expect(requests.map(({ url }) => url)).toEqual([
        "https://example.test/fetch",
        "https://example.test/request",
      ]);
    }).pipe(
      Effect.provide(
        BrowserMock.layer({ allowedOrigins: ["https://example.test"] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live(
    "keeps a source Request body reusable when an override replaces it",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
        const host = recordingScriptHost(requests);
        const result = yield* runtime.evaluate(
          `const source = new Request("/upload", { method: "POST", body: "source" }); const replacement = new Request(source, { body: "replacement" }); const sourceReusable = !source.bodyUsed; const response = await fetch(source); return [sourceReusable, replacement.body, replacement.bodyUsed, response.status].join("|");`,
          {
            cookie: "",
            url: "https://example.test/page",
            userAgent: "fixture",
          },
          host,
        );

        expect(result.value).toBe("true|replacement|false|200");
        expect(requests).toHaveLength(1);
        const [request] = requests;
        assert.ok(request);
        expect(request.url).toBe("https://example.test/upload");
        expect(request.body).toBe("source");
      }).pipe(
        Effect.provide(
          BrowserMock.layer({ allowedOrigins: ["https://example.test"] }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
  );

  it.live("implements bounded, context-local Blob operations", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(`
        const input = new Uint8Array([120, 97, 98, 121]);
        const view = new Uint8Array(input.buffer, 1, 2);
        const blob = new Blob(["雪", view], { type: "TEXT/PLAIN" });
        view[0] = 0x7a;
        const buffer = await blob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        new Uint8Array(buffer)[3] = 0x7a;
        const text = await blob.text();
        const slice = blob.slice(-2, 99, "APPLICATION/OCTET-STREAM");
        const sliceText = await slice.text();
        const dataView = new DataView(new Uint8Array([0, 67, 68, 0]).buffer, 1, 2);
        const nested = new Blob([blob, dataView, "!"]);
        const nestedText = await nested.text();
        const sourceBuffer = new Uint8Array([88, 89]).buffer;
        const copiedBuffer = new Blob([sourceBuffer]);
        new Uint8Array(sourceBuffer)[0] = 90;
        const bufferText = await copiedBuffer.text();
        const unsupportedStream = (() => {
          try { blob.stream(); return false; }
          catch (error) { return error instanceof TypeError && error.constructor === TypeError; }
        })();
        const blocked = (value) => {
          try { value.constructor.constructor("return process")(); return false; }
          catch (error) { return error instanceof ReferenceError && error.message === "process is not defined"; }
        };
        return JSON.stringify({
          sameConstructor: Blob === window.Blob,
          size: blob.size,
          type: blob.type,
          bytes: bytes.join(","),
          text,
          sliceSize: slice.size,
          sliceType: slice.type,
          sliceText,
          emptySlices: blob.slice(4, 2).size === 0 && blob.slice(99).size === 0,
          nestedText,
          bufferText,
          promiseRealm: blob.text() instanceof Promise && Object.getPrototypeOf(blob.text()) === Promise.prototype,
          arrayBufferRealm: Object.getPrototypeOf(buffer) === ArrayBuffer.prototype,
          invalidMimeType: new Blob([], { type: "text/é" }).type === "",
          unsupportedStream,
          workersAbsent: typeof Worker === "undefined",
          hostGlobalsAbsent: [typeof process, typeof Buffer, typeof require, typeof __encodeBlobText, typeof __decodeBlobText].every((value) => value === "undefined"),
          hostEscapeBlocked: blocked(blob) && blocked(blob.text()),
        });
      `);
      expect(JSON.parse(result.value)).toEqual({
        sameConstructor: true,
        size: 5,
        type: "text/plain",
        bytes: "233,155,170,97,98",
        text: "雪ab",
        sliceSize: 2,
        sliceType: "application/octet-stream",
        sliceText: "ab",
        emptySlices: true,
        nestedText: "雪abCD!",
        bufferText: "XY",
        promiseRealm: true,
        arrayBufferRealm: true,
        invalidMimeType: true,
        unsupportedStream: true,
        workersAbsent: true,
        hostGlobalsAbsent: true,
        hostEscapeBlocked: true,
      });
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.layer(
    BrowserMock.layer({ allowedOrigins: ["https://example.test"] }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    { excludeTestServices: true },
  )("context-local FormData", ({ effect: testEffect }) => {
    testEffect(
      "preserves ordered duplicates, value types, iteration, and isolation",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const result = yield* runtime.evaluate(`
          const localTypeError = (error) => error instanceof TypeError &&
            error.constructor === TypeError && Object.getPrototypeOf(error) === TypeError.prototype;
          const data = new FormData();
          const sourceBlob = new Blob(["data"], { type: "text/plain" });
          data.append("duplicate", "first");
          data.append("middle", "one");
          data.append("duplicate", "second");
          data.append("middle", "two");
          data.append("blob", sourceBlob);
          data.append("coerced", 23);
          const describe = (value) => typeof value === "string" ? value : "blob:" + value.type + ":" + value.size;
          const entries = () => Array.from(data, ([name, value]) => name + ":" + describe(value)).join(",");
          const initial = entries();
          const duplicates = data.getAll("duplicate");
          const getAllCopy = duplicates.length === 2 && Object.getPrototypeOf(duplicates) === Array.prototype;
          duplicates.pop();
          const getAllIndependent = data.getAll("duplicate").length === 2;
          const storedBlob = data.get("blob");
          data.set("duplicate", "updated");
          const calls = [];
          const receiver = {};
          data.forEach(function(value, name, parent) {
            calls.push((this === receiver) + ":" + name + ":" + describe(value) + ":" + (parent === data));
          }, receiver);
          const keys = Array.from(data.keys()).join(",");
          const values = Array.from(data.values(), describe).join(",");
          const iterator = data.entries();
          const pair = iterator.next().value;
          pair[1] = "changed";
          const iteratorLocal = pair instanceof Array && Object.getPrototypeOf(pair) === Array.prototype &&
            iterator[Symbol.iterator]() === iterator && data.get("duplicate") === "updated";
          data.delete("middle");
          let constructorRejected = false;
          try { new FormData({}); } catch (error) { constructorRejected = localTypeError(error); }
          let filenameRejected = false;
          try { data.append("file", sourceBlob, "name.txt"); }
          catch (error) { filenameRejected = localTypeError(error); }
          const blocked = (value) => {
            try { value.constructor.constructor("return process")(); return false; }
            catch (error) { return error instanceof ReferenceError && error.message === "process is not defined"; }
          };
          return [
            FormData === window.FormData && data instanceof FormData && Object.getPrototypeOf(data) === FormData.prototype,
            initial,
            getAllCopy && getAllIndependent && data.getAll("duplicate").join(",") === "updated",
            keys,
            values,
            calls.join(","),
            iteratorLocal,
            !data.has("middle") && data.get("middle") === null && data.getAll("middle").length === 0,
            entries(),
            storedBlob instanceof Blob && storedBlob !== sourceBlob && await storedBlob.text() === "data",
            constructorRejected,
            filenameRejected,
            typeof HTMLFormElement === "undefined" && typeof File === "undefined",
            blocked(data) && blocked(FormData.prototype.append) && blocked(storedBlob),
          ].join("|");
        `);
          expect(result.value).toBe(
            "true|duplicate:first,middle:one,duplicate:second,middle:two,blob:blob:text/plain:4,coerced:23|true|duplicate,middle,middle,blob,coerced|updated,one,two,blob:text/plain:4,23|true:duplicate:updated:true,true:middle:one:true,true:middle:two:true,true:blob:blob:text/plain:4:true,true:coerced:23:true|true|true|duplicate:updated,blob:blob:text/plain:4,coerced:23|true|true|true|true|true",
          );
        }),
    );
    testEffect(
      "charges FormData names, strings, and copied Blobs to the shared quota",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const result = yield* runtime.evaluate(`
          const localQuotaError = (error) => error instanceof Error &&
            error.constructor === Error && Object.getPrototypeOf(error) === Error.prototype &&
            error.name === "QuotaExceededError";
          const data = new FormData();
          data.append("text", "t".repeat(300000));
          const blob = new Blob(["b".repeat(300000)], { type: "text/plain" });
          data.append("blob", blob);
          let quotaRejected = false;
          try { data.append("overflow", "o".repeat(200000)); }
          catch (error) { quotaRejected = localQuotaError(error); }
          const names = new FormData();
          names.append("n".repeat(100000), "");
          let nameQuotaRejected = false;
          try { names.append("n".repeat(50000), ""); }
          catch (error) { nameQuotaRejected = localQuotaError(error); }
          const entries = new FormData();
          for (let index = 0; index < 256; index += 1) entries.append("", "");
          let entryLimitRejected = false;
          try { entries.append("", ""); }
          catch (error) { entryLimitRejected = error instanceof TypeError && error.message.includes("256-entry"); }
          return [data.get("text").length, data.get("blob").size, quotaRejected, nameQuotaRejected, entryLimitRejected].join("|");
        `);
          expect(result.value).toBe("300000|300000|true|true|true");
        }),
    );
    testEffect(
      "encodes Fetch and XHR FormData as bounded multipart bytes",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const requests: Array<Parameters<BrowserScriptHost["request"]>[0]> =
            [];
          const host: BrowserScriptHost = {
            request: (input) =>
              Effect.sync(() => {
                requests.push(input);
                return {
                  status: 200,
                  url: input.url,
                  headers: [],
                  body: "ok",
                  cookie: "",
                };
              }),
            setCookie: () => Effect.succeed(""),
          };
          const result = yield* runtime.evaluate(
            `
            const data = new FormData();
            data.append('naïve "name"\\r\\n', "café\\nline");
            data.append("duplicate", "first");
            data.append("duplicate", "second");
            data.append("cr\\rname", "cr");
            data.append("lf\\nname", "lf");
            data.append("binary", new Blob([new Uint8Array([0, 255, 128, 13, 10])], { type: "application/octet-stream" }));
            const fetched = await fetch("https://example.test/fetch", { method: "POST", body: data });
            const custom = new FormData();
            custom.append("value", "fetch");
            await fetch("https://example.test/custom", { method: "POST", headers: { "content-type": "application/custom" }, body: custom });
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "https://example.test/xhr");
            xhr.setRequestHeader("content-type", "application/custom-xhr");
            const xhrResult = new Promise((resolve, reject) => {
              xhr.onload = () => resolve(xhr.status + ":" + xhr.responseText);
              xhr.onerror = () => reject(new Error("XHR failed"));
            });
            const xhrData = new FormData();
            xhrData.append("value", "xhr");
            xhr.send(xhrData);
            let filenameRejected = false;
            try { data.append("filename", new Blob([]), "explicit.txt"); }
            catch (error) { filenameRejected = error instanceof TypeError && error.message.includes("filenames"); }
            let blobFetchRejected = false;
            try { await fetch("https://example.test/blob", { method: "POST", body: new Blob(["raw"]) }); }
            catch (error) { blobFetchRejected = error instanceof TypeError; }
            const blobXhr = new XMLHttpRequest();
            blobXhr.open("POST", "https://example.test/blob-xhr");
            let blobXhrRejected = false;
            try { blobXhr.send(new Blob(["raw"])); }
            catch (error) { blobXhrRejected = error instanceof TypeError; }
            return fetched.status + ":" + await fetched.text() + "|" + await xhrResult + "|" + filenameRejected + "|" + blobFetchRejected + "|" + blobXhrRejected;
          `,
            {
              url: "https://example.test/",
              cookie: "",
              userAgent: "",
            },
            host,
          );
          expect(result.value).toBe("200:ok|200:ok|true|true|true");
          expect(requests).toHaveLength(3);

          const fetchRequest = requests[0] ?? null,
            customFetch = requests[1] ?? null,
            customXhr = requests[2] ?? null;
          expect(fetchRequest).not.toBeNull();
          expect(customFetch).not.toBeNull();
          expect(customXhr).not.toBeNull();
          if (
            fetchRequest === null ||
            customFetch === null ||
            customXhr === null
          ) {
            return;
          }
          const contentTypeEntry =
            fetchRequest.headers.find(
              ([name]) => name.toLowerCase() === "content-type",
            ) ?? null;
          expect(contentTypeEntry).not.toBeNull();
          if (contentTypeEntry === null) return;
          const contentType = contentTypeEntry[1];
          expect(contentType).toMatch(
            /^multipart\/form-data; boundary=----BrowserMockFormBoundary[0-9a-f]{32}$/u,
          );
          const boundary = contentType.slice(
            contentType.indexOf("boundary=") + 9,
          );
          const expected = concatBytes(
            bodyBytes(
              `--${boundary}\r\nContent-Disposition: form-data; name="naïve %22name%22%0D%0A"\r\n\r\ncafé\r\nline\r\n--${boundary}\r\nContent-Disposition: form-data; name="duplicate"\r\n\r\nfirst\r\n--${boundary}\r\nContent-Disposition: form-data; name="duplicate"\r\n\r\nsecond\r\n--${boundary}\r\nContent-Disposition: form-data; name="cr%0D%0Aname"\r\n\r\ncr\r\n--${boundary}\r\nContent-Disposition: form-data; name="lf%0D%0Aname"\r\n\r\nlf\r\n--${boundary}\r\nContent-Disposition: form-data; name="binary"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`,
            ),
            new Uint8Array([0, 255, 128, 13, 10]),
            bodyBytes(`\r\n--${boundary}--\r\n`),
          );
          expect(Array.from(multipartRequestBytes(fetchRequest))).toEqual(
            Array.from(expected),
          );
          expect(customFetch.headers).toContainEqual([
            "content-type",
            "application/custom",
          ]);
          expect(customXhr.headers).toContainEqual([
            "content-type",
            "application/custom-xhr",
          ]);
          const xhrText = new TextDecoder().decode(
            multipartRequestBytes(customXhr),
          );
          const xhrBoundaryMatch =
            /^--(----BrowserMockFormBoundary[0-9a-f]{32})\r\n/u.exec(xhrText);
          expect(xhrBoundaryMatch).not.toBeNull();
          if (xhrBoundaryMatch === null) return;
          const xhrBoundary = xhrBoundaryMatch[1] ?? null;
          expect(xhrBoundary).not.toBeNull();
          if (xhrBoundary === null) return;
          expect(xhrText).toBe(
            `--${xhrBoundary}\r\nContent-Disposition: form-data; name="value"\r\n\r\nxhr\r\n--${xhrBoundary}--\r\n`,
          );
        }),
    );
    testEffect(
      "keeps multipart boundaries safe from script prototype mutation",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
          const host: BrowserScriptHost = {
            request: (input) =>
              Effect.sync(() => {
                requests.push(input);
                return {
                  body: "ok",
                  cookie: "",
                  headers: [],
                  status: 200,
                  url: input.url,
                };
              }),
            setCookie: () => Effect.succeed(""),
          };
          const source = String.raw`
            Number.prototype.toString = () => "0x";
            const injectedBoundary = "----BrowserMockFormBoundary" + "0x".repeat(16);
            const crlf = "\r\n";
            const embedded = crlf + "--" + injectedBoundary + crlf +
              'Content-Disposition: form-data; name="injected"' +
              crlf + crlf + "forged" + crlf + "--" + injectedBoundary + "--" + crlf;
            const data = new FormData();
            data.append("upload", new Blob(["prefix" + embedded], { type: "text/plain" }));
            await fetch("https://example.test/upload", { method: "POST", body: data });
            return embedded;
          `;
          const result = yield* runtime.evaluate(
            source,
            {
              url: "https://example.test/",
              cookie: "",
              userAgent: "",
            },
            host,
          );
          expect(result.value).toContain(
            'Content-Disposition: form-data; name="injected"',
          );
          expect(requests).toHaveLength(1);
          const [request] = requests;
          assert(request);
          const contentTypeHeader = request.headers.find(
            ([name]) => name === "content-type",
          );
          assert(contentTypeHeader);
          const [, contentType] = contentTypeHeader;
          expect(contentType).toMatch(
            /^multipart\/form-data; boundary=----BrowserMockFormBoundary[0-9a-f]{32}$/u,
          );
          const boundaryPrefix = "boundary=";
          const boundary = contentType.slice(
            contentType.indexOf(boundaryPrefix) + boundaryPrefix.length,
          );
          const body = new TextDecoder().decode(multipartRequestBytes(request));
          expect(body).toContain(`prefix${result.value}`);
          expect(body).not.toContain(
            `\r\n--${boundary}\r\nContent-Disposition: form-data; name="injected"`,
          );
        }),
    );
    testEffect("rejects oversized multipart bodies before host dispatch", () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        let requests = 0;
        const host: BrowserScriptHost = {
          request: () =>
            Effect.sync(() => {
              requests += 1;
              return {
                status: 200,
                url: "https://example.test/",
                headers: [],
                body: "unexpected",
                cookie: "",
              };
            }),
          setCookie: () => Effect.succeed(""),
        };
        const result = yield* runtime.evaluate(
          `
            const data = new FormData();
            data.append("binary", new Blob([new Uint8Array(16 * 1024)]));
            let rejected = false;
            try { await fetch("https://example.test/", { method: "POST", body: data }); }
            catch (error) { rejected = error instanceof TypeError && error.message.includes("16 KiB"); }
            return String(rejected);
          `,
          { url: "https://example.test/", cookie: "", userAgent: "" },
          host,
        );
        expect(result.value).toBe("true");
        expect(requests).toBe(0);
      }),
    );
  });

  it.live("enforces the context-local Blob allocation quota", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(`
        const localQuotaError = (error) => error instanceof Error &&
          error.constructor === Error && Object.getPrototypeOf(error) === Error.prototype &&
          error.name === "QuotaExceededError";
        let oversizedRejected = false;
        try { new Blob(["x".repeat(1024 * 1024 + 1)]); }
        catch (error) { oversizedRejected = localQuotaError(error); }
        const blob = new Blob(["x".repeat(1024 * 1024)]);
        let constructorRejected = false;
        try { new Blob(["x"]); }
        catch (error) { constructorRejected = localQuotaError(error); }
        const read = blob.arrayBuffer();
        const localPromise = read instanceof Promise && Object.getPrototypeOf(read) === Promise.prototype;
        let readRejected = false;
        try { await read; }
        catch (error) { readRejected = localQuotaError(error); }
        return [blob.size, oversizedRejected, constructorRejected, localPromise, readRejected].join("|");
      `);
      expect(result.value).toBe("1048576|true|true|true|true");
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.layer(BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)), {
    excludeTestServices: true,
  })("context-local FileReader", ({ effect: testEffect }) => {
    testEffect("implements FileReader operations and event ordering", () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(`
        const blob = new Blob(["snowman: ☃"], { type: "text/plain" });
        const reader = new FileReader();
        const events = [];
        let eventValuesStayLocal = true;
        let progressEventIsLocal = false;
        let firstEvent;
        const observe = (event) => {
          if (firstEvent === undefined) firstEvent = event;
          eventValuesStayLocal = eventValuesStayLocal && event instanceof ProgressEvent &&
            Object.getPrototypeOf(event) === ProgressEvent.prototype &&
            event.target === reader && event.currentTarget === reader && event.isTrusted === false;
        };
        reader.addEventListener("loadstart", (event) => { observe(event); events.push("loadstart"); });
        reader.onloadstart = (event) => { observe(event); events.push("onloadstart"); };
        reader.addEventListener("progress", (event) => {
          observe(event);
          progressEventIsLocal = event instanceof ProgressEvent &&
            Object.getPrototypeOf(event) === ProgressEvent.prototype && ProgressEvent === window.ProgressEvent;
          events.push("progress:" + event.loaded + "/" + event.total + ":" + event.lengthComputable);
        });
        reader.addEventListener("load", (event) => { observe(event); events.push("load"); });
        reader.onload = (event) => { observe(event); events.push("onload"); };
        reader.addEventListener("loadend", (event) => { observe(event); events.push("loadend"); });
        const completion = new Promise((resolve) => { reader.onloadend = resolve; });
        const readReturn = reader.readAsArrayBuffer(blob);
        const asynchronous = reader.readyState === FileReader.LOADING && reader.result === null;
        events.push("immediate");
        const completionPromiseIsLocal = Object.getPrototypeOf(completion) === Promise.prototype;
        await completion;
        const eventOrder = events.join("|");
        const buffer = reader.result;
        const bytes = Array.from(new Uint8Array(buffer)).join(",");
        const read = (method) => new Promise((resolve, reject) => {
          reader.onerror = () => reject(reader.error);
          reader.onloadend = () => resolve(reader.result);
          reader[method](blob);
        });
        const text = await read("readAsText");
        const dataURL = await read("readAsDataURL");
        const previousDoneResult = reader.result;
        const previousError = reader.error;
        reader.abort();
        const doneAbortClearsResult = previousDoneResult === dataURL && reader.readyState === FileReader.DONE &&
          reader.result === null && reader.error === previousError;
        const invalid = new FileReader();
        let nonBlobErrorIsLocal = false;
        try { invalid.readAsText({}); }
        catch (error) {
          nonBlobErrorIsLocal = error instanceof TypeError && error.constructor === TypeError &&
            Object.getPrototypeOf(error) === TypeError.prototype;
        }
        const reentrant = new FileReader();
        let concurrentReadRejected = false;
        const reentrantDone = new Promise((resolve) => {
          reentrant.onloadstart = () => {
            try { reentrant.readAsText(blob); }
            catch (error) {
              concurrentReadRejected = error instanceof Error && error.name === "InvalidStateError" &&
                error.constructor === Error && Object.getPrototypeOf(error) === Error.prototype;
            }
          };
          reentrant.onloadend = resolve;
        });
        reentrant.readAsArrayBuffer(blob);
        await reentrantDone;
        const blocked = (value) => {
          try { value.constructor.constructor("return process")(); return false; }
          catch (error) { return error instanceof ReferenceError && error.message === "process is not defined"; }
        };
        return JSON.stringify({
          exposed: FileReader === window.FileReader,
          constants: FileReader.EMPTY === 0 && FileReader.LOADING === 1 && FileReader.DONE === 2 &&
            reader.EMPTY === 0 && reader.LOADING === 1 && reader.DONE === 2,
          readReturnIsUndefined: readReturn === undefined,
          asynchronous,
          localPromise: completionPromiseIsLocal,
          eventOrder,
          eventValuesStayLocal,
          progressEventIsLocal,
          bytes,
          arrayBufferIsLocal: buffer instanceof ArrayBuffer && Object.getPrototypeOf(buffer) === ArrayBuffer.prototype,
          text,
          dataURL,
          doneAbortClearsResult,
          nonBlobErrorIsLocal,
          concurrentReadRejected,
          localCallbacksAndReader: Object.getPrototypeOf(reader.onload) === Function.prototype &&
            Object.getOwnPropertyDescriptor(FileReader.prototype, "result").set === undefined &&
            !("onreadystatechange" in reader),
          escapesBlocked: blocked(reader) && blocked(reader.readAsArrayBuffer) && blocked(buffer) && blocked(firstEvent),
          hiddenHostGlobals: [typeof process, typeof Buffer, typeof require].every((value) => value === "undefined"),
        });
      `);
        const resultValue = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(result.value);
        expect(resultValue).toEqual({
          exposed: true,
          constants: true,
          readReturnIsUndefined: true,
          asynchronous: true,
          localPromise: true,
          eventOrder:
            "immediate|loadstart|onloadstart|progress:12/12:true|load|onload|loadend",
          eventValuesStayLocal: true,
          progressEventIsLocal: true,
          bytes: "115,110,111,119,109,97,110,58,32,226,152,131",
          arrayBufferIsLocal: true,
          text: "snowman: ☃",
          dataURL: "data:text/plain;base64,c25vd21hbjog4piD",
          doneAbortClearsResult: true,
          nonBlobErrorIsLocal: true,
          concurrentReadRejected: true,
          localCallbacksAndReader: true,
          escapesBlocked: true,
          hiddenHostGlobals: true,
        });
      }),
    );
    testEffect("strips a UTF-8 BOM from Blob and FileReader text reads", () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(`
          const expected = '{"value":"café"}';
          const blob = new Blob([String.fromCharCode(0xfeff) + expected], { type: "application/json" });
          const reader = new FileReader();
          const readerText = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(blob);
          });
          return String(readerText === expected && await blob.text() === expected);
        `);
        expect(result.value).toBe("true");
      }),
    );
    testEffect(
      "aborts FileReader reads and charges materialized results to the Blob quota",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const aborted = yield* runtime.evaluate(`
        const empty = new FileReader();
        empty.abort();
        const emptyAbortKeepsState = empty.readyState === FileReader.EMPTY && empty.result === null && empty.error === null;
        const blob = new Blob(["pending"]);
        const reader = new FileReader();
        const events = [];
        let activeAbortHasNullError = false;
        let activeAbortIsDone = false;
        let concurrentReadRejected = false;
        reader.addEventListener("loadstart", () => events.push("loadstart"));
        reader.addEventListener("abort", (event) => events.push("abort:" + event.isTrusted));
        reader.addEventListener("loadend", (event) => events.push("loadend:" + event.isTrusted));
        const done = new Promise((resolve) => {
          reader.onloadstart = () => {
            try { reader.readAsText(blob); }
            catch (error) {
              concurrentReadRejected = error instanceof Error && error.name === "InvalidStateError";
            }
            reader.abort();
          };
          reader.onabort = () => {
            activeAbortHasNullError = reader.error === null;
            activeAbortIsDone = reader.readyState === FileReader.DONE && reader.result === null;
          };
          reader.onloadend = resolve;
        });
        reader.readAsArrayBuffer(blob);
        const loadingBeforeEvents = reader.readyState === FileReader.LOADING && reader.result === null;
        await done;
        const abortedState = reader.readyState === FileReader.DONE && reader.result === null;
        reader.abort();
        const doneAbortKeepsState = reader.readyState === FileReader.DONE && reader.result === null && reader.error === null;
        return JSON.stringify({
          events: events.join("|"),
          loadingBeforeEvents,
          abortedState,
          emptyAbortKeepsState,
          doneAbortKeepsState,
          activeAbortHasNullError,
          activeAbortIsDone,
          concurrentReadRejected,
        });
      `);
          const abortedValue = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )(aborted.value);
          expect(abortedValue).toEqual({
            events: "loadstart|abort:false|loadend:false",
            loadingBeforeEvents: true,
            abortedState: true,
            emptyAbortKeepsState: true,
            doneAbortKeepsState: true,
            activeAbortHasNullError: true,
            activeAbortIsDone: true,
            concurrentReadRejected: true,
          });

          const quota = yield* runtime.evaluate(`
        const blob = new Blob(["x".repeat(700000)]);
        const reader = new FileReader();
        const events = [];
        const done = new Promise((resolve) => {
          reader.onerror = () => events.push("error");
          reader.onloadend = resolve;
        });
        reader.readAsDataURL(blob);
        await done;
        const previousError = reader.error;
        reader.abort();
        return JSON.stringify({
          error: previousError && previousError.name,
          doneAbortPreservesError: reader.error === previousError && reader.readyState === FileReader.DONE && reader.result === null,
          localError: previousError instanceof Error && previousError.constructor === Error &&
            Object.getPrototypeOf(previousError) === Error.prototype,
          state: reader.readyState,
          result: reader.result,
          events: events.join("|"),
          escapeBlocked: (() => {
            try { reader.error.constructor.constructor("return process")(); return false; }
            catch (error) { return error instanceof ReferenceError && error.message === "process is not defined"; }
          })(),
        });
      `);
          const quotaValue = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )(quota.value);
          expect(quotaValue).toEqual({
            error: "QuotaExceededError",
            doneAbortPreservesError: true,
            localError: true,
            state: 2,
            result: null,
            events: "error",
            escapeBlocked: true,
          });
        }),
    );
    testEffect(
      "suppresses stale loadend events when terminal callbacks start another read",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const result = yield* runtime.evaluate(`
        const blob = new Blob(["chain"]);
        const loadEvents = [];
        const loadReader = new FileReader();
        let loadCount = 0;
        const loadDone = new Promise((resolve) => {
          loadReader.onloadstart = () => loadEvents.push("loadstart");
          loadReader.onprogress = () => loadEvents.push("progress");
          loadReader.onload = () => {
            loadEvents.push("load");
            if (loadCount++ === 0) loadReader.readAsText(blob);
          };
          loadReader.onloadend = () => {
            loadEvents.push("loadend");
            resolve();
          };
        });
        loadReader.readAsArrayBuffer(blob);
        await loadDone;

        const errorEvents = [];
        const errorReader = new FileReader();
        let retried = false;
        const errorDone = new Promise((resolve) => {
          errorReader.onloadstart = () => errorEvents.push("loadstart");
          errorReader.onprogress = () => errorEvents.push("progress");
          errorReader.onerror = () => {
            errorEvents.push("error");
            if (!retried) {
              retried = true;
              errorReader.readAsText(new Blob(["ok"]));
            }
          };
          errorReader.onload = () => errorEvents.push("load");
          errorReader.onloadend = () => {
            errorEvents.push("loadend");
            resolve();
          };
        });
        errorReader.readAsDataURL(new Blob(["x".repeat(700000)]));
        await errorDone;

        const abortEvents = [];
        const abortReader = new FileReader();
        let abortIsDone = false;
        let abortHasNullError = false;
        let abortImmediateEvents = "";
        const abortDone = new Promise((resolve) => {
          abortReader.onloadstart = () => abortEvents.push("loadstart");
          abortReader.onprogress = () => abortEvents.push("progress");
          abortReader.onabort = () => {
            abortEvents.push("abort");
            abortIsDone = abortReader.readyState === FileReader.DONE && abortReader.result === null;
            abortHasNullError = abortReader.error === null;
            abortReader.readAsText(blob);
          };
          abortReader.onload = () => abortEvents.push("load");
          abortReader.onloadend = () => {
            abortEvents.push("loadend");
            resolve();
          };
        });
        abortReader.readAsArrayBuffer(blob);
        abortReader.abort();
        abortImmediateEvents = abortEvents.join("|");
        await abortDone;
        return JSON.stringify({
          load: loadEvents.join("|"),
          error: errorEvents.join("|"),
          abort: abortEvents.join("|"),
          abortImmediateEvents,
          abortIsDone,
          abortHasNullError,
        });
      `);
          const resultValue = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )(result.value);
          expect(resultValue).toEqual({
            load: "loadstart|progress|load|loadstart|progress|load|loadend",
            error: "loadstart|progress|error|loadstart|progress|load|loadend",
            abort: "abort|loadstart|progress|load|loadend",
            abortImmediateEvents: "abort",
            abortIsDone: true,
            abortHasNullError: true,
          });
        }),
    );
  });

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
      const listenerResult = yield* runtime.evaluate(`
        const thrown = { document: {}, window: {} };
        const reports = [];
        const nextListeners = [];
        window.addEventListener("error", (event) => {
          reports.push(event.error === thrown.document || event.error === thrown.window);
          reports.push(event.target === window && event.filename === document.location.href);
        });
        for (const [type, target] of [["document", document], ["window", window]]) {
          target.addEventListener(type, () => { throw thrown[type]; });
          target.addEventListener(type, () => nextListeners.push(type));
          target.dispatchEvent(new Event(type));
        }
        return [reports.length, reports.every(Boolean), nextListeners.join(",")].join("|");
      `);
      expect(listenerResult.value).toBe("4|true|document,window");
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.live("reports timer callback exceptions and runs later timers", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(
        `
          const thrown = new Error("timer callback failure");
          const reports = [];
          let laterTimerRan = false;
          window.addEventListener("error", (event) => reports.push(
            event.type === "error" && event.cancelable && event.error === thrown &&
            event.filename === "https://allowed.test/page" && event.target === window &&
            event instanceof ErrorEvent && Object.getPrototypeOf(event) === ErrorEvent.prototype &&
            event.constructor.constructor("return typeof process")() === "undefined"
          ));
          await new Promise((resolve) => setTimeout(() => {
            setTimeout(() => { laterTimerRan = true; resolve(); }, 0);
            throw thrown;
          }, 0));
          return ["normal result", reports.length, reports[0], laterTimerRan].join("|");
        `,
        { url: "https://allowed.test/page", cookie: "", userAgent: "fixture" },
      );
      expect(result.value).toBe("normal result|1|true|true");
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.live("does not recurse when a window error listener throws", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(`
        let errorReports = 0;
        let nextListenerCalls = 0;
        window.addEventListener("error", () => {
          errorReports += 1;
          throw new Error("error listener failure");
        });
        window.addEventListener("error", () => nextListenerCalls += 1);
        setTimeout(() => { throw new Error("timer failure"); }, 0);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [errorReports, nextListenerCalls, "evaluation continued"].join("|");
      `);
      expect(result.value).toBe("1|1|evaluation continued");
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.live("applies legacy window.onerror arguments to async exceptions", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(
        `
          const thrown = new Error("legacy timer failure");
          let reportCount = 0;
          let event;
          let args;
          let receiver;
          window.addEventListener("error", (reported) => { reportCount += 1; event = reported; });
          window.onerror = function(...values) { args = values; receiver = this; return true; };
          setTimeout(() => { throw thrown; }, 0);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return [
            reportCount === 1, args.length === 5, receiver === window,
            args[0] === event.message, args[1] === "https://allowed.test/page",
            args[2] === 0, args[3] === 0, args[4] === thrown, event.defaultPrevented,
          ].join("|");
        `,
        { url: "https://allowed.test/page", cookie: "", userAgent: "fixture" },
      );
      expect(result.value).toBe("true|true|true|true|true|true|true|true|true");
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.effect("reports throwing XHR and FileReader handlers", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(
        `
          const xhrThrown = new Error("XHR handler failure");
          const readerThrown = new Error("FileReader handler failure");
          const reports = [];
          let xhrFinished = false;
          let readerFinished = false;
          window.addEventListener("error", (event) => reports.push(
            event.filename === document.location.href && event.target === window &&
            (event.error === xhrThrown || event.error === readerThrown)
          ));
          const xhr = new XMLHttpRequest();
          const xhrDone = new Promise((resolve) => {
            xhr.onload = () => { throw xhrThrown; };
            xhr.onloadend = () => { xhrFinished = true; resolve(); };
          });
          xhr.open("GET", "/xhr");
          xhr.send();
          await xhrDone;
          const reader = new FileReader();
          const readerDone = new Promise((resolve) => {
            reader.onload = () => { throw readerThrown; };
            reader.onloadend = () => { readerFinished = true; resolve(); };
          });
          reader.readAsText(new Blob(["fixture"]));
          await readerDone;
          return [reports.length, reports.every(Boolean), xhrFinished, readerFinished, "continued"].join("|");
        `,
        { url: "https://allowed.test/page", cookie: "", userAgent: "fixture" },
        {
          request: (input) =>
            Effect.succeed({
              status: 200,
              url: input.url,
              headers: [],
              cookie: "",
              body: "fixture response",
            }),
          setCookie: () => Effect.succeed(""),
        },
      );
      expect(result.value).toBe("2|true|true|true|continued");
    }).pipe(
      Effect.provide(
        BrowserMock.layer({ allowedOrigins: ["https://allowed.test"] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("keeps host timer-fire quota failures fatal", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const error = yield* Effect.flip(
        runtime.evaluate(`
          setInterval(() => {}, 0);
          await new Promise(() => {});
        `),
      );
      expect(error).toBeInstanceOf(BrowserScriptError);
      expect(error.reason).toBe("script timer budget exceeds 256 fires");
    }).pipe(
      Effect.provide(
        BrowserMock.layer({ timeoutMs: 10_000 }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("exposes context-local monotonic performance timing", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const timing = yield* runtime.evaluate(`
        const before = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 5));
        const after = performance.now();
        return [
          typeof before,
          Number.isFinite(before),
          after > before,
          typeof performance.timeOrigin,
          Number.isFinite(performance.timeOrigin),
          performance.timeOrigin > 0,
          Object.getPrototypeOf(performance) === Object.prototype,
          Object.getPrototypeOf(performance.now) === Function.prototype,
        ].join("|");
      `);
      expect(timing.value).toBe("number|true|true|number|true|true|true|true");

      const hostEscape = yield* Effect.flip(
        runtime.evaluate(
          'return performance.now.constructor("return process")().version;',
        ),
      );
      expect(hostEscape.reason).toContain("process is not defined");
      expect(hostEscape.reason).not.toContain(process.version);
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.layer(BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)), {
    excludeTestServices: true,
  })(
    "provides secure randomness without crossing the VM boundary",
    ({ effect: testEffect }) => {
      testEffect("supports Web Crypto integer views and local errors", () =>
        Effect.gen(function* randomValuesTest() {
          const runtime = yield* BrowserMock,
            result = yield* runtime.evaluate(cryptoRandomValuesSource);
          expect(result.value).toBe(
            "true|true|true|true|true|true|true|true|true|true|true",
          );
        }),
      );
    },
  );

  it.layer(
    BrowserMock.layer({ allowedOrigins: ["https://example.test"] }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    { excludeTestServices: true },
  )("context-local TextEncoder and AES-GCM", ({ effect: testEffect }) => {
    testEffect("encodes UTF-8 and does not split scalars in encodeInto", () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(String.raw`
          const encoder = new TextEncoder();
          const input = "Aé☃😀\uD800Z";
          const bytes = encoder.encode(input);
          const partialBytes = new Uint8Array(8);
          const partial = encoder.encodeInto(input, partialBytes);
          const fullBytes = new Uint8Array(14);
          const full = encoder.encodeInto(input, fullBytes);
          const blocked = (value) => {
            try { value.constructor.constructor("return process")(); return false; }
            catch (error) { return error instanceof ReferenceError && error.message === "process is not defined"; }
          };
          let invalidDestinationIsLocal = false;
          try { encoder.encodeInto("x", new DataView(new ArrayBuffer(1))); }
          catch (error) { invalidDestinationIsLocal = error instanceof TypeError && error.constructor === TypeError; }
          return JSON.stringify({
            encoding: encoder.encoding,
            sameConstructor: TextEncoder === window.TextEncoder && encoder instanceof TextEncoder,
            bytes: Array.from(bytes),
            partial: { ...partial, bytes: Array.from(partialBytes) },
            full: { ...full, bytes: Array.from(fullBytes) },
            localValues: Object.getPrototypeOf(bytes) === Uint8Array.prototype &&
              Object.getPrototypeOf(bytes.buffer) === ArrayBuffer.prototype &&
              Object.getPrototypeOf(partial) === Object.prototype,
            invalidDestinationIsLocal,
            hostEscapeBlocked: blocked(encoder) && blocked(bytes) && blocked(bytes.buffer) && blocked(partial),
          });
        `);
        expect(JSON.parse(result.value)).toEqual({
          encoding: "utf-8",
          sameConstructor: true,
          bytes: [
            65, 195, 169, 226, 152, 131, 240, 159, 152, 128, 239, 191, 189, 90,
          ],
          partial: {
            read: 3,
            written: 6,
            bytes: [65, 195, 169, 226, 152, 131, 0, 0],
          },
          full: {
            read: 7,
            written: 14,
            bytes: [
              65, 195, 169, 226, 152, 131, 240, 159, 152, 128, 239, 191, 189,
              90,
            ],
          },
          localValues: true,
          invalidDestinationIsLocal: true,
          hostEscapeBlocked: true,
        });
      }),
    );
    testEffect(
      "encrypts with a private AES-GCM key matching the Node oracle",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const key = Buffer.from(
            Array.from({ length: 32 }, (_, index) => index),
          );
          const iv = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
          const aad = Buffer.from("fixture associated data", "utf8");
          const plaintext = Buffer.from(
            "generic browser crypto fixture",
            "utf8",
          );
          const oracle = createCipheriv("aes-256-gcm", key, iv, {
            authTagLength: 16,
          });
          oracle.setAAD(aad);
          const expected = Buffer.concat([
            oracle.update(plaintext),
            oracle.final(),
            oracle.getAuthTag(),
          ]);
          const result = yield* runtime.evaluate(`
          const keyBytes = new Uint8Array(${JSON.stringify(Array.from(key))});
          const iv = new Uint8Array(${JSON.stringify(Array.from(iv))});
          const input = new TextEncoder().encode("generic browser crypto fixture");
          const importPromise = crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
          const localImportPromise = importPromise instanceof Promise && Object.getPrototypeOf(importPromise) === Promise.prototype;
          const key = await importPromise;
          const encryptPromise = crypto.subtle.encrypt({
            name: "AES-GCM",
            iv,
            additionalData: new TextEncoder().encode("fixture associated data"),
            tagLength: 128,
          }, key, input);
          const localEncryptPromise = encryptPromise instanceof Promise && Object.getPrototypeOf(encryptPromise) === Promise.prototype;
          const output = await encryptPromise;
          const outputBytes = new Uint8Array(output);
          const uuid = crypto.randomUUID();
          const blocked = (value) => {
            try { value.constructor.constructor("return process")(); return false; }
            catch (error) { return error instanceof ReferenceError && error.message === "process is not defined"; }
          };
          return JSON.stringify({
            ciphertext: Array.from(outputBytes),
            localImportPromise,
            localEncryptPromise,
            localValues: CryptoKey === window.CryptoKey && key instanceof CryptoKey &&
              Object.getPrototypeOf(key) === CryptoKey.prototype && key.algorithm.name === "AES-GCM" &&
              key.algorithm.length === 256 && key.extractable === false && key.usages.join(",") === "encrypt" &&
              !Object.hasOwn(key, "id") && Object.getPrototypeOf(output) === ArrayBuffer.prototype &&
              Object.getPrototypeOf(outputBytes) === Uint8Array.prototype,
            uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid),
            sameCrypto: crypto === window.crypto,
            hostGlobalsAbsent: [typeof __cryptoOperation, typeof process, typeof Buffer, typeof require].every((value) => value === "undefined"),
            hostEscapeBlocked: blocked(key) && blocked(importPromise) && blocked(encryptPromise) && blocked(output) && blocked(outputBytes),
          });
        `);
          expect(JSON.parse(result.value)).toEqual({
            ciphertext: Array.from(expected),
            localImportPromise: true,
            localEncryptPromise: true,
            localValues: true,
            uuid: true,
            sameCrypto: true,
            hostGlobalsAbsent: true,
            hostEscapeBlocked: true,
          });
        }),
    );
    testEffect(
      "rejects unsupported algorithms, usages, sizes, and key counts locally",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const result = yield* runtime.evaluate(`
          const localTypeError = (error) => error instanceof TypeError && error.constructor === TypeError &&
            Object.getPrototypeOf(error) === TypeError.prototype;
          const blocked = (value) => {
            try { value.constructor.constructor("return process")(); return false; }
            catch (error) { return error instanceof ReferenceError && error.message === "process is not defined"; }
          };
          const rejectsLocally = async (operation) => {
            try { await operation; return false; }
            catch (error) { return localTypeError(error) && blocked(error) && !error.message.includes("node:crypto"); }
          };
          const material = new Uint8Array(16);
          const unsupportedAlgorithm = await rejectsLocally(crypto.subtle.importKey("raw", material, { name: "AES-CBC" }, false, ["encrypt"]));
          const unsupportedUsage = await rejectsLocally(crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["decrypt"]));
          const unsupportedFormat = await rejectsLocally(crypto.subtle.importKey("jwk", material, { name: "AES-GCM" }, false, ["encrypt"]));
          const oversizedKey = await rejectsLocally(crypto.subtle.importKey("raw", new Uint8Array(65537), { name: "AES-GCM" }, false, ["encrypt"]));
          const key = await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt"]);
          const unsupportedEncryptAlgorithm = await rejectsLocally(crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array([1]) }, key, new Uint8Array()));
          const unsupportedTagLength = await rejectsLocally(crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array([1]), tagLength: 80 }, key, new Uint8Array()));
          const oversizedData = await rejectsLocally(crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array([1]) }, key, new Uint8Array(65537)));
          for (let index = 1; index < 8; index += 1) {
            await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt"]);
          }
          const ninthKey = await rejectsLocally(crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt"]));
          return [unsupportedAlgorithm, unsupportedUsage, unsupportedFormat, oversizedKey, unsupportedEncryptAlgorithm,
            unsupportedTagLength, oversizedData, ninthKey].every(Boolean).toString();
        `);
          expect(result.value).toBe("true");
        }),
    );
    testEffect(
      "bounds AES-GCM operations without limiting randomness or FormData",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
          const host: BrowserScriptHost = {
            request: (input) =>
              Effect.sync(() => {
                requests.push(input);
                return {
                  status: 200,
                  url: input.url,
                  headers: [],
                  body: "ok",
                  cookie: "",
                };
              }),
            setCookie: () => Effect.succeed(""),
          };
          const result = yield* runtime.evaluate(
            `
          const key = await crypto.subtle.importKey("raw", new Uint8Array(16), { name: "AES-GCM" }, false, ["encrypt"]);
          const nonce = (value) => {
            const iv = new Uint8Array(12);
            iv[0] = value;
            return iv;
          };
          for (let index = 0; index < 63; index += 1) {
            await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(index) }, key, new Uint8Array());
          }
          let subtleLimited = false;
          try { await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(63) }, key, new Uint8Array()); }
          catch (error) {
            subtleLimited = error instanceof RangeError && error.constructor === RangeError &&
              Object.getPrototypeOf(error) === RangeError.prototype && error.message.includes("budget");
          }
          for (let index = 0; index < 100; index += 1) crypto.getRandomValues(new Uint8Array(1));
          const uuid = crypto.randomUUID();
          const response = await fetch("https://example.test/upload", { method: "POST", body: new FormData() });
          return String(subtleLimited) + "|" + uuid.length + "|" + response.status;
        `,
            {
              url: "https://example.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            host,
          );
          expect(result.value).toBe("true|36|200");
          expect(requests).toHaveLength(1);
          const request = requests[0];
          assert(request);
          const contentType = request.headers.find(
            ([name]) => name === "content-type",
          )?.[1];
          expect(contentType).toMatch(
            /^multipart\/form-data; boundary=----BrowserMockFormBoundary[0-9a-f]{32}$/u,
          );
          expect(multipartRequestBytes(request).byteLength).toBeGreaterThan(0);
        }),
    );
    testEffect(
      "serializes private crypto requests despite Object.prototype.toJSON",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const result = yield* runtime.evaluate(`
          Object.prototype.toJSON = () => ({ op: "invalid" });
          let outputLength = 0;
          try {
            const key = await crypto.subtle.importKey("raw", new Uint8Array(16), { name: "AES-GCM" }, false, ["encrypt"]);
            const output = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, new Uint8Array());
            outputLength = output.byteLength;
          } finally {
            delete Object.prototype.toJSON;
          }
          return String(outputLength);
        `);
          expect(result.value).toBe("16");
        }),
    );
  });

  it.layer(
    BrowserMock.layer({
      allowedOrigins: ["https://allowed.test", "https://cdn.test"],
    }).pipe(Layer.provide(NodeServices.layer)),
    { excludeTestServices: true },
  )("dynamic external scripts", (it) => {
    it.effect(
      "looks up only attached modeled nodes with live readonly collections",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
          const host: BrowserScriptHost = {
            setCookie: () => Effect.succeed(""),
            request: (input) =>
              Effect.sync(() => {
                requests.push(input);
                return {
                  status: 200,
                  url: input.url,
                  headers: [],
                  cookie: "",
                  body: "globalThis.lookupExecutions = (globalThis.lookupExecutions || 0) + 1;",
                };
              }),
          };
          const result = yield* runtime.evaluate(
            `
          const query = (name) => document.getElementsByTagName(name);
          const scripts = query("SCRIPT");
          const checks = [scripts.length === 0, scripts[0] === undefined, scripts.item(0) === null,
            !(0 in scripts), 0 in query("head"), 0 in query("body"),
            ["length", "item", "namedItem"].every((key) => key in scripts), Symbol.iterator in scripts,
            query("head")[0] === document.head, query("BODY").item(0) === document.body,
            [...query("head")][0] === document.head, query("head").length === 1,
            query("script") === scripts, !Array.isArray(scripts), Object.isFrozen(scripts) === true,
            Reflect.isExtensible(scripts) === false];
          const localReject = (fn) => { try { fn(); return false; } catch (e) { return e instanceof TypeError && e.constructor === TypeError; } };
          checks.push(["*", "div", "iframe", " script ", "ſcript"].every((tag) => localReject(() => query(tag))),
            localReject(() => scripts.namedItem("id")), Object.getPrototypeOf(scripts) === null,
            localReject(() => { scripts[0] = document.head; }), localReject(() => { scripts.length = 100; }),
            localReject(() => Object.defineProperty(scripts, "0", { value: document.head })),
            localReject(() => Object.preventExtensions(scripts)),
            localReject(() => Object.setPrototypeOf(scripts, {})), localReject(() => { delete scripts.item; }),
            !Reflect.set(document, "head", {}), !Reflect.set(document, "body", {}),
            query("head") === query("HEAD"), query("body") === query("BODY"),
            localReject(() => scripts.item(0n)));
          const constructorChecks = [["query", query], ["item", scripts.item],
            ["iterator", scripts[Symbol.iterator]], ["appendChild", document.head.appendChild]].map(([name, fn]) => {
              try { return [name, fn.constructor.constructor("return typeof process")() === "undefined"]; }
              catch (error) { return [name, error instanceof ReferenceError && error.message === "process is not defined"]; }
            });
          checks.push(...constructorChecks.map(([, safe]) => safe));
          checks.push(typeof __receive === "undefined", typeof __consumeBudget === "undefined", typeof __post === "undefined");
          const unattached = document.createElement("script");
          checks.push(scripts.length === 0);
          const loaded = [];
          const attach = (parent, id) => {
            const script = document.createElement("script"); script.src = "/" + id + ".js";
            loaded.push(new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; }));
            checks.push(parent.appendChild(script) === script); return script;
          };
          const body = attach(document.body, "body");
          const head = attach(document.head, "head");
          checks.push(scripts.length === 2, scripts[0] === head, scripts.item(1) === body,
            0 in scripts, 1 in scripts, !(2 in scripts),
            scripts[2] === undefined, scripts.item(2) === null, scripts.item(-1) === null,
            scripts.item("0") === head, [...scripts][0] === head);
          document.head.appendChild(head); document.body.appendChild(head);
          checks.push(scripts.length === 2, scripts[0] === head, 0 in scripts, 1 in scripts, !(2 in scripts));
          const third = attach(query("head")[0], "third");
          checks.push(scripts.length === 3, scripts[1] === third, scripts[2] === body, [...scripts].length === 3,
            0 in scripts, 1 in scripts, 2 in scripts, !(3 in scripts), !("01" in scripts), !("1.0" in scripts));
          for (let i = 0; i < 1000; i++) checks.push(query("script") === scripts);
          for (let i = 0; i < 28; i++) document.createElement("script");
          try { document.createElement("script"); checks.push(false); } catch (e) { checks.push(e instanceof RangeError && e.message.includes("32 nodes")); }
          checks.push(scripts.length === 3, ![...scripts].includes(unattached));
          await Promise.all(loaded);
          checks.push(lookupExecutions === 3);
          return String(checks.every(Boolean)) + "|" + constructorChecks.filter(([, safe]) => !safe).map(([name]) => name).join(",");
        `,
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            host,
          );
          expect(result.value).toBe("true|");
          expect(requests.map(({ url }) => url)).toEqual([
            "https://allowed.test/body.js",
            "https://allowed.test/head.js",
            "https://allowed.test/third.js",
          ]);
        }),
    );

    it.effect(
      "keeps modeled lookup collections local to each child realm",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
          const host: BrowserScriptHost = {
            ...recordingScriptHost(requests),
            request: (input) =>
              Effect.sync(() => {
                requests.push(input);
                return {
                  status: 200,
                  url: input.url,
                  headers: [],
                  cookie: "",
                  body: "globalThis.parentLoaded = true;",
                };
              }),
            loadFrame: (url) =>
              Effect.succeed({
                parentUrl: "https://allowed.test/page",
                url,
                origin: "https://allowed.test",
                status: 200,
                headers: [],
                cookie: null,
                scripts: [
                  `
              const scripts = document.getElementsByTagName("script");
              if (scripts.length !== 0 || document.getElementsByTagName("head")[0] !== document.head ||
                  document.getElementsByTagName("body").item(0) !== document.body ||
                  typeof parentLoaded !== "undefined" || typeof __receive !== "undefined" || typeof __post !== "undefined") throw new Error("child lookup leaked");
              const created = document.createElement("script"); created.src = "/child.js";
              try { document.head.appendChild(created); throw new Error("child script accepted"); }
              catch (e) { if (!(e instanceof TypeError)) throw e; }
              if (scripts.length !== 0) throw new Error("unattached child script visible");
              try { scripts.item.constructor("return process")(); throw new Error("constructor escaped"); }
              catch (e) { if (!(e instanceof ReferenceError && e.message === "process is not defined")) throw e; }
            `,
                ],
              }),
          };
          const result = yield* runtime.evaluate(
            `
          const scripts = document.getElementsByTagName("script");
          const script = document.createElement("script"); script.src = "/parent.js";
          await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
          const frame = document.createElement("iframe"); frame.src = "/frame";
          const outcome = await new Promise((resolve) => { frame.onload = () => resolve("load"); frame.onerror = () => resolve("error"); document.body.appendChild(frame); });
          return [outcome, scripts.length, scripts[0] === script, frame.contentDocument === null, frame.contentWindow.document === undefined].join("|");
        `,
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            host,
          );
          expect(result.value).toBe("load|1|true|true|true");
          expect(requests).toHaveLength(1);
        }),
    );

    it.effect(
      "executes before load, preserves URLs, and deduplicates append",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
          const host: BrowserScriptHost = {
            setCookie: () => Effect.succeed(""),
            request: (input) =>
              Effect.sync(() => {
                requests.push(input);
                return {
                  status: 200,
                  url: input.url,
                  headers: [],
                  cookie: "",
                  body: "globalThis.executed = (globalThis.executed || 0) + 1;",
                };
              }),
          };
          yield* Effect.forEach(
            ["head", "body"],
            Effect.fnUntraced(function* (parent) {
              const result = yield* runtime.evaluate(
                `
            const script = document.createElement("SCRIPT");
            script.setAttribute("src", "../asset.js?x=%2F#frag");
            script.type = "text/javascript";
            script.nonce = "fixture";
            const removed = () => { throw new Error("removed listener ran"); };
            script.addEventListener("load", removed);
            script.removeEventListener("load", removed);
            let calls = 0;
            script.addEventListener("load", () => calls++, { once: true });
            const loaded = new Promise((resolve, reject) => {
              script.onload = function(event) {
                resolve([executed, calls, event instanceof Event, !event.isTrusted,
                  event.target === script, event.currentTarget === script, this === script].join("|"));
              };
              script.onerror = () => reject(new Error("unexpected load error"));
            });
            const same = document.${parent}.appendChild(script) === script;
            document.body.appendChild(script);
            let escaped = false;
            try { script.setAttribute.constructor("return process")(); } catch (error) { escaped = error instanceof ReferenceError && error.message === "process is not defined"; }
            return [same, script.async, script.src, script.getAttribute("src"), escaped, await loaded].join("~");
          `,
                {
                  url: "https://allowed.test/path/page",
                  cookie: "",
                  userAgent: "fixture",
                },
                host,
              );
              expect(result.value).toBe(
                "true~true~https://allowed.test/asset.js?x=%2F#frag~../asset.js?x=%2F#frag~true~1|1|true|true|true|true|true",
              );
            }),
          );
          expect(requests.map(({ kind, url }) => [kind, url])).toEqual([
            ["script", "https://allowed.test/asset.js?x=%2F"],
            ["script", "https://allowed.test/asset.js?x=%2F"],
          ]);
          const calls: Call[] = [];
          let scriptValue = "";
          const browser = fromSession(
            session(calls, (url) =>
              url === "https://allowed.test/page"
                ? response(url, 202, "challenge", [
                    ["x-amzn-waf-action", "challenge"],
                  ])
                : response(url, 200, 'globalThis.cdnLoaded = "executed";'),
            ),
            Chrome152Identity,
            {
              scriptRuntime: runtime,
              challengeHandler: (_challenge, context) =>
                context
                  .evaluate(`
              return await new Promise((resolve) => {
                const script = document.createElement("script");
                script.src = "https://cdn.test/external.js";
                script.onload = () => resolve(cdnLoaded);
                script.onerror = () => resolve("error");
                document.head.appendChild(script);
              });
            `)
                  .pipe(
                    Effect.tap((value) =>
                      Effect.sync(() => {
                        scriptValue = value;
                      }),
                    ),
                    Effect.flatMap(() => Effect.succeedNone),
                  ),
            },
          );
          const page = yield* browser.navigate("https://allowed.test/page");
          expect(scriptValue).toBe("executed");
          expect(calls).toHaveLength(2);
          expect(calls[1]?.options?.omitCredentials).toBe(true);
          yield* page.close;
        }),
    );

    it.effect("rejects unsupported modes and bounds nodes and attributes", () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
        const result = yield* runtime.evaluate(
          `
          const script = document.createElement("script");
          script.src = "/asset.js";
          const probes = [
            () => document.createElement("canvas"),
            () => document.head.appendChild({ src: "/asset.js" }),
            () => document.body.appendChild(document.createElement("script")),
            () => { script.text = "globalThis.inline = true"; },
            () => { script.textContent = "code"; },
            () => { script.innerHTML = "code"; },
            () => { script.type = "module"; },
            () => script.setAttribute("type", "application/json"),
            () => { script.integrity = "sha256-unverified"; },
            () => { script.crossOrigin = "use-credentials"; },
            () => script.setAttribute("crossorigin", "anonymous"),
            () => { script.async = false; },
            () => { script.defer = true; },
            () => script.setAttribute("nomodule", ""),
            () => script.setAttribute("onclick", "code"),
          ];
          const rejected = probes.every((probe) => { try { probe(); return false; } catch (error) { return error instanceof TypeError; } });
          let nodes = false;
          try { for (let i = 0; i < 32; i++) document.createElement("script"); } catch (error) { nodes = error instanceof RangeError && error.message.includes("32 nodes"); }
          let attributes = false;
          try { for (let i = 0; i < 3; i++) script.id = "x".repeat(8192); } catch (error) { attributes = error instanceof RangeError && error.message.includes("16 KiB"); }
          return [rejected, nodes, attributes, script.async, script.type, typeof inline].join("|");
        `,
          {
            url: "https://allowed.test/page",
            cookie: "",
            userAgent: "fixture",
          },
          recordingScriptHost(requests),
        );
        expect(result.value).toBe("true|true|true|true||undefined");
        expect(requests).toHaveLength(0);

        const blockedScripts = [
          {
            name: "empty crossorigin attribute",
            configure: 'script.setAttribute("crossorigin", "");',
          },
          {
            name: "nonempty crossorigin attribute",
            configure: 'script.setAttribute("crossorigin", "anonymous");',
          },
          {
            name: "crossOrigin property",
            configure: 'script.crossOrigin = "anonymous";',
          },
          { name: "defer", configure: "script.defer = true;" },
          {
            name: "nomodule",
            configure: 'script.setAttribute("nomodule", "");',
          },
          { name: "module type", configure: 'script.type = "module";' },
          {
            name: "integrity",
            configure: 'script.integrity = "sha256-unverified";',
          },
        ];
        yield* Effect.forEach(
          blockedScripts,
          Effect.fnUntraced(function* (testCase) {
            const scriptRequests: Parameters<
              BrowserScriptHost["request"]
            >[0][] = [];
            const error = yield* Effect.flip(
              runtime.evaluate(
                `
                  const script = document.createElement("script");
                  script.src = "/asset.js";
                  ${testCase.configure}
                  document.head.appendChild(script);
                  return "unexpected success";
                `,
                {
                  url: "https://allowed.test/page",
                  cookie: "",
                  userAgent: "fixture",
                },
                recordingScriptHost(scriptRequests),
              ),
            );
            expect(error, testCase.name).toBeInstanceOf(BrowserScriptError);
            expect(scriptRequests, testCase.name).toHaveLength(0);
          }),
        );
      }),
    );

    it.effect("separates script resource and execution errors", () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        yield* Effect.forEach(
          ["http", "network", "throw", "bytes"],
          Effect.fnUntraced(function* (failure) {
            const host: BrowserScriptHost = {
              request: (input) =>
                failure === "network"
                  ? Effect.fail(
                      new BrowserScriptError({
                        reason: "fixture network failure",
                      }),
                    )
                  : Effect.succeed({
                      status: failure === "http" ? 404 : 200,
                      url: input.url,
                      headers: [],
                      cookie: "",
                      body:
                        failure === "bytes"
                          ? " ".repeat(1024 * 1024 + 1)
                          : 'throw new Error("fixture evaluation failure");',
                    }),
              setCookie: () => Effect.succeed(""),
            };
            const result = yield* runtime.evaluate(
              `
            return await new Promise((resolve) => {
              let windowErrors = 0;
              window.addEventListener("error", () => windowErrors++);
              const script = document.createElement("script"); script.src = "/failure.js";
              script.onload = () => resolve("load|" + windowErrors);
              script.onerror = (event) => resolve([event.type, !event.isTrusted, event.target === script, event instanceof Event].join("|"));
              document.head.appendChild(script);
            });
          `,
              {
                url: "https://allowed.test/page",
                cookie: "",
                userAgent: "fixture",
              },
              host,
            );
            expect(result.value).toBe(
              failure === "throw" ? "load|1" : "error|true|true|true",
            );
          }),
        );
      }),
    );

    for (const kind of ["runtime", "syntax", "muted"]) {
      it.effect(
        "reports classic script exceptions with realm-owned ErrorEvents: " +
          kind,
        () =>
          Effect.gen(function* () {
            const runtime = yield* BrowserMock;
            const result = yield* runtime.evaluate(
              `
                const kind = "${kind}";
                const order = [];
                let reported, legacyArgs, legacyThis;
                window.addEventListener("error", (event) => { reported = event; order.push("window"); });
                window.onerror = function(...args) { legacyArgs = args; legacyThis = this; return true; };
                const blocked = (value) => {
                  try { value.constructor.constructor("return process")(); return false; }
                  catch (error) { return error instanceof ReferenceError && error.message === "process is not defined"; }
                };
                const script = document.createElement("script"); script.src = "/authored.js";
                const outcome = await new Promise((resolve) => {
                  script.onload = () => { order.push("load"); resolve("load"); };
                  script.onerror = () => resolve("element-error");
                  document.head.appendChild(script);
                });
                if (!reported) return outcome;
                const muted = kind === "muted";
                const ExpectedError = kind === "syntax" ? SyntaxError : TypeError;
                const localError = muted ? reported.error === null :
                  reported.error instanceof ExpectedError &&
                  Object.getPrototypeOf(reported.error) === ExpectedError.prototype &&
                  Object.getPrototypeOf(ExpectedError.prototype) === Error.prototype && blocked(reported.error);
                return JSON.stringify({
                  outcome, order, type: reported.type, cancelable: reported.cancelable,
                  trusted: reported.isTrusted, canceled: reported.defaultPrevented,
                  localEvent: reported instanceof ErrorEvent && reported instanceof Event &&
                    Object.getPrototypeOf(reported) === ErrorEvent.prototype &&
                    Object.getPrototypeOf(ErrorEvent.prototype) === Event.prototype && blocked(reported),
                  message: muted ? reported.message === "Script error." :
                    kind === "syntax" ? reported.message.length > 0 : reported.message.includes("authored TypeError"),
                  filename: reported.filename, lineno: reported.lineno, colno: reported.colno, localError,
                  legacy: legacyArgs.length === 5 && legacyThis === window &&
                    legacyArgs[0] === reported.message && legacyArgs[1] === reported.filename &&
                    legacyArgs[2] === 0 && legacyArgs[3] === 0 && legacyArgs[4] === reported.error,
                  privateAbsent: typeof __scriptErrorReporter === "undefined" &&
                    !("__scriptErrorReporter" in window),
                });
              `,
              {
                url: "https://allowed.test/page",
                cookie: "",
                userAgent: "fixture",
              },
              {
                request: () =>
                  Effect.succeed({
                    status: 200,
                    url:
                      kind === "muted"
                        ? "https://cdn.test/final.js"
                        : "https://allowed.test/final.js",
                    headers: [],
                    cookie: "",
                    body:
                      kind === "syntax"
                        ? "const authored = ;"
                        : 'throw new TypeError("authored TypeError");',
                  }),
                setCookie: () => Effect.succeed(""),
              },
            );
            expect(result.value).not.toBe("element-error");
            const report = yield* Schema.decodeEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  outcome: Schema.String,
                  order: Schema.Array(Schema.String),
                  type: Schema.String,
                  cancelable: Schema.Boolean,
                  trusted: Schema.Boolean,
                  canceled: Schema.Boolean,
                  localEvent: Schema.Boolean,
                  message: Schema.Boolean,
                  filename: Schema.String,
                  lineno: Schema.Finite,
                  colno: Schema.Finite,
                  localError: Schema.Boolean,
                  legacy: Schema.Boolean,
                  privateAbsent: Schema.Boolean,
                }),
              ),
            )(result.value);
            expect(report).toEqual({
              outcome: "load",
              order: ["window", "load"],
              type: "error",
              cancelable: true,
              trusted: false,
              canceled: true,
              localEvent: true,
              message: true,
              filename: kind === "muted" ? "" : "https://allowed.test/final.js",
              lineno: 0,
              colno: 0,
              localError: true,
              legacy: true,
              privateAbsent: true,
            });
          }),
      );
    }

    for (const kind of ["proxy", "prototype"]) {
      it.effect(
        "reports script exceptions without host prototype traps: " + kind,
        () =>
          Effect.gen(function* () {
            const runtime = yield* BrowserMock;
            const result = yield* runtime.evaluate(
              `
                globalThis.prototypeTrapCalls = 0;
                const order = [];
                window.addEventListener("error", (event) => {
                  order.push(event instanceof ErrorEvent && event.error === globalThis.thrownValue ? "window" : "wrong-error");
                });
                const script = document.createElement("script"); script.src = "/proxy.js";
                await new Promise((resolve) => {
                  script.onload = () => { order.push("load"); resolve(); };
                  script.onerror = () => { order.push("element-error"); resolve(); };
                  document.head.appendChild(script);
                });
                return order.join("|") + "|" + prototypeTrapCalls;
              `,
              {
                url: "https://allowed.test/page",
                cookie: "",
                userAgent: "fixture",
              },
              {
                request: (input) =>
                  Effect.succeed({
                    status: 200,
                    url: input.url,
                    headers: [],
                    cookie: "",
                    body: `
                      const proxy = new Proxy(new TypeError("authored proxy failure"), {
                        getPrototypeOf() {
                          globalThis.prototypeTrapCalls++;
                          throw new Error("prototype trap must not run on the host");
                        },
                      });
                      globalThis.thrownValue = ${kind === "proxy" ? "proxy" : 'Object.setPrototypeOf(new TypeError("authored prototype failure"), proxy)'};
                      throw globalThis.thrownValue;
                    `,
                  }),
                setCookie: () => Effect.succeed(""),
              },
            );
            expect(result.value).toBe("window|load|0");
          }),
      );
    }

    it.effect("preserves script-element VM timeout failure", () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const error = yield* Effect.flip(
          runtime.evaluate(
            `
              const script = document.createElement("script"); script.src = "/loop.js";
              return await new Promise((resolve) => {
                window.onerror = () => resolve("unexpected window error");
                script.onload = () => resolve("unexpected load");
                document.head.appendChild(script);
              });
            `,
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            {
              request: (input) =>
                Effect.succeed({
                  status: 200,
                  url: input.url,
                  headers: [],
                  cookie: "",
                  body: "while (true) {}",
                }),
              setCookie: () => Effect.succeed(""),
            },
          ),
        );
        expect(error).toBeInstanceOf(BrowserScriptError);
        expect(error.reason).toMatch(/timed out|timeout/i);
      }).pipe(
        Effect.provide(
          BrowserMock.layer({ timeoutMs: 500 }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );

    it.effect("preserves direct script-loader typed execution rejection", () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const error = yield* Effect.flip(
          runtime.evaluate(
            'await document.loadScript("/direct.js");',
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            {
              request: (input) =>
                Effect.succeed({
                  status: 200,
                  url: input.url,
                  headers: [],
                  cookie: "",
                  body: 'throw new TypeError("authored direct failure");',
                }),
              setCookie: () => Effect.succeed(""),
            },
          ),
        );
        expect(error).toBeInstanceOf(BrowserScriptError);
        expect(error.reason).toBe(
          "loaded script failed: authored direct failure",
        );
      }),
    );

    it.effect(
      "reports throwing external-script load callbacks and continues",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
          const result = yield* runtime.evaluate(
            `
            let callbackCalls = 0;
            let thrown;
            const reports = [];
            window.addEventListener("error", (event) => reports.push(event));
            window.onerror = () => true;
            const script = document.createElement("script");
            script.src = "/callback.js";
            const loaded = new Promise((resolve) => {
              script.onload = () => {
                const sourceExecuted = globalThis.externalScriptExecuted === true;
                callbackCalls += 1;
                thrown = new Error("synthetic onload callback failure:" + sourceExecuted + ":" + callbackCalls);
                resolve();
                throw thrown;
              };
            });
            document.head.appendChild(script);
            await loaded;
            const reported = reports[0];
            return [
              "normal result", callbackCalls, globalThis.externalScriptExecuted === true,
              reports.length, reported.error === thrown, reported.message === thrown.message,
              reported.filename === document.location.href, reported.cancelable,
              reported.defaultPrevented,
            ].join("|");
          `,
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            {
              request: (input) =>
                Effect.sync(() => {
                  requests.push(input);
                  return {
                    status: 200,
                    url: input.url,
                    headers: [],
                    cookie: "",
                    body: "globalThis.externalScriptExecuted = true;",
                  };
                }),
              setCookie: () => Effect.succeed(""),
            },
          );
          expect(result.value).toBe(
            "normal result|1|true|1|true|true|true|true|true",
          );
          expect(requests.map(({ url }) => url)).toEqual([
            "https://allowed.test/callback.js",
          ]);
        }),
    );

    it.effect(
      "inherits origin and request quotas without keeping the root alive",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const requests: Parameters<BrowserScriptHost["request"]>[0][] = [];
          const host: BrowserScriptHost = {
            setCookie: () => Effect.succeed(""),
            request: (input) =>
              Effect.sync(() => {
                requests.push(input);
                return {
                  status: 200,
                  url: input.url,
                  headers: [],
                  cookie: "",
                  body: "",
                };
              }),
          };
          const result = yield* runtime.evaluate(
            `
          const load = (src) => new Promise((resolve) => {
            const script = document.createElement("script"); script.src = src;
            script.onload = () => resolve("load"); script.onerror = () => resolve("error");
            document.head.appendChild(script);
          });
          const denied = await load("https://allowed.test.evil/asset.js");
          const outcomes = [];
          for (let i = 0; i < 9; i++) outcomes.push(await load("/asset.js?i=" + i));
          return denied + "|" + outcomes.join(",");
        `,
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            host,
          );
          // The denied origin consumes the existing request budget too.
          expect(result.value).toBe(
            "error|load,load,load,load,load,load,load,error,error",
          );
          expect(requests).toHaveLength(7);
          let largeRequests = 0;
          const aggregate = yield* runtime.evaluate(
            `
          const load = () => new Promise((resolve) => {
            const script = document.createElement("script"); script.src = "/large.js";
            script.onload = () => resolve("load"); script.onerror = () => resolve("error");
            document.head.appendChild(script);
          });
          return [await load(), await load()].join("|");
        `,
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            {
              request: (input) =>
                Effect.sync(() => {
                  largeRequests += 1;
                  return {
                    status: 200,
                    url: input.url,
                    headers: [],
                    cookie: "",
                    body: " ".repeat(600 * 1024),
                  };
                }),
              setCookie: () => Effect.succeed(""),
            },
          );
          expect(aggregate.value).toBe("load|error");
          expect(largeRequests).toBe(2);
          const unawaited = yield* runtime.evaluate(
            `
          const script = document.createElement("script"); script.src = "/never.js";
          document.head.appendChild(script);
          return "root finished";
        `,
            {
              url: "https://allowed.test/page",
              cookie: "",
              userAgent: "fixture",
            },
            {
              request: () => Effect.never,
              setCookie: () => Effect.succeed(""),
            },
          );
          expect(unawaited.value).toBe("root finished");
        }),
    );
  });

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

describe("frame host", () => {
  const parent = "https://example.test/page";
  const other = "https://frame.test";
  const run = (
    evaluate: (
      host: BrowserScriptHost,
    ) => Effect.Effect<string, BrowserScriptError>,
    reviewer?: BrowserFrameReviewer,
    respond: (url: string) => TlsResponse = (url) =>
      response(url, 200, "<script>unreviewed()</script>"),
    source = "root",
    allowedOrigins = ["https://example.test", other, "http://localhost"],
  ) =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const cookieReads: string[] = [];
      let networkCookie = "initial=1";
      const base = session(calls, respond);
      const transport: TlsSession = {
        ...base,
        request: (url, options) =>
          base.request(url, options).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                // Fake Go authority: omitted credentials suppress response cookie writes too.
                if (
                  options?.omitCredentials !== true &&
                  result.headers.some(([name]) => name === "set-cookie")
                )
                  networkCookie = "network=1";
              }),
            ),
          ),
        scriptCookies: (url, writes) =>
          Effect.sync(() => {
            assert.equal(writes, undefined);
            cookieReads.push(url);
            return networkCookie;
          }),
      };
      const handlers: BrowserHandlers = {
        scriptRuntime: hostRuntime(allowedOrigins, evaluate),
        ...(reviewer === undefined ? {} : { frameReviewer: reviewer }),
        challengeHandler: (_challenge, context) =>
          context
            .evaluate(source)
            .pipe(Effect.flatMap(() => Effect.succeedNone)),
      };
      const browser = fromSession(
        {
          ...transport,
          request: (url, options) =>
            (typeof url === "string" ? url : url.url) === parent
              ? Effect.succeed(
                  response(parent, 202, "challenge", [
                    ["x-amzn-waf-action", "challenge"],
                  ]),
                )
              : transport.request(url, options),
        },
        Chrome152Identity,
        handlers,
      );
      const page = yield* browser.navigate(parent);
      yield* page.close;
      return { calls, cookieReads, networkCookie };
    });
  const load = (host: BrowserScriptHost, url = "/frame") => {
    assert.ok(host.loadFrame);
    return host.loadFrame(url);
  };
  const rejected = (
    effect: Effect.Effect<FrameLoadResult, BrowserScriptError>,
  ) =>
    effect.pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => assert.fail("unexpected frame payload"),
      }),
    );
  const empty: BrowserFrameReviewer = () => Effect.succeedSome({ scripts: [] });

  it.effect("frame host is absent by default even with allowed origins", () =>
    run((host) => {
      expect(host.loadFrame).toBeUndefined();
      return Effect.succeed("ok");
    }).pipe(
      Effect.tap(({ calls }) =>
        Effect.sync(() => expect(calls).toHaveLength(0)),
      ),
    ),
  );

  it.effect(
    "frame host treats HTML only as evidence and stamps iframe headers",
    () =>
      Effect.gen(function* () {
        let frame: FrameLoadResult | undefined;
        const observed = yield* run(
          (host) =>
            load(host, "/frame#ignored").pipe(
              Effect.map((value) => {
                frame = value;
                return "ok";
              }),
            ),
          (candidate) => {
            expect(candidate).toMatchObject({
              parentUrl: parent,
              url: "https://example.test/frame",
              origin: "https://example.test",
              body: "<script>unreviewed()</script>",
            });
            return empty(candidate);
          },
        );
        expect(frame?.scripts).toEqual([]);
        expect(frame?.cookie).toBeNull();
        expect(observed.cookieReads).toEqual([parent]);
        const headers = Object.fromEntries(
          observed.calls[0]?.options?.headers ?? [],
        );
        expect(headers).toMatchObject({
          "sec-fetch-dest": "iframe",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
          "upgrade-insecure-requests": "1",
        });
        expect(headers["accept"]).toContain("text/html");
        expect(headers["sec-fetch-user"]).toBeUndefined();
        expect(headers["origin"]).toBeUndefined();
        expect(observed.calls[0]?.options?.followRedirects).toBe(false);
        expect(observed.calls[0]?.options?.omitCredentials).toBe(false);
      }),
  );

  const invalidDecisions: ReadonlyArray<
    readonly [string, Option.Option<unknown>]
  > = [
    ["declined", Option.none()],
    ["malformed scripts", Option.some({ scripts: [1] })],
    [
      "too many scripts",
      Option.some({ scripts: Array.from({ length: 9 }, () => "") }),
    ],
    ["UTF8 cap", Option.some({ scripts: ["é".repeat(32769)] })],
    [
      "arbitrary cookie grant",
      Option.some({ scripts: [], cookies: { origin: other } }),
    ],
    [
      "invalid cookie policy",
      Option.some({ scripts: [], cookiePolicy: "all" }),
    ],
  ];
  for (const [label, decision] of invalidDecisions) {
    it.effect(`frame host rejects ${label} without returning payload`, () =>
      Effect.gen(function* () {
        const observed = yield* run(
          (host) =>
            Effect.gen(function* () {
              const failure = yield* rejected(load(host));
              expect(failure).toBeInstanceOf(BrowserScriptError);
              return "denied";
            }),
          () =>
            Effect.sync(() => {
              const scripts: ReadonlyArray<string> = [];
              const output = Option.some({ scripts });
              if (Option.isNone(decision)) return Option.none();
              Reflect.set(output, "value", decision.value);
              return output;
            }),
        );
        expect(observed.calls).toHaveLength(1);
      }),
    );
  }

  it.effect(
    "frame host rejects malformed reviewer returns without exposing payload",
    () =>
      Effect.gen(function* () {
        const malformedReturns: ReadonlyArray<readonly [string, unknown]> = [
          ["undefined", undefined],
          ["Option.none", Option.none()],
          ["Promise<Option.none>", Promise.resolve(Option.none())],
        ];
        for (const [label, malformedReturn] of malformedReturns) {
          const validReviewer: BrowserFrameReviewer = () =>
            Effect.succeedSome({ scripts: ["untrusted()"] });
          let reviewerCalls = 0;
          const reviewer = new Proxy(validReviewer, {
            apply: () => {
              reviewerCalls += 1;
              return malformedReturn;
            },
          });
          let returnedFrame: FrameLoadResult | undefined;
          const observed = yield* run(
            (host) =>
              Effect.gen(function* () {
                const failure = yield* rejected(
                  load(host).pipe(
                    Effect.tap((frame) =>
                      Effect.sync(() => {
                        returnedFrame = frame;
                      }),
                    ),
                  ),
                );
                expect(failure, label).toBeInstanceOf(BrowserScriptError);
                expect(failure.reason, label).toContain(
                  "frame reviewer returned a non-Effect",
                );
                return "denied";
              }),
            reviewer,
          );
          expect(reviewerCalls, label).toBe(1);
          expect(returnedFrame, label).toBeUndefined();
          expect(observed.calls, label).toHaveLength(1);
        }
      }),
  );

  it.effect(
    "frame host shares parent and successive review source budgets",
    () =>
      run(
        (host) =>
          Effect.gen(function* () {
            yield* load(host);
            const failure = yield* rejected(load(host));
            expect(failure.reason).toContain("source budget");
            return "ok";
          }),
        () => Effect.succeedSome({ scripts: ["é".repeat(16000)] }),
        undefined,
        "root".repeat(1000),
      ),
  );

  it.effect(
    "frame host projects only final same-origin cookies read-only",
    () =>
      Effect.gen(function* () {
        const observed = yield* run(
          (host) =>
            load(host).pipe(
              Effect.map((value) => {
                expect(value.cookie).toBe("network=1");
                expect(value.headers).toEqual([]);
                return "ok";
              }),
            ),
          () =>
            Effect.succeedSome({
              scripts: ["selected()"],
              cookiePolicy: "same-origin",
            }),
          (url) => response(url, 200, "html", [["set-cookie", "network=1"]]),
        );
        expect(observed.cookieReads).toEqual([
          parent,
          "https://example.test/frame",
        ]);
        expect(observed.networkCookie).toBe("network=1");
      }),
  );

  it.effect(
    "frame host follows allowed redirects but denies cross-origin cookie projection",
    () =>
      Effect.gen(function* () {
        const observed = yield* run(
          (host) =>
            Effect.gen(function* () {
              const failure = yield* rejected(load(host));
              expect(failure.reason).toContain("parent origin");
              return "ok";
            }),
          (candidate) => {
            expect(candidate.url).toBe(other + "/final");
            return Effect.succeedSome({
              scripts: ["selected()"],
              cookiePolicy: "same-origin",
            });
          },
          (url) =>
            url.endsWith("/frame")
              ? response(url, 302, "", [["location", other + "/final#hash"]])
              : response(url, 200, "html", [["set-cookie", "network=1"]]),
        );
        expect(
          observed.calls.map((call) => call.options?.omitCredentials),
        ).toEqual([false, true]);
        expect(observed.cookieReads).toEqual([parent]);
        expect(observed.networkCookie).toBe("initial=1");
      }),
  );

  it.effect(
    "frame host defaults cross-origin cookies to null and suppresses Go credentials",
    () =>
      run(
        (host) =>
          load(host, other + "/frame").pipe(
            Effect.map((value) => {
              expect(value.cookie).toBeNull();
              return "ok";
            }),
          ),
        empty,
        (url) => response(url, 200, "html", [["set-cookie", "network=1"]]),
      ).pipe(
        Effect.tap(({ calls, networkCookie }) =>
          Effect.sync(() => {
            expect(calls[0]?.options?.omitCredentials).toBe(true);
            expect(
              Object.fromEntries(calls[0]?.options?.headers ?? [])[
                "sec-fetch-site"
              ],
            ).toBe("cross-site");
            expect(networkCookie).toBe("initial=1");
          }),
        ),
      ),
  );

  for (const location of [
    "https://denied.test/frame",
    "http://localhost/frame",
  ]) {
    it.effect(`frame host rejects redirect ${location}`, () =>
      run(
        (host) =>
          Effect.gen(function* () {
            const failure = yield* rejected(load(host));
            expect(failure.reason).toMatch(/not allowed|downgrade/u);
            return "ok";
          }),
        empty,
        (url) => response(url, 302, "", [["location", location]]),
      ).pipe(
        Effect.tap(({ calls }) =>
          Effect.sync(() => expect(calls).toHaveLength(1)),
        ),
      ),
    );
  }

  it.effect("frame host denies unallowed initial origins before review", () =>
    run(
      (host) =>
        Effect.gen(function* () {
          const failure = yield* rejected(
            load(host, "https://denied.test/frame"),
          );
          expect(failure.reason).toContain("not allowed");
          return "ok";
        }),
      empty,
    ).pipe(
      Effect.tap(({ calls }) =>
        Effect.sync(() => expect(calls).toHaveLength(0)),
      ),
    ),
  );

  it.effect(
    "frame host caps manual redirects at five and closes responses",
    () =>
      Effect.gen(function* () {
        let closed = 0;
        const observed = yield* run(
          (host) =>
            rejected(load(host)).pipe(
              Effect.map((failure) => {
                expect(failure.reason).toContain("5 hops");
                return "ok";
              }),
            ),
          empty,
          (url) =>
            response(url, 302, "", [["location", "/next"]], () => {
              closed += 1;
            }),
        );
        expect(observed.calls).toHaveLength(6);
        expect(closed).toBe(6);
      }),
  );

  it.effect("frame host rejects an oversized HTML body before review", () =>
    run(
      (host) =>
        rejected(load(host)).pipe(
          Effect.map((failure) => {
            expect(failure.reason).toContain("1 MiB");
            return "ok";
          }),
        ),
      () => Effect.die("oversized HTML must not be reviewed"),
      (url) => response(url, 200, "x".repeat(1024 * 1024 + 1)),
    ),
  );

  it.effect("frame host shares the eight-request budget with fetch", () =>
    run(
      (host) =>
        Effect.gen(function* () {
          yield* host.request({
            kind: "fetch",
            url: "/fetch",
            method: "GET",
            headers: [],
            body: null,
            bodyBytes: null,
          });
          for (let index = 0; index < 7; index++) yield* load(host);
          const failure = yield* rejected(load(host));
          expect(failure.reason).toContain("8 requests");
          return "ok";
        }),
      empty,
    ).pipe(
      Effect.tap(({ calls }) =>
        Effect.sync(() => expect(calls).toHaveLength(8)),
      ),
    ),
  );

  it.effect("frame host shares total bytes with fetch and frame bodies", () =>
    run(
      (host) =>
        Effect.gen(function* () {
          yield* host.request({
            kind: "fetch",
            url: "/fetch",
            method: "GET",
            headers: [],
            body: null,
            bodyBytes: null,
          });
          yield* load(host);
          const failure = yield* rejected(load(host));
          expect(failure.reason).toMatch(/byte budget|1 MiB/u);
          return "ok";
        }),
      empty,
      (url) =>
        response(url, 200, "x".repeat(url.endsWith("/fetch") ? 64000 : 500000)),
    ),
  );
});

describe("caller-reviewed classic execution", () => {
  it.live("keeps classic globals and awaits the script completion", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runBoundedScript(
        runtime,
        `
        var authoredGlobal = 7;
        let authoredLexical = 9;
        Promise.resolve().then(() => String(window.authoredGlobal) + ":" + String(window.authoredLexical));
      `,
        undefined,
        undefined,
        "classic",
      );
      expect(result.value).toBe("7:undefined");
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  it.effect("rejects missing classic capability without async fallback", () =>
    Effect.gen(function* () {
      const runtime: BrowserScriptRuntime = {
        evaluate: () => Effect.die("async fallback must not run"),
      };
      const error = yield* runBoundedScript(
        runtime,
        "var x = 1",
        undefined,
        undefined,
        "classic",
      ).pipe(Effect.flip);
      expect(error.reason).toBe(
        "Runtime does not support classic script evaluation",
      );
    }),
  );
  it.live("does not expose trusted prelude helpers to async guest source", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(
        'return [typeof snapshot, typeof flush, typeof describe].join(":")',
      );
      expect(result.value).toBe("undefined:undefined:undefined");
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  it.effect("validates mode and source before invoking a runtime", () =>
    Effect.gen(function* () {
      let called = false;
      const evaluate = () =>
        Effect.sync(() => {
          called = true;
          return { value: "", setCookies: [] };
        });
      const runtime: BrowserScriptRuntime = {
        evaluate,
        evaluateClassic: evaluate,
      };
      // Simulate an untyped JavaScript caller without a cast or unchecked Effect result.
      const invalidMode = new Proxy<{ readonly mode: "classic" }>(
        { mode: "classic" },
        {
          get: () => "invalid",
        },
      ).mode;
      expect(
        (yield* runBoundedScript(
          runtime,
          "1",
          undefined,
          undefined,
          invalidMode,
        ).pipe(Effect.flip)).reason,
      ).toBe("invalid script execution mode");
      expect(
        (yield* runBoundedScript(
          runtime,
          "x".repeat(65537),
          undefined,
          undefined,
          "classic",
        ).pipe(Effect.flip)).reason,
      ).toBe("script source exceeds the 64 KiB limit");
      expect(called).toBe(false);
    }),
  );
  it.live(
    "shares classic globals with later dynamic classic source and flushes host cookies",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const writes: string[] = [];
        const host: BrowserScriptHost = {
          setCookie: (value) =>
            Effect.sync(() => {
              writes.push(value);
              return "authored=ok";
            }),
          request: (input) =>
            Effect.succeed({
              status: 200,
              url: input.url,
              headers: [],
              cookie: "",
              body: 'document.cookie = "authored=ok"; window.dynamicValue = authoredGlobal + authoredLexical;',
            }),
        };
        const result = yield* runBoundedScript(
          runtime,
          `
        var authoredGlobal = 7; let authoredLexical = 9;
        document.loadScript("/authored.js").then(() => String(window.dynamicValue));
      `,
          {
            url: "https://allowed.test/page",
            cookie: "",
            userAgent: "authored",
          },
          host,
          "classic",
        );
        expect(result.value).toBe("16");
        expect(writes).toEqual(["authored=ok"]);
        expect(result.setCookies).toEqual([]);
      }).pipe(
        Effect.provide(
          BrowserMock.layer({ allowedOrigins: ["https://allowed.test"] }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
  );
  it.live(
    "keeps default async declarations private and accepts undefined classic completion",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        expect(
          (yield* runBoundedScript(
            runtime,
            "var authoredGlobal = 7; return String(window.authoredGlobal);",
          )).value,
        ).toBe("undefined");
        expect(
          (yield* runBoundedScript(
            runtime,
            "var authoredGlobal = 7;",
            undefined,
            undefined,
            "classic",
          )).value,
        ).toBe("");
      }).pipe(
        Effect.provide(
          BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
  );

  it.live(
    "exposes classic challenge evaluation without retrying an undefined result",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const calls: Call[] = [];
        const browser = fromSession(
          session(calls, (url) =>
            response(url, 202, "authored challenge", [
              ["x-amzn-waf-action", "challenge"],
            ]),
          ),
          Chrome152Identity,
          {
            scriptRuntime: runtime,
            challengeHandler: (_challenge, context) =>
              Effect.gen(function* () {
                expect(
                  yield* context.evaluateClassic("var authoredGlobal = 7;"),
                ).toBe("");
                return Option.none();
              }),
          },
        );
        const page = yield* browser.navigate("https://allowed.test/page");
        expect(page.status).toBe(202);
        expect(calls).toHaveLength(1);
        yield* page.close;
      }).pipe(
        Effect.provide(
          BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
  );
  for (const mode of ["async", "classic"] as const) {
    it.live(
      `hides private names and prelude helpers under dynamic code generation in ${mode}`,
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const body = `
          const privateNames = ["__scriptErrorReporter", "__receive", "__post", "__childRealm", "__consumeBudget", "__urlOperation", "__pageUrl", "__pageLocation", "__referrer", "__cookie", "__userAgent", "__languages", "__authoritativeCookies", "__performanceNow", "__performanceTimeOrigin", "__randomBytes", "__cryptoOperation", "__encodeBlobText", "__decodeBlobText", "__cookieSnapshot", "__cookieFlush", "__safeMessage", "__dispatch", "__incoming"];
          const hidden = privateNames.every((key) => !(key in window));
          const helpers = [typeof snapshot, typeof flush, typeof describe].join(":");
          let blocked = false;
          try { document.loadScript.constructor("return process")(); } catch (error) { blocked = error instanceof ReferenceError && error.message === "process is not defined"; }
          const outcome = Promise.resolve().then(() => String(hidden && helpers === "undefined:undefined:undefined" && blocked && privateNames.every((key) => !(key in window))));
        `;
          const source =
            body + (mode === "async" ? "return outcome;" : "outcome;");
          expect(
            (yield* runBoundedScript(
              runtime,
              source,
              undefined,
              undefined,
              mode,
            )).value,
          ).toBe("true");
        }).pipe(
          Effect.provide(
            BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
    );
    it.live(
      `does not elevate network permission or modeled node quota in ${mode}`,
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const body = `const denied = fetch("https://blocked.test/authored").then(() => false, () => true);
          for (let i = 0; i < 32; i++) document.createElement("script");
          let capped = false; try { document.createElement("script"); } catch (error) { capped = error instanceof RangeError; }
          const outcome = denied.then((blocked) => String(blocked && capped));`;
          expect(
            (yield* runBoundedScript(
              runtime,
              body + (mode === "async" ? "return outcome;" : "outcome;"),
              undefined,
              undefined,
              mode,
            )).value,
          ).toBe("true");
        }).pipe(
          Effect.provide(
            BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
    );
    for (const collision of [
      "var __dispatch;",
      'Object.defineProperty(window, "__dispatch", { get() { throw new Error("getter invoked"); }, set(value) { throw new Error("receiver exposed"); }, configurable: false });',
      'Object.defineProperty(window, "__incoming", { value: 1, configurable: false });',
    ]) {
      it.live(
        `rejects delivery collisions before exposing trusted callbacks in ${mode}: ${collision}`,
        () =>
          Effect.gen(function* () {
            const runtime = yield* BrowserMock;
            // Async local var is intentionally private; explicitly create the global collision.
            const declaration =
              mode === "async" && collision === "var __dispatch;"
                ? "window.__dispatch = undefined;"
                : collision;
            const source =
              declaration + (mode === "async" ? ' return "ok";' : ' "ok";');
            const error = yield* runBoundedScript(
              runtime,
              source,
              undefined,
              undefined,
              mode,
            ).pipe(Effect.flip);
            expect(error.reason).toContain(
              "private delivery binding collision",
            );
            expect(error.reason).not.toContain("receiver exposed");
            expect(error.reason).not.toContain("getter invoked");
          }).pipe(
            Effect.provide(
              BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
            ),
          ),
      );
    }
    it.live(`preserves early failure and timer deadlines in ${mode}`, () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const early = yield* runBoundedScript(
          runtime,
          'throw new Error("authored failure")',
          undefined,
          undefined,
          mode,
        ).pipe(Effect.flip);
        expect(early.reason).toBe("authored failure");
        const synchronous = yield* runBoundedScript(
          runtime,
          "while (true) {}",
          undefined,
          undefined,
          mode,
        ).pipe(Effect.flip);
        expect(synchronous.reason).toMatch(/timed out|timeout/i);
        const promise =
          "new Promise(() => { setTimeout(() => { while (true) {} }, 1); })";
        const error = yield* runBoundedScript(
          runtime,
          mode === "async" ? "return " + promise : promise,
          undefined,
          undefined,
          mode,
        ).pipe(Effect.flip);
        expect(error.reason).toMatch(/timed out|timeout/i);
      }).pipe(
        Effect.provide(
          BrowserMock.layer({ timeoutMs: 500 }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
  }

  for (const mode of ["async", "classic"] as const) {
    const frameContext = {
      url: "https://allowed.test/page",
      cookie: "root=private",
      userAgent: "authored",
    };
    const frameHost = (scripts: readonly string[]): BrowserScriptHost => ({
      request: () => Effect.die("frame must not gain network permission"),
      setCookie: () => Effect.die("frame must not gain cookie writes"),
      loadFrame: (url) =>
        Effect.succeed({
          parentUrl: frameContext.url,
          url,
          origin: "https://allowed.test",
          status: 200,
          headers: [],
          cookie: null,
          scripts,
        }),
    });
    const frameSource =
      `const frame = document.createElement("iframe"); frame.src = "/frame";
      const done = new Promise((resolve, reject) => { frame.onload = () => resolve("loaded"); frame.onerror = reject; document.body.appendChild(frame); });` +
      (mode === "async" ? "return await done;" : "done;");
    it.live(
      `hides private globals in child realms under ${mode} root execution`,
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const child = `const names = ["__scriptErrorReporter", "__receive", "__post", "__childRealm", "__consumeBudget", "__urlOperation", "__pageUrl", "__pageLocation", "__referrer", "__cookie", "__userAgent", "__languages", "__authoritativeCookies", "__performanceNow", "__performanceTimeOrigin", "__randomBytes", "__cryptoOperation", "__encodeBlobText", "__decodeBlobText", "__cookieSnapshot", "__cookieFlush", "__safeMessage"];
          if (!names.every((key) => !(key in window)) || typeof snapshot !== "undefined" || typeof flush !== "undefined" || typeof describe !== "undefined") throw new Error("private child binding leaked");
          let blocked = false; try { document.createElement.constructor("return process")(); } catch (error) { blocked = error instanceof ReferenceError && error.message === "process is not defined"; }
          if (!blocked) throw new Error("Node globals escaped through child code generation");`;
          expect(
            (yield* runBoundedScript(
              runtime,
              frameSource,
              frameContext,
              frameHost([child]),
              mode,
            )).value,
          ).toBe("loaded");
        }).pipe(
          Effect.provide(
            BrowserMock.layer({
              allowedOrigins: ["https://allowed.test"],
            }).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
    );
    it.live(
      `clamps child scripts to the shared root deadline under ${mode}`,
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const error = yield* runBoundedScript(
            runtime,
            frameSource,
            frameContext,
            frameHost(["while (true) {}"]),
            mode,
          ).pipe(Effect.flip);
          expect(error.reason).toMatch(/timed out|timeout/i);
        }).pipe(
          Effect.provide(
            BrowserMock.layer({
              allowedOrigins: ["https://allowed.test"],
              timeoutMs: 500,
            }).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
    );
  }
});

describe("modeled exact ID lookup", () => {
  for (const mode of ["async", "classic"] as const) {
    it.live(`finds actual attached nodes by live exact ID in ${mode}`, () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const context = {
          url: "https://allowed.test/page",
          cookie: "",
          userAgent: "authored",
        };
        const host: BrowserScriptHost = {
          request: (input) =>
            Effect.succeed({
              status: 200,
              url: input.url,
              headers: [],
              cookie: "",
              body: "",
            }),
          setCookie: () => Effect.die("lookup must not write cookies"),
          loadFrame: (url) =>
            Effect.succeed({
              parentUrl: context.url,
              url,
              origin: "https://allowed.test",
              status: 200,
              headers: [],
              cookie: null,
              scripts: [],
            }),
        };
        const body = `
          const lookup = (id) => document.getElementById(id);
          const checks = [lookup("") === null, lookup("missing") === null, lookup("cmsg") === null,
            lookup("head") === null, lookup("body") === null];
          const detached = document.createElement("script"); detached.id = "detached";
          const frame = document.createElement("iframe"); frame.src = "/frame"; frame.id = "shared";
          checks.push(lookup("detached") === null, lookup("shared") === null);
          const loaded = [];
          const attach = (node, parent) => {
            loaded.push(new Promise((resolve, reject) => { node.onload = resolve; node.onerror = reject; }));
            checks.push(parent.appendChild(node) === node);
          };
          attach(frame, document.body);
          const bodyScript = document.createElement("script"); bodyScript.src = "/body.js"; bodyScript.id = "shared";
          attach(bodyScript, document.body);
          checks.push(lookup("shared") === frame);
          const headScript = document.createElement("script"); headScript.src = "/head.js"; headScript.setAttribute("id", "shared");
          attach(headScript, document.head);
          const headFrame = document.createElement("iframe"); headFrame.src = "/frame2"; headFrame.id = "shared";
          attach(headFrame, document.head);
          checks.push(lookup("shared") === headScript);
          document.body.appendChild(headScript); document.head.appendChild(frame);
          checks.push(lookup("shared") === headScript, document.getElementsByTagName("script").length === 2);
          headScript.id = "Changed";
          checks.push(lookup("shared") === headFrame, lookup("Changed") === headScript, lookup("changed") === null);
          headFrame.setAttribute("id", "frameChanged");
          checks.push(lookup("shared") === frame, lookup("frameChanged") === headFrame);
          frame.id = "";
          checks.push(lookup("shared") === bodyScript, lookup("") === null);
          bodyScript.removeAttribute("id");
          checks.push(lookup("shared") === null);
          headScript.setAttribute("id", 42);
          checks.push(lookup(42) === headScript, lookup({ toString() { return "42"; } }) === headScript);
          headScript.id = null; checks.push(lookup(null) === headScript);
          headScript.id = undefined; checks.push(lookup(undefined) === headScript);
          for (const operation of [() => document.getElementById(), () => lookup(Symbol("id"))]) {
            try { operation(); checks.push(false); } catch (error) { checks.push(error instanceof TypeError); }
          }
          try { document.getElementById.constructor("return process")(); checks.push(false); }
          catch (error) { checks.push(error instanceof ReferenceError && error.message === "process is not defined"); }
          const outcome = Promise.all(loaded).then(() => String(checks.every(Boolean)));`;
        expect(
          (yield* runBoundedScript(
            runtime,
            body + (mode === "async" ? "return outcome;" : "outcome;"),
            context,
            host,
            mode,
          )).value,
        ).toBe("true");
      }).pipe(
        Effect.provide(
          BrowserMock.layer({ allowedOrigins: ["https://allowed.test"] }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
    it.live(`preserves ID attribute and node budgets in ${mode}`, () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const body = `
          const script = document.createElement("script"); script.id = "kept";
          const frame = document.createElement("iframe"); frame.id = "kept-frame";
          const checks = [];
          for (const node of [script, frame]) {
            try { node.id = "x".repeat(8193); checks.push(false); }
            catch (error) { checks.push(error instanceof Error && error.message.includes("8192")); }
          }
          checks.push(script.getAttribute("id") === "kept", frame.getAttribute("id") === "kept-frame");
          script.id = "é".repeat(4000); frame.id = "é".repeat(4000);
          for (const node of [script, frame]) {
            try { node.id = "é".repeat(200); checks.push(false); }
            catch (error) { checks.push(error instanceof RangeError && error.message.includes("16 KiB")); }
            checks.push(node.getAttribute("id") === "é".repeat(4000));
            try { Object.defineProperty(node, "id", { value: "bypass" }); checks.push(false); }
            catch (error) { checks.push(error instanceof TypeError); }
          }
          for (let i = 0; i < 100; i++) checks.push(document.getElementById("kept") === null);
          for (let i = 0; i < 3; i++) document.createElement("iframe");
          try { document.createElement("iframe"); checks.push(false); }
          catch (error) { checks.push(error instanceof RangeError && error.message.includes("4 frames")); }
          for (let i = 0; i < 27; i++) document.createElement("script");
          try { document.createElement("script"); checks.push(false); }
          catch (error) { checks.push(error instanceof RangeError && error.message.includes("32 nodes")); }
          const outcome = String(checks.every(Boolean));`;
        expect(
          (yield* runBoundedScript(
            runtime,
            body + (mode === "async" ? "return outcome;" : "outcome;"),
            undefined,
            undefined,
            mode,
          )).value,
        ).toBe("true");
      }).pipe(
        Effect.provide(
          BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );
    it.live(
      `keeps ID lookup realm-local and reviewed frame identity opaque in ${mode}`,
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const context = {
            url: "https://allowed.test/page",
            cookie: "root=private",
            userAgent: "authored",
          };
          const child = `
          if (document.getElementById("parent-frame") !== null || document.getElementById("cmsg") !== null) throw new Error("parent ID leaked");
          const detached = document.createElement("script"); detached.id = "child-only";
          if (document.getElementById("child-only") !== null) throw new Error("detached child fabricated");
          try { document.head.appendChild(detached); throw new Error("child append allowed"); }
          catch (error) { if (!(error instanceof TypeError)) throw error; }
          if (document.cookie !== "" || typeof parent.document !== "undefined") throw new Error("parent authority leaked");`;
          const host: BrowserScriptHost = {
            request: () => Effect.die("lookup must not grant child network"),
            setCookie: () => Effect.die("lookup must not grant cookie writes"),
            loadFrame: (url) =>
              Effect.succeed({
                parentUrl: context.url,
                url,
                origin: new URL(url).origin,
                status: 200,
                headers: [],
                cookie: null,
                scripts: [child],
              }),
          };
          const body = `
          const frame = document.createElement("iframe"); frame.src = "https://cdn.test/frame"; frame.id = "parent-frame";
          const outcome = new Promise((resolve, reject) => {
            frame.onload = () => resolve(String(document.getElementById("parent-frame") === frame &&
              document.getElementById("child-only") === null && document.getElementById("cmsg") === null &&
              frame.contentDocument === null && typeof frame.contentWindow.document === "undefined"));
            frame.onerror = reject; document.body.appendChild(frame);
          });`;
          expect(
            (yield* runBoundedScript(
              runtime,
              body + (mode === "async" ? "return outcome;" : "outcome;"),
              context,
              host,
              mode,
            )).value,
          ).toBe("true");
        }).pipe(
          Effect.provide(
            BrowserMock.layer({
              allowedOrigins: ["https://allowed.test", "https://cdn.test"],
            }).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
    );
  }
});

describe("atomic bounded src writes", () => {
  for (const mode of ["async", "classic"] as const) {
    it.live(
      `preserves accepted src and denies frame authority after rejected writes in ${mode}`,
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const context = {
            url: "https://page.invalid/root",
            cookie: "",
            userAgent: "authored",
          };
          const host: BrowserScriptHost = {
            request: () =>
              Effect.die("rejected src must not gain network permission"),
            setCookie: () => Effect.die("rejected src must not write cookies"),
            loadFrame: () => Effect.die("denied frame must not reach the host"),
          };
          const body = `
          const frame = document.createElement("iframe");
          const script = document.createElement("script");
          const old = "https://local.invalid/old";
          frame.src = old; script.src = old;
          let used = 2 * (3 + old.length);
          frame.setAttribute("src", "/old"); used += 3 + 4;
          if (frame.src !== "https://page.invalid/old" || frame.getAttribute("src") !== "/old") throw new Error("accepted attribute src is not reflected");
          frame.src = old; used += 3 + old.length;
          const reject = (node, value, attribute, message) => {
            let rejected = false;
            try { if (attribute) node.setAttribute("src", value); else node.src = value; }
            catch (error) { rejected = error instanceof Error && error.message.includes(message); }
            if (!rejected) throw new Error("src write was not rejected: " + message);
            if (node.src !== old || node.getAttribute("src") !== old) throw new Error("rejected src changed accepted state: " + message);
          };
          for (const node of [frame, script]) {
            for (const attribute of [false, true]) {
              reject(node, "x".repeat(8193), attribute, "8192");
            }
          }
          frame.name = "é".repeat(4096); used += 4 + 8192;
          for (const node of [frame, script]) {
            for (const attribute of [false, true]) reject(node, "/" + "é".repeat(4200), attribute, "16 KiB");
          }
          // Fill exactly the shared UTF-8 budget: failed writes must not spend it.
          script.nonce = "x".repeat(16384 - used - 5);
          for (const node of [frame, script]) {
            for (const attribute of [false, true]) reject(node, "/rejected", attribute, "16 KiB");
          }
          const outcome = new Promise((resolve, reject) => {
            frame.onload = () => reject(new Error("denied frame loaded"));
            frame.onerror = () => {
              if (frame.src !== old || frame.getAttribute("src") !== old || frame.contentWindow !== null || frame.contentDocument !== null) reject(new Error("denied frame gained authority"));
              else resolve("denied:old");
            };
            document.body.appendChild(frame);
          });`;
          expect(
            (yield* runBoundedScript(
              runtime,
              body + (mode === "async" ? "return outcome;" : "outcome;"),
              context,
              host,
              mode,
            )).value,
          ).toBe("denied:old");
        }).pipe(
          Effect.provide(
            BrowserMock.layer({
              allowedOrigins: ["https://page.invalid"],
            }).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
    );
  }
});
