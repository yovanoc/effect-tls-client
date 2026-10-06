import { Clock, Effect, Exit, Layer, Option, Schema } from "effect";
import { TlsClient } from "../packages/effect-tls-client/src/TlsClient.js";
import * as Browser from "../packages/effect-tls-client/src/browser/index.js";
import { CookiesJson } from "../packages/effect-tls-client/src/internal/Protocol.js";
import { restrictHost, type LiveRule } from "./live-policy.js";

const EVALUATION_TIMEOUT_MS = 25_000;
const Target = Schema.Literals(["datadome", "cloudflare"]);
type Target = typeof Target.Type;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Receipt = Schema.Struct({
  kind: Schema.Literal("LIVE_CHALLENGE"),
  target: Target,
  initialStatus: Schema.Number,
  initialRecognizedChallenge: Schema.Boolean,
  hookInvoked: Schema.Boolean,
  inlinePrograms: Count,
  evaluationTimings: Schema.Array(
    Schema.Struct({ ms: Count, reachedBound: Schema.Boolean }),
  ).check(Schema.isMaxLength(16)),
  staticScripts: Schema.Struct({
    sameOrigin: Count,
    provider: Count,
    other: Count,
    unparsable: Count,
  }),
  iframes: Count,
  evaluations: Schema.Struct({ success: Count, failure: Count }),
  network: Schema.Struct({ allowed: Count, denied: Count }),
  providerCookieBefore: Schema.Boolean,
  providerCookieAfter: Schema.Boolean,
  providerCookieChanged: Schema.Boolean,
  retried: Schema.Boolean,
  finalStatus: Schema.NullOr(Schema.Number),
  finalRedirected: Schema.Boolean,
  finalChallengeRecognized: Schema.Boolean,
  finalMarkersPresent: Schema.Boolean,
  proven: Schema.Boolean,
});
const UnknownReceipt = Schema.Struct({
  kind: Schema.Literal("LIVE_CHALLENGE"),
  target: Target,
  result: Schema.Literal("UNKNOWN"),
});
const OffReceipt = Schema.Struct({ kind: Schema.Literal("LIVE_OFF") });
const Output = Schema.fromJsonString(
  Schema.Union([Receipt, UnknownReceipt, OffReceipt]),
);
const print = (receipt: typeof Output.Type) => {
  const json = Schema.encodeSync(Output, { onExcessProperty: "error" })(
    receipt,
  );
  if (Buffer.byteLength(json) > 64 * 1024)
    throw new RangeError("receipt limit");
  process.stdout.write(`${json}\n`);
};

/** Conservative HTML token selection, not repair or JavaScript rewriting. */
const tokenizeHtml = (body: string) => {
  const programs: Array<string> = [];
  const scriptSources: Array<string> = [];
  let iframes = 0;
  let scanned = 0;
  const tokens =
    /<!--[\s\S]*?-->|<!(?!--)[^>]*>|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
  for (
    let token = tokens.exec(body);
    token !== null;
    token = tokens.exec(body)
  ) {
    if (body.slice(scanned, token.index).includes("<"))
      throw new Browser.BrowserScriptError({
        reason: "ambiguous inline selection markup",
      });
    scanned = tokens.lastIndex;
    const tag = /^<([A-Za-z][A-Za-z0-9:-]*)([\s\S]*?)>$/.exec(token[0]);
    if (tag === null) continue;
    const name = tag[1]?.toLowerCase();
    if (name === "template" || name === "plaintext")
      throw new Browser.BrowserScriptError({
        reason: "unsupported inline selection markup",
      });
    if (
      ![
        "script",
        "style",
        "noscript",
        "textarea",
        "title",
        "xmp",
        "iframe",
        "noembed",
        "noframes",
      ].includes(name ?? "")
    )
      continue;
    if (name === "iframe") iframes++;
    const closing = new RegExp(`</${name}[\\t\\n\\f\\r ]*>`, "ig");
    closing.lastIndex = tokens.lastIndex;
    const end = closing.exec(body);
    if (end === null)
      throw new Browser.BrowserScriptError({ reason: "unterminated raw text" });
    const source = body.slice(tokens.lastIndex, end.index);
    tokens.lastIndex = closing.lastIndex;
    scanned = tokens.lastIndex;
    if (name !== "script") continue;
    if (source.includes("<!--"))
      throw new Browser.BrowserScriptError({
        reason: "unsupported script escape syntax",
      });
    const attributes = new Map<string, string>();
    const attribute =
      /[\t\n\f\r ]+([^\t\n\f\r /=>]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >]+)))?/gy;
    const raw = tag[2] ?? "";
    while (attribute.lastIndex < raw.length) {
      const offset = attribute.lastIndex;
      const part = attribute.exec(raw);
      if (part === null) {
        if (/^[\t\n\f\r ]*$/.test(raw.slice(offset))) break;
        throw new Browser.BrowserScriptError({
          reason: "ambiguous script attributes",
        });
      }
      const key = part[1]?.toLowerCase();
      if (key === undefined || attributes.has(key))
        throw new Browser.BrowserScriptError({
          reason: "ambiguous script attributes",
        });
      attributes.set(key, part[2] ?? part[3] ?? part[4] ?? "");
    }
    if (attributes.has("src")) scriptSources.push(attributes.get("src") ?? "");
    const type = (attributes.get("type") ?? "").trim().toLowerCase();
    if (
      !attributes.has("src") &&
      /^(?:|(?:text|application)\/(?:java|ecma)script|application\/x-(?:java|ecma)script|text\/javascript1\.[0-5]|text\/(?:jscript|livescript|x-javascript|x-ecmascript))$/.test(
        type,
      )
    )
      programs.push(source);
  }
  if (body.slice(scanned).includes("<"))
    throw new Browser.BrowserScriptError({
      reason: "ambiguous inline selection markup",
    });
  return { programs, scriptSources, iframes };
};

