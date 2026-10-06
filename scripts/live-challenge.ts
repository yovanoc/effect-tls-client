import { Cause, Clock, Effect, Exit, Layer, Option, Schema } from "effect";
import { TlsClient } from "../packages/effect-tls-client/src/TlsClient.js";
import * as Browser from "../packages/effect-tls-client/src/browser/index.js";
import { CookiesJson } from "../packages/effect-tls-client/src/internal/Protocol.js";
import {
  countHostCall,
  makeHostCallCounters,
  MAX_HOST_CALL_COUNT,
  restrictHost,
  type LiveHostCallCounters,
  type LiveRule,
} from "./live-policy.js";

const EVALUATION_TIMEOUT_MS = 25_000;
const Target = Schema.Literals(["datadome", "cloudflare"]);
type Target = typeof Target.Type;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const HostCallCount = Count.check(
  Schema.isLessThanOrEqualTo(MAX_HOST_CALL_COUNT),
);
export const HostCallCountersSchema = Schema.Struct({
  request: HostCallCount,
  scriptLoad: HostCallCount,
  setCookie: HostCallCount,
  exportCookies: HostCallCount,
});
const FailureClass = Schema.Literals(["NONE", "TIMEOUT", "SCRIPT", "OTHER"]);

export const FailureReason = Schema.Literals([
  "NONE",
  "OTHER",
  "TIMEOUT",
  "PROCESS_TIMEOUT",
  "INTERRUPTED",
  "UNSUPPORTED_DOCUMENT",
  "UNSUPPORTED_FRAGMENT",
  "MISSING_DOCUMENT",
  "INVALID_CONTEXT",
  "INVALID_SNAPSHOT",
  "DOCUMENT_INPUT_BYTES",
  "DOCUMENT_ELEMENTS",
  "DOCUMENT_ATTRIBUTES",
  "DOCUMENT_ATTRIBUTE_VALUE",
  "START_INPUT_LIMIT",
  "SOURCE_LIMIT",
  "RUNTIME_UNSUPPORTED",
  "LIVE_POLICY_DENIED",
  "ORIGIN_DENIED",
  "INVALID_ORIGIN_POLICY",
  "HOST_UNAVAILABLE",
  "NETWORK_FAILED",
  "NETWORK_BYTE_LIMIT",
  "SPAWN_FAILED",
  "START_FAILED",
  "INPUT_ENCODING_FAILED",
  "OUTPUT_INVALID",
  "OUTPUT_LINE_LIMIT",
  "OUTPUT_LIMIT",
  "PROCESS_NO_RESULT",
  "RESULT_INVALID",
  "DOCUMENT_BUDGET",
  "NODE_UNSUPPORTED",
]);

// Exact code-owned strings only. Never match substrings, serialize causes, or
// return guest-provided error text (including strings similar to these constants).
const failureReasons = new Map<string, typeof FailureReason.Type>([
  ["script evaluation timed out", "TIMEOUT"],
  [
    "script evaluation timed out and the process was terminated",
    "PROCESS_TIMEOUT",
  ],
  ["unsupported HTML document", "UNSUPPORTED_DOCUMENT"],
  ["unsupported HTML body-fragment snapshot", "UNSUPPORTED_FRAGMENT"],
  ["document evaluation requires a complete document", "MISSING_DOCUMENT"],
  ["invalid browser script context", "INVALID_CONTEXT"],
  ["invalid document snapshot", "INVALID_SNAPSHOT"],
  ["HTML document exceeds inputBytes limit", "DOCUMENT_INPUT_BYTES"],
  ["HTML document exceeds elements limit", "DOCUMENT_ELEMENTS"],
  ["HTML document exceeds attributesUtf8Bytes limit", "DOCUMENT_ATTRIBUTES"],
  [
    "HTML document exceeds attributeValueCharacters limit",
    "DOCUMENT_ATTRIBUTE_VALUE",
  ],
  ["script IPC start input exceeds its 128 KiB limit", "START_INPUT_LIMIT"],
  ["script source exceeds the 64 KiB limit", "SOURCE_LIMIT"],
  [
    "Runtime does not support document script evaluation",
    "RUNTIME_UNSUPPORTED",
  ],
  ["live network policy denied", "LIVE_POLICY_DENIED"],
  ["script origin is not allowed", "ORIGIN_DENIED"],
  ["invalid script network origin policy", "INVALID_ORIGIN_POLICY"],
  ["script network host is unavailable", "HOST_UNAVAILABLE"],
  ["script network request failed", "NETWORK_FAILED"],
  ["script network byte budget exceeded", "NETWORK_BYTE_LIMIT"],
  ["failed to spawn browser script process", "SPAWN_FAILED"],
  ["failed to start browser script process", "START_FAILED"],
  ["failed to encode browser script input", "INPUT_ENCODING_FAILED"],
  ["script process emitted an invalid IPC message", "OUTPUT_INVALID"],
  ["script process emitted an oversized IPC line", "OUTPUT_LINE_LIMIT"],
  ["script process output exceeds the 1 MiB limit", "OUTPUT_LIMIT"],
  ["browser script process exited without a result", "PROCESS_NO_RESULT"],
  ["browser script result failed validation", "RESULT_INVALID"],
  ["script runtime returned an invalid result", "RESULT_INVALID"],
  ["document snapshot budget exceeded", "DOCUMENT_BUDGET"],
  [
    "BrowserMock requires Node 25+ network permission denial support",
    "NODE_UNSUPPORTED",
  ],
]);
const EvaluationReceipt = Schema.Struct({
  failureClass: FailureClass,
  failureReason: FailureReason,
});

