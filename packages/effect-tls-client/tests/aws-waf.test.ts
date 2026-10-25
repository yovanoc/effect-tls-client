import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import * as Cookies from "effect/unstable/http/Cookies";
import type { TlsResponse, TlsSession } from "../src/TlsClient.js";
import {
  BrowserSessionError,
  Chrome152Identity,
  fromSession,
} from "../src/browser/Browser.js";
import {
  BrowserScriptError,
  type BrowserScriptRuntime,
} from "../src/browser/BrowserScript.js";
import {
  awsWafChallengeHandler,
  type AwsWafBootstrap,
  type AwsWafChallengeOptions,
  type AwsWafPage,
  type AwsWafPageScript,
} from "../src/challenges/AwsWaf.js";

const PAGE_URL = "https://assets.example.test/waf";
const ASSET_ORIGIN = "https://assets.example.test";
const CHALLENGE_ASSET = `${ASSET_ORIGIN}/challenge.js`;
const CHALLENGE_HTML = `<script src="${CHALLENGE_ASSET}"></script>`;
const ALLOWED_ORIGINS: AwsWafChallengeOptions["scriptOrigins"] = [ASSET_ORIGIN];
const wafHeaders: TlsResponse["headers"] = [["x-amzn-waf-action", "challenge"]];

const response = (
  url: string,
  body: string,
  status = 202,
  headers: TlsResponse["headers"] = wafHeaders,
): TlsResponse => {
  const bodyBytes = new TextEncoder().encode(body);
  return {
    status,
    url,
    headers,
    protocol: "HTTP/1.1",
    cookies: Cookies.empty,
    bytesRead: Effect.succeed(bodyBytes.byteLength),
    bytesWritten: Effect.succeed(0),
    stream: Stream.succeed(bodyBytes),
    bytes: Effect.succeed(bodyBytes),
    text: Effect.succeed(body),
    json: Effect.succeed({}),
    close: Effect.void,
  };
};

const cookieValue = (jar: Cookies.Cookies): string =>
  Option.match(Cookies.get(jar, "aws-waf-token"), {
    onNone: () => "",
    onSome: (cookie) => cookie.value,
  });

const stubTlsSession = (
  requests: Array<string>,
  respond: (url: string, requestIndex: number) => TlsResponse,
  initialCookies: Cookies.Cookies = Cookies.empty,
  cookieReads: Array<string> = [],
): TlsSession => {
  let jar = initialCookies;
  return {
    id: "aws-waf-test",
    request: (input) =>
      Effect.sync(() => {
        const url = typeof input === "string" ? input : input.url;
        const requestIndex = requests.push(url) - 1;
        return respond(url, requestIndex);
      }),
    webSocket: () => Effect.die("unused WebSocket"),
    cookies: () =>
      Effect.sync(() => {
        cookieReads.push(cookieValue(jar));
        return jar;
      }),
    setCookies: (_url, cookies) =>
      Effect.sync(() => {
        jar = Cookies.merge(jar, cookies);
      }),
    scriptCookies: (_url, setCookies) =>
      Effect.sync(() => {
        if (setCookies !== undefined) {
          jar = Cookies.merge(jar, Cookies.fromSetCookie(setCookies));
        }
        return Option.match(Cookies.get(jar, "aws-waf-token"), {
          onNone: () => "",
          onSome: (cookie) => `${cookie.name}=${cookie.value}`,
        });
      }),
    exportCookies: Effect.succeed("[]"),
    importCookies: () => Effect.void,
    bandwidth: Effect.succeed({ read: 0, written: 0 }),
    resetBandwidth: Effect.void,
    setProxy: () => Effect.void,
  };
};

const hostRuntime = (
  evaluatedSources: Array<string>,
  setCookies: ReadonlyArray<string> = [],
): BrowserScriptRuntime => ({
  allowedOrigins: ALLOWED_ORIGINS,
  evaluate: (source, _context, host) =>
    host === undefined
      ? Effect.fail(
          new BrowserScriptError({ reason: "script host unavailable" }),
        )
      : Effect.sync(() => {
          evaluatedSources.push(source);
          return { value: "observed", setCookies };
        }),
});