const classifyStaticScripts = (
  sources: ReadonlyArray<string>,
  pageUrl: string,
) => {
  const counts = { sameOrigin: 0, provider: 0, other: 0, unparsable: 0 };
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return { ...counts, unparsable: sources.length };
  }
  for (const source of sources) {
    try {
      const url = new URL(source, page);
      const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
      if (
        hostname === "js.datadome.co" ||
        hostname === "api-js.datadome.co" ||
        hostname === "captcha-delivery.com" ||
        hostname.endsWith(".captcha-delivery.com") ||
        hostname === "challenges.cloudflare.com" ||
        (url.origin === page.origin &&
          url.pathname.startsWith("/cdn-cgi/challenge-platform/"))
      )
        counts.provider++;
      else if (url.origin === page.origin) counts.sameOrigin++;
      else counts.other++;
    } catch {
      counts.unparsable++;
    }
  }
  return counts;
};

export const inlineClassicPrograms = (body: string): ReadonlyArray<string> =>
  tokenizeHtml(body).programs;

export const staticHtmlObservations = (body: string, pageUrl: string) => {
  const { scriptSources, iframes } = tokenizeHtml(body);
  return {
    staticScripts: classifyStaticScripts(scriptSources, pageUrl),
    iframes,
  };
};

export const measure = Effect.fnUntraced(function* (target: Target) {
  const pageUrl =
    target === "datadome"
      ? "https://bounty-nodejs.datashield.co/"
      : "https://www.scrapingcourse.com/cloudflare-challenge";
  const origin =
    target === "datadome"
      ? "https://bounty-nodejs.datashield.co"
      : "https://www.scrapingcourse.com";
  const rules: ReadonlyArray<LiveRule> =
    target === "datadome"
      ? [
          { origin },
          { origin: "https://js.datadome.co" },
          { origin: "https://api-js.datadome.co" },
        ]
      : [{ origin, pathPrefix: "/cdn-cgi/challenge-platform/" }];
  const allowedOrigins = rules.map((rule) => rule.origin);
  const providerName = target === "datadome" ? "datadome" : "cf_clearance";
  const state = {
    initialStatus: 0,
    initialRecognizedChallenge: false,
    hookInvoked: false,
    inlinePrograms: 0,
    evaluationTimings: [] as Array<{ ms: number; reachedBound: boolean }>,
    staticScripts: { sameOrigin: 0, provider: 0, other: 0, unparsable: 0 },
    iframes: 0,
    evaluations: { success: 0, failure: 0 },
    network: { allowed: 0, denied: 0 },
    providerCookieBefore: false,
    providerCookieAfter: false,
    providerCookieChanged: false,
    retried: false,
  };
  const cookieSnapshot = Effect.fnUntraced(function* (
    transport: Browser.BrowserChallengeContext["transport"],
  ) {
    const cookies = yield* Schema.decodeUnknownEffect(CookiesJson)(
      yield* transport.exportCookies,
    ).pipe(
      Effect.mapError(
        () =>
          new Browser.BrowserScriptError({
            reason: "invalid exported cookies",
          }),
      ),
    );
    const host =
      target === "datadome"
        ? "bounty-nodejs.datashield.co"
        : "www.scrapingcourse.com";
    const values = cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, "").toLowerCase();
      return domain === ""
        ? cookie.origin === host
        : host === domain || host.endsWith(`.${domain}`);
    });
    // Name sets and provider values stay in memory, never in a receipt.
    const names = new Set(values.map((cookie) => cookie.name));
    const provider = new Map(
      values
        .filter((cookie) => cookie.name === providerName)
        .map((cookie) => [
          `${cookie.domain}\n${cookie.path}\n${cookie.origin ?? ""}`,
          cookie.value,
        ]),
    );
    return { names, provider };
  });
  const handler = Effect.fnUntraced(function* (
    _response:
      | Browser.BrowserChallenge
      | Browser.BrowserChallengeContext["response"],
    context: Browser.BrowserChallengeContext,
  ) {
    state.hookInvoked = true;
    state.initialStatus = context.response.status;
    state.initialRecognizedChallenge =
      Browser.recognizeChallenge(context.response) !== undefined;
    const before = yield* cookieSnapshot(context.transport);
    state.providerCookieBefore = before.names.has(providerName);
    const parsed = yield* Effect.try({
      try: () => tokenizeHtml(context.body),
      catch: () =>
        new Browser.BrowserScriptError({ reason: "inline selection failed" }),
    });
    state.inlinePrograms = parsed.programs.length;
    state.staticScripts = classifyStaticScripts(
      parsed.scriptSources,
      context.response.url,
    );
    state.iframes = parsed.iframes;
    for (const source of parsed.programs) {
      const started = yield* Clock.monotonicTimeNanos;
      const success = yield* context
        .evaluateClassic(source, { document: "response" })
        .pipe(
          Effect.as(true),
          Effect.catchTag("BrowserScriptError", () => Effect.succeed(false)),
        );
      const ended = yield* Clock.monotonicTimeNanos;
      if (state.evaluationTimings.length < 16) {
        const ms = Math.max(
          0,
          Math.round(Number(ended - started) / 100_000_000) * 100,
        );
        state.evaluationTimings.push({
          ms,
          reachedBound: ms >= EVALUATION_TIMEOUT_MS - 250,
        });
      }
      if (success) state.evaluations.success++;
      else state.evaluations.failure++;
    }
    const after = yield* cookieSnapshot(context.transport);
    state.providerCookieAfter = after.names.has(providerName);
    state.providerCookieChanged = [...after.provider].some(
      ([key, value]) => value !== "" && before.provider.get(key) !== value,
    );
    state.retried = state.providerCookieChanged;
    return state.retried ? Option.some({}) : Option.none();
  });
  const program = Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* Browser.BrowserMock;
      const wrap = (
        evaluate: Browser.BrowserScriptRuntime["evaluate"],
      ): Browser.BrowserScriptRuntime["evaluate"] =>
        Effect.fnUntraced(function* (source, context, host) {
          if (host === undefined || context === undefined)
            return yield* new Browser.BrowserScriptError({
              reason: "live host missing",
            });
          const restricted = restrictHost(rules, host, context.url);
          return yield* evaluate
            .call(runtime, source, context, restricted.host)
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  state.network.allowed += restricted.counters.allowed;
                  state.network.denied += restricted.counters.denied;
                }),
              ),
            );
        });
      const browser = yield* Browser.open(
        {
          transport: { profile: "chrome_152_PSK" },
          maxChallengeRetries: 1,
          challengeHandlerTimeoutMs: 30_000,
        },
        {
          scriptRuntime: {
            ...runtime,
            evaluate: wrap(runtime.evaluate),
            ...(runtime.evaluateClassic === undefined
              ? {}
              : { evaluateClassic: wrap(runtime.evaluateClassic) }),
          },
          challengeHandler: handler,
          responseHandler: handler,
        },
      );
      const page = yield* browser.navigate(pageUrl);
      if (!state.hookInvoked)
        return yield* new Browser.BrowserScriptError({
          reason: "initial response unobserved",
        });
      const finalRedirected = page.url !== pageUrl;
      const finalChallengeRecognized = page.challenge !== undefined;
      const finalMarkersPresent =
        target === "datadome"
          ? /captcha-delivery\.com|geo\.captcha-delivery/i.test(page.body)
          : page.headers.some(
              ([name]) => name.toLowerCase() === "cf-mitigated",
            ) || /challenge-platform|Just a moment/i.test(page.body);
      return Receipt.make({
        kind: "LIVE_CHALLENGE",
        target,
        ...state,
        finalStatus: page.status,
        finalRedirected,
        finalChallengeRecognized,
        finalMarkersPresent,
        proven:
          state.initialStatus < 200 || state.initialStatus >= 300
            ? state.providerCookieChanged &&
              state.retried &&
              page.status >= 200 &&
              page.status < 300 &&
              !finalRedirected &&
              !finalChallengeRecognized &&
              !finalMarkersPresent
            : false,
      });
    }),
  );
  const services =
    typeof Bun === "undefined"
      ? (yield* Effect.promise(() => import("@effect/platform-node")))
          .NodeServices.layer
      : (yield* Effect.promise(() => import("@effect/platform-bun")))
          .BunServices.layer;
  const layers = Layer.mergeAll(
    TlsClient.layer.pipe(Layer.provide(services)),
    Browser.BrowserMock.layer({
      allowedOrigins,
      maxNetworkRequests: 16,
      timeoutMs: EVALUATION_TIMEOUT_MS,
    }).pipe(Layer.provide(services)),
  );
  return yield* program.pipe(Effect.provide(layers));
});

if (import.meta.main) {
  const target = Schema.decodeUnknownOption(Target)(
    process.env.TLS_CLIENT_LIVE_TARGET,
  );
  if (process.env.TLS_CLIENT_INTEGRATION !== "1" || Option.isNone(target)) {
    print({ kind: "LIVE_OFF" });
  } else {
    const result = await Effect.runPromiseExit(measure(target.value));
    if (Exit.isSuccess(result)) print(result.value);
    else {
      print({
        kind: "LIVE_CHALLENGE",
        target: target.value,
        result: "UNKNOWN",
      });
      process.exitCode = 2;
    }
  }
}
