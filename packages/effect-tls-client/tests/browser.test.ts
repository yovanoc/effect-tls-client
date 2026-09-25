import assert from "node:assert/strict";
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import * as Schema from "effect/Schema";
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
      return error instanceof EvalError && error.constructor === EvalError &&
        error.message.includes("Code generation");
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
        "return `${typeof __URL}|${typeof __cookieRead}|${typeof __randomBytes}|${typeof URL}|${typeof TextEncoder}|${typeof setTimeout}`;",
      );
      expect(hidden.value).toBe(
        "undefined|undefined|undefined|undefined|undefined|function",
      );
    }).pipe(
      Effect.provide(
        BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
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
          catch (error) { return error instanceof EvalError && error.message.includes("Code generation"); }
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
            catch (error) { return error instanceof EvalError && error.message.includes("Code generation"); }
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
          catch (error) { return error instanceof EvalError && error.message.includes("Code generation"); }
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
            catch (error) { return error instanceof EvalError && error.message.includes("Code generation"); }
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
      expect(hostEscape.reason).toContain("Code generation");
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