const browserFromStub = (
  session: TlsSession,
  handler: ReturnType<typeof awsWafChallengeHandler>,
  evaluatedSources: Array<string>,
  setCookies: ReadonlyArray<string> = [],
) =>
  fromSession(session, Chrome152Identity, {
    challengeHandler: handler,
    scriptRuntime: hostRuntime(evaluatedSources, setCookies),
  });

const external = (url: string): AwsWafPageScript => ({ _tag: "External", url });
const unsupported = (reason: string): AwsWafPageScript => ({
  _tag: "Unsupported",
  reason,
});

type ExternalScript = Extract<AwsWafPageScript, { readonly _tag: "External" }>;
type InlineScript = Extract<AwsWafPageScript, { readonly _tag: "Inline" }>;

const isExternal = (script: AwsWafPageScript): script is ExternalScript =>
  script._tag === "External";
const isInline = (script: AwsWafPageScript): script is InlineScript =>
  script._tag === "Inline";

const withScripts = (
  scripts: [AwsWafPageScript, ...Array<AwsWafPageScript>],
  acquisition?: AwsWafBootstrap["acquisition"],
) => {
  const bootstrap: AwsWafBootstrap =
    acquisition === undefined ? { scripts } : { scripts, acquisition };
  return Effect.succeedSome(bootstrap);
};

const selectChallengeAsset: AwsWafChallengeOptions["bootstrap"] = (page) => {
  const script = page.scripts.find(
    (candidate): candidate is ExternalScript =>
      isExternal(candidate) && candidate.url.endsWith("/challenge.js"),
  );
  return script === undefined ? Effect.succeedNone : withScripts([script]);
};

const handler = (
  bootstrap: AwsWafChallengeOptions["bootstrap"],
  scriptOrigins: AwsWafChallengeOptions["scriptOrigins"] = ALLOWED_ORIGINS,
) => awsWafChallengeHandler({ scriptOrigins, bootstrap });

const expectConfigError = (error: unknown) => {
  expect(error).toBeInstanceOf(BrowserSessionError);
  if (error instanceof BrowserSessionError) {
    expect(error.kind).toBe("Config");
  }
};