/** Only exact authored reasons enter metadata; every other payload stays private. */
export const classifyEvaluation = Effect.fnUntraced(function* (
  evaluation: Effect.Effect<
    void,
    Browser.BrowserOperationError | Cause.TimeoutError
  >,
) {
  const exit = yield* evaluation.pipe(
    Effect.as(
      EvaluationReceipt.make({ failureClass: "NONE", failureReason: "NONE" }),
    ),
    Effect.catchTag("BrowserScriptError", (error) =>
      Effect.succeed(
        EvaluationReceipt.make({
          failureClass: "SCRIPT",
          failureReason: failureReasons.get(error.reason) ?? "OTHER",
        }),
      ),
    ),
    Effect.catchTag("TimeoutError", () =>
      Effect.succeed(
        EvaluationReceipt.make({
          failureClass: "TIMEOUT",
          failureReason: "TIMEOUT",
        }),
      ),
    ),
    Effect.exit,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  return EvaluationReceipt.make(
    Cause.hasInterrupts(exit.cause)
      ? { failureClass: "TIMEOUT", failureReason: "INTERRUPTED" }
      : { failureClass: "OTHER", failureReason: "OTHER" },
  );
});
/**
 * Effect execution attempts observed by the harness. `request` includes policy
 * denials; `scriptLoad` is its `kind: "script"` subset. `setCookie` counts the
 * callback's Effect execution, and `exportCookies` counts evaluation of the
 * transport's Effect-valued property. Counts saturate at 256. None indicates
 * delivery, Jar acceptance, script execution, or operation success; internal
 * redirects and library-internal cookie reads are outside this wrapper.
 */
export const Receipt = Schema.Struct({
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
    datadomeTag: Count,
    datadomeApi: Count,
    captchaDelivery: Count,
    cloudflare: Count,
    other: Count,
    unparsable: Count,
  }),
  staticScriptsNotAllowed: Count,
  iframes: Count,
  evaluations: Schema.Struct({ success: Count, failure: Count }),
  failureClass: FailureClass,
  failureReason: FailureReason,
  network: Schema.Struct({ allowed: Count, denied: Count }),
  hostCalls: HostCallCountersSchema,
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
export const encodeReceipt = (receipt: typeof Output.Type) => {
  const json = Schema.encodeSync(Output, { onExcessProperty: "error" })(
    receipt,
  );
  if (Buffer.byteLength(json) > 64 * 1024)
    throw new RangeError("receipt limit");
  return json;
};
const print = (receipt: typeof Output.Type) =>
  process.stdout.write(`${encodeReceipt(receipt)}\n`);

/** `exportCookies` is an Effect property, so count and return it lazily. */
export const readExportedCookies = (
  transport: Pick<
    Browser.BrowserChallengeContext["transport"],
    "exportCookies"
  >,
  hostCalls: LiveHostCallCounters,
) =>
  Effect.suspend(() => {
    countHostCall(hostCalls, "exportCookies");
    return transport.exportCookies;
  });

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
  allowedOrigins: ReadonlyArray<string>,
) => {
  const counts = {
    sameOrigin: 0,
    datadomeTag: 0,
    datadomeApi: 0,
    captchaDelivery: 0,
    cloudflare: 0,
    other: 0,
    unparsable: 0,
  };
  let staticScriptsNotAllowed = 0;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return {
      staticScripts: { ...counts, unparsable: sources.length },
      staticScriptsNotAllowed,
    };
  }
  const allowed = new Set(allowedOrigins);
  for (const source of sources) {
    try {
      const url = new URL(source, page);
      if (!allowed.has(url.origin)) staticScriptsNotAllowed++;
      const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
      if (hostname === "js.datadome.co") counts.datadomeTag++;
      else if (hostname === "api-js.datadome.co") counts.datadomeApi++;
      else if (
        hostname === "captcha-delivery.com" ||
        hostname.endsWith(".captcha-delivery.com")
      )
        counts.captchaDelivery++;
      else if (
        hostname === "challenges.cloudflare.com" ||
        (url.origin === page.origin &&
          url.pathname.startsWith("/cdn-cgi/challenge-platform/"))
      )
        counts.cloudflare++;
      else if (url.origin === page.origin) counts.sameOrigin++;
      else counts.other++;
    } catch {
      counts.unparsable++;
    }
  }
  return { staticScripts: counts, staticScriptsNotAllowed };
};