describe("AWS WAF challenge handler", () => {
  it.effect(
    "rejects invalid script origins before bootstrap or evaluation",
    () => {
      const requests: Array<string> = [];
      const evaluatedSources: Array<string> = [];
      let bootstrapCalls = 0;
      const invalidOrigins: AwsWafChallengeOptions["scriptOrigins"] = [
        "https://user@assets.example.test",
      ];
      const browser = browserFromStub(
        stubTlsSession(requests, (url) => response(url, CHALLENGE_HTML)),
        handler((page) => {
          bootstrapCalls += 1;
          return selectChallengeAsset(page);
        }, invalidOrigins),
        evaluatedSources,
      );

      return Effect.gen(function* () {
        const error = yield* Effect.flip(browser.navigate(PAGE_URL));
        expectConfigError(error);
        expect(bootstrapCalls).toBe(0);
        expect(evaluatedSources).toEqual([]);
        expect(requests).toEqual([PAGE_URL]);
      });
    },
  );

  it.effect(
    "rejects unallowlisted, non-challenge, unsupported, and empty selections without evaluation or retry",
    () => {
      const emptyBootstrap: AwsWafBootstrap = {
        scripts: [external(CHALLENGE_ASSET)],
      };
      Reflect.set(emptyBootstrap, "scripts", []);
      const cases: ReadonlyArray<{
        readonly bootstrap: AwsWafChallengeOptions["bootstrap"];
        readonly scriptOrigins?: AwsWafChallengeOptions["scriptOrigins"];
      }> = [
        {
          bootstrap: () =>
            withScripts([external("https://other.example.test/challenge.js")]),
        },
        {
          bootstrap: () => withScripts([external(`${ASSET_ORIGIN}/vendor.js`)]),
        },
        {
          bootstrap: () =>
            withScripts([unsupported("module scripts are unsupported")]),
        },
        {
          bootstrap: () => Effect.succeedSome(emptyBootstrap),
        },
      ];

      return Effect.gen(function* () {
        for (const testCase of cases) {
          const requests: Array<string> = [];
          const evaluatedSources: Array<string> = [];
          const browser = browserFromStub(
            stubTlsSession(requests, (url) => response(url, CHALLENGE_HTML)),
            handler(testCase.bootstrap, testCase.scriptOrigins),
            evaluatedSources,
          );
          const error = yield* Effect.flip(browser.navigate(PAGE_URL));
          expectConfigError(error);
          expect(evaluatedSources).toEqual([]);
          expect(requests).toEqual([PAGE_URL]);
        }
      });
    },
  );

  it.effect(
    "does not invoke AWS bootstrap for an ordinary CloudFront 403",
    () => {
      const requests: Array<string> = [];
      const evaluatedSources: Array<string> = [];
      let bootstrapCalls = 0;
      const browser = browserFromStub(
        stubTlsSession(requests, (url) =>
          response(url, "forbidden", 403, [["server", "CloudFront"]]),
        ),
        handler(() => {
          bootstrapCalls += 1;
          return Effect.succeedNone;
        }),
        evaluatedSources,
      );

      return Effect.gen(function* () {
        const page = yield* browser.navigate(PAGE_URL);
        expect(page.status).toBe(403);
        expect(page.challenge).toBeUndefined();
        expect(bootstrapCalls).toBe(0);
        expect(evaluatedSources).toEqual([]);
        expect(requests).toEqual([PAGE_URL]);
        yield* page.close;
      });
    },
  );

  it.effect("leaves a challenge visible when bootstrap declines", () => {
    const requests: Array<string> = [];
    const evaluatedSources: Array<string> = [];
    const browser = browserFromStub(
      stubTlsSession(requests, (url) => response(url, CHALLENGE_HTML)),
      handler(() => Effect.succeedNone),
      evaluatedSources,
    );

    return Effect.gen(function* () {
      const page = yield* browser.navigate(PAGE_URL);
      expect(page.status).toBe(202);
      expect(page.challenge?.kind).toBe("AwsWaf");
      expect(evaluatedSources).toEqual([]);
      expect(requests).toEqual([PAGE_URL]);
      yield* page.close;
    });
  });

  it.effect(
    "serializes the selected URL and preserves bootstrap script order",
    () => {
      const requests: Array<string> = [];
      const evaluatedSources: Array<string> = [];
      const firstUrl = `${ASSET_ORIGIN}/first.js`;
      const quotedChallengeUrl = `${ASSET_ORIGIN}/challenge.js?value=\";window.injected=true;//`;
      const html =
        `<script src="${firstUrl}"></script>` +
        `<script>window.inlineOrder = true;</script>` +
        `<script src='${quotedChallengeUrl}'></script>`;
      const bootstrap: AwsWafChallengeOptions["bootstrap"] = (page) => {
        const first = page.scripts.find(
          (script): script is ExternalScript =>
            isExternal(script) && script.url === firstUrl,
        );
        const middle = page.scripts.find(isInline);
        const challenge = page.scripts.find(
          (script): script is ExternalScript =>
            isExternal(script) && script.url === quotedChallengeUrl,
        );
        return first === undefined ||
          middle === undefined ||
          challenge === undefined
          ? Effect.succeedNone
          : withScripts([challenge, middle, first]);
      };
      const browser = browserFromStub(
        stubTlsSession(requests, (url) => response(url, html)),
        handler(bootstrap),
        evaluatedSources,
      );

      return Effect.gen(function* () {
        const page = yield* browser.navigate(PAGE_URL);
        const source = evaluatedSources[0] ?? "";
        const serializedChallengeUrl = JSON.stringify(
          new URL(quotedChallengeUrl).toString(),
        );
        const challengeLoad = `document.loadScript(${serializedChallengeUrl})`;
        const firstLoad = `document.loadScript(${JSON.stringify(firstUrl)})`;
        expect(evaluatedSources).toHaveLength(1);
        expect(source).toContain(challengeLoad);
        expect(source).toContain("window.inlineOrder = true;");
        expect(source).toContain(firstLoad);
        expect(source.indexOf(challengeLoad)).toBeLessThan(
          source.indexOf("window.inlineOrder = true;"),
        );
        expect(source.indexOf("window.inlineOrder = true;")).toBeLessThan(
          source.indexOf(firstLoad),
        );
        expect(requests).toEqual([PAGE_URL]);
        yield* page.close;
      });
    },
  );

  it.effect(
    "uses the documented public namespace for explicit getToken mode",
    () => {
      const requests: Array<string> = [];
      const evaluatedSources: Array<string> = [];
      const browser = browserFromStub(
        stubTlsSession(requests, (url) => response(url, CHALLENGE_HTML)),
        handler((page) => {
          const script = page.scripts.find(
            (candidate): candidate is ExternalScript =>
              isExternal(candidate) && candidate.url.endsWith("/challenge.js"),
          );
          return script === undefined
            ? Effect.succeedNone
            : withScripts([script], "getToken");
        }),
        evaluatedSources,
      );

      return Effect.gen(function* () {
        const page = yield* browser.navigate(PAGE_URL);
        const source = evaluatedSources[0] ?? "";
        expect(source).toContain("const sdk = window.AwsWafIntegration;");
        expect(source).toContain("await sdk.getToken()");
        expect(evaluatedSources).toHaveLength(1);
        expect(requests).toEqual([PAGE_URL]);
        yield* page.close;
      });
    },
  );

  it.effect(
    "does not add an explicit getToken call in default page mode",
    () => {
      const requests: Array<string> = [];
      const evaluatedSources: Array<string> = [];
      const browser = browserFromStub(
        stubTlsSession(requests, (url) => response(url, CHALLENGE_HTML)),
        handler(selectChallengeAsset),
        evaluatedSources,
      );

      return Effect.gen(function* () {
        const page = yield* browser.navigate(PAGE_URL);
        const source = evaluatedSources[0] ?? "";
        expect(source).toContain("observeAwsAcquisition();");
        expect(source).not.toContain("const token = await sdk.getToken();");
        expect(evaluatedSources).toHaveLength(1);
        expect(requests).toEqual([PAGE_URL]);
        yield* page.close;
      });
    },
  );

  it.effect("does not retry without a new nonempty token cookie", () => {
    const cases: ReadonlyArray<{
      readonly initialCookies: Cookies.Cookies;
      readonly writes: ReadonlyArray<string>;
      readonly expectedReads: ReadonlyArray<string>;
    }> = [
      {
        initialCookies: Cookies.empty,
        writes: [],
        expectedReads: ["", ""],
      },
      {
        initialCookies: Cookies.fromSetCookie("aws-waf-token=stable; Path=/"),
        writes: ["aws-waf-token=stable; Path=/"],
        expectedReads: ["stable", "stable"],
      },
    ];

    return Effect.gen(function* () {
      for (const testCase of cases) {
        const requests: Array<string> = [];
        const cookieReads: Array<string> = [];
        const evaluatedSources: Array<string> = [];
        const browser = browserFromStub(
          stubTlsSession(
            requests,
            (url) => response(url, CHALLENGE_HTML),
            testCase.initialCookies,
            cookieReads,
          ),
          handler(selectChallengeAsset),
          evaluatedSources,
          testCase.writes,
        );
        const page = yield* browser.navigate(PAGE_URL);
        expect(cookieReads).toEqual(testCase.expectedReads);
        expect(requests).toEqual([PAGE_URL]);
        expect(evaluatedSources).toHaveLength(1);
        yield* page.close;
      }
    });
  });

  it.effect(
    "retries the same URL once after the stub jar receives a new token",
    () => {
      const requests: Array<string> = [];
      const cookieReads: Array<string> = [];
      const evaluatedSources: Array<string> = [];
      const browser = browserFromStub(
        stubTlsSession(
          requests,
          (url) => response(url, CHALLENGE_HTML),
          Cookies.fromSetCookie("aws-waf-token=before; Path=/"),
          cookieReads,
        ),
        handler(selectChallengeAsset),
        evaluatedSources,
        ["aws-waf-token=after; Path=/"],
      );

      return Effect.gen(function* () {
        const page = yield* browser.navigate(PAGE_URL);
        expect(cookieReads).toEqual(["before", "after"]);
        expect(requests).toEqual([PAGE_URL, PAGE_URL]);
        expect(evaluatedSources).toHaveLength(1);
        yield* page.close;
      });
    },
  );

  it.effect(
    "bounds HTML discovery and ignores comments and raw-text fake scripts",
    () => {
      const requests: Array<string> = [];
      const evaluatedSources: Array<string> = [];
      const seenPages: Array<AwsWafPage> = [];
      const unsupportedHtml = [
        '<script type="module">export {};</script>',
        `<script async src="${ASSET_ORIGIN}/async.js"></script>`,
        `<script defer src="${ASSET_ORIGIN}/defer.js"></script>`,
        '<script type="application/json">{}</script>',
        `<script src="${ASSET_ORIGIN}/mixed.js">inline</script>`,
      ].join("");
      const tooManyScripts = Array.from(
        { length: 17 },
        (_, index) =>
          `<script src="${ASSET_ORIGIN}/${index === 16 ? "challenge.js" : `asset-${index}.js`}"></script>`,
      ).join("");
      const bodies = [
        `<!-- ${CHALLENGE_HTML} --><textarea>${CHALLENGE_HTML}</textarea>${CHALLENGE_HTML}`,
        unsupportedHtml,
        tooManyScripts,
      ];
      const browser = browserFromStub(
        stubTlsSession(requests, (url, index) =>
          response(url, bodies[index] ?? ""),
        ),
        handler((page) => {
          seenPages.push(page);
          return Effect.succeedNone;
        }),
        evaluatedSources,
      );

      return Effect.gen(function* () {
        for (let index = 0; index < bodies.length; index += 1) {
          const page = yield* browser.navigate(PAGE_URL);
          expect(page.status).toBe(202);
          yield* page.close;
        }

        expect(seenPages).toHaveLength(3);
        expect(seenPages[0]?.scripts).toEqual([external(CHALLENGE_ASSET)]);
        expect(seenPages[1]?.scripts).toEqual([
          unsupported("unsupported script type"),
          unsupported("async/defer scripts are unsupported"),
          unsupported("async/defer scripts are unsupported"),
          unsupported("unsupported script type"),
          unsupported("external script also has inline content"),
        ]);
        const boundedScripts = seenPages[2]?.scripts ?? [];
        expect(boundedScripts).toHaveLength(16);
        expect(boundedScripts.at(-1)).toEqual(
          unsupported("page exceeds the 16-script limit"),
        );
        expect(evaluatedSources).toEqual([]);
        expect(requests).toEqual([PAGE_URL, PAGE_URL, PAGE_URL]);
      });
    },
  );

  it.effect(
    "rejects base-relative and unquoted NBSP script URLs before evaluation",
    () => {
      const cases = [
        {
          html: `<base href="https://other.example.test/path/"><script src="challenge.js"></script>`,
        },
        {
          html: `<script src=${CHALLENGE_ASSET}\u00a0data-key=fixture></script>`,
        },
      ];

      return Effect.gen(function* () {
        for (const testCase of cases) {
          const requests: Array<string> = [];
          const evaluatedSources: Array<string> = [];
          const discoveredPages: Array<AwsWafPage> = [];
          const bootstrap: AwsWafChallengeOptions["bootstrap"] = (page) => {
            discoveredPages.push(page);
            const firstScript = page.scripts[0];
            return firstScript === undefined
              ? Effect.succeedNone
              : withScripts([firstScript]);
          };
          const browser = browserFromStub(
            stubTlsSession(requests, (url) => response(url, testCase.html)),
            handler(bootstrap),
            evaluatedSources,
          );

          const error = yield* Effect.flip(browser.navigate(PAGE_URL));
          expectConfigError(error);
          expect(discoveredPages).toHaveLength(1);
          expect(discoveredPages[0]?.scripts).toHaveLength(1);
          expect(discoveredPages[0]?.scripts[0]?._tag).toBe("Unsupported");
          expect(evaluatedSources).toEqual([]);
          expect(requests).toEqual([PAGE_URL]);
        }
      });
    },
  );
});