export const inlineClassicPrograms = (body: string): ReadonlyArray<string> =>
  tokenizeHtml(body).programs;

export const staticHtmlObservations = (
  body: string,
  pageUrl: string,
  allowedOrigins: ReadonlyArray<string>,
) => {
  const { scriptSources, iframes } = tokenizeHtml(body);
  return {
    ...classifyStaticScripts(scriptSources, pageUrl, allowedOrigins),
    iframes,
  };
};

/** Shared by the live measurement and local document-path regression fixtures. */
export const restrictRuntime = (
  runtime: Browser.BrowserScriptRuntime,
  rules: ReadonlyArray<LiveRule>,
  network: { allowed: number; denied: number },
  hostCalls = makeHostCallCounters(),
): Browser.BrowserScriptRuntime => {
  const wrap = (
    evaluate: Browser.BrowserScriptRuntime["evaluate"],
  ): Browser.BrowserScriptRuntime["evaluate"] =>
    Effect.fnUntraced(function* (source, context, host) {
      if (host === undefined || context === undefined)
        return yield* new Browser.BrowserScriptError({
          reason: "live host missing",
        });
      const restricted = restrictHost(rules, host, context.url, hostCalls);
      return yield* evaluate
        .call(runtime, source, context, restricted.host)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              network.allowed += restricted.counters.allowed;
              network.denied += restricted.counters.denied;
            }),
          ),
        );
    });
  const evaluateDocument = runtime.evaluateDocument;
  return {
    ...runtime,
    evaluate: wrap(runtime.evaluate),
    ...(runtime.evaluateClassic === undefined
      ? {}
      : { evaluateClassic: wrap(runtime.evaluateClassic) }),
    ...(evaluateDocument === undefined
      ? {}
      : {
          evaluateDocument: (context, host) =>
            wrap((_source, _context, restrictedHost) =>
              evaluateDocument.call(runtime, context, restrictedHost),
            )("", context, host),
        }),
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
    staticScripts: {
      sameOrigin: 0,
      datadomeTag: 0,
      datadomeApi: 0,
      captchaDelivery: 0,
      cloudflare: 0,
      other: 0,
      unparsable: 0,
    },
    staticScriptsNotAllowed: 0,
    iframes: 0,
    evaluations: { success: 0, failure: 0 },
    failureClass: FailureClass.make("NONE"),
    failureReason: FailureReason.make("NONE"),
    network: { allowed: 0, denied: 0 },
    hostCalls: makeHostCallCounters(),
    providerCookieBefore: false,
    providerCookieAfter: false,
    providerCookieChanged: false,
    retried: false,
  };
  const cookieSnapshot = Effect.fnUntraced(function* (
    transport: Browser.BrowserChallengeContext["transport"],
  ) {
    const cookies = yield* Schema.decodeUnknownEffect(CookiesJson)(
      yield* readExportedCookies(transport, state.hostCalls),
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
    const staticScripts = classifyStaticScripts(
      parsed.scriptSources,
      context.response.url,
      allowedOrigins,
    );
    state.staticScripts = staticScripts.staticScripts;
    state.staticScriptsNotAllowed = staticScripts.staticScriptsNotAllowed;
    state.iframes = parsed.iframes;
    const started = yield* Clock.monotonicTimeNanos;
    const evaluation = yield* classifyEvaluation(context.evaluateDocument());
    state.failureClass = evaluation.failureClass;
    state.failureReason = evaluation.failureReason;
    const ended = yield* Clock.monotonicTimeNanos;
    const ms = Math.max(
      0,
      Math.round(Number(ended - started) / 100_000_000) * 100,
    );
    state.evaluationTimings.push({
      ms,
      reachedBound: ms >= EVALUATION_TIMEOUT_MS - 250,
    });
    if (state.failureClass === "NONE") state.evaluations.success = 1;
    else state.evaluations.failure = 1;
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
      const browser = yield* Browser.open(
        {
          transport: { profile: "chrome_152_PSK" },
          maxChallengeRetries: 1,
          challengeHandlerTimeoutMs: 30_000,
        },
        {
          scriptRuntime: restrictRuntime(
            runtime,
            rules,
            state.network,
            state.hostCalls,
          ),
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
