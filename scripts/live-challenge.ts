import { Cause, Clock, Effect, Exit, Layer, Option, Schema } from "effect";
import { TlsClient } from "../packages/effect-tls-client/src/TlsClient.js";
import * as Browser from "../packages/effect-tls-client/src/browser/index.js";
import { parseHtmlDocument } from "../packages/effect-tls-client/src/browser/HtmlSnapshot.js";
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
  "RESOURCE_FAILURE",
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
  ["script evaluation timed out; process terminated", "TIMEOUT"],
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
  ["document script resource load failed", "RESOURCE_FAILURE"],
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

export const BodyGate = Schema.Literals([
  "NO_BODY",
  "UNCHANGED",
  "CHALLENGE_MARKER",
  "NOSCRIPT_ONLY",
  "BLOCKED_CONTENT",
  "UNSUPPORTED_CONTENT_TYPE",
  "NO_SUPPORTED_VERIFIER",
  "VERIFIED",
]);

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
 * Host operations observed at the wrapped callback boundary. `request` includes
 * denials made by `restrictHost`; `scriptLoad` is its `kind: "script"` subset.
 * Earlier BrowserMock policy denials and library-internal redirect hops do not
 * reach this wrapper. `setCookie` counts callback Effect execution, and
 * `exportCookies` counts evaluation of the transport's Effect-valued property.
 * Counts saturate at 256; none indicates delivery, Jar acceptance, script
 * execution, or operation success.
 */
export const Receipt = Schema.Struct({
  kind: Schema.Literal("LIVE_CHALLENGE"),
  target: Target,
  initialStatus: Schema.Number,
  initialChallengeUrlMatches: Schema.Boolean,
  initialRecognizedChallenge: Schema.Boolean,
  initialMarkersPresent: Schema.Boolean,
  hookInvocations: HostCallCount,
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
  evaluations: Schema.Struct({
    attempts: HostCallCount,
    success: HostCallCount,
    failure: HostCallCount,
  }),
  failureClass: FailureClass,
  failureReason: FailureReason,
  network: Schema.Struct({ allowed: Count, denied: Count }),
  hostCalls: HostCallCountersSchema,
  providerCookieBefore: Schema.Boolean,
  providerCookieAfter: Schema.Boolean,
  providerCookieChanged: Schema.Boolean,
  retried: Schema.Boolean,
  finalStatus: Schema.NullOr(Schema.Number),
  redirectCount: Schema.NullOr(Count),
  finalRedirected: Schema.Boolean,
  finalChallengeRecognized: Schema.Boolean,
  finalMarkersPresent: Schema.Boolean,
  bodyGate: BodyGate,
  protectedContentVerified: Schema.Boolean,
  proven: Schema.Boolean,
});
export const incrementCount = (count: number) =>
  Math.min(count + 1, MAX_HOST_CALL_COUNT);
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

const hasKnownChallengeMarkers = (
  target: Target,
  headers: ReadonlyArray<readonly [string, string]>,
  body: string,
) =>
  target === "datadome"
    ? /captcha-delivery\.com|geo\.captcha-delivery/i.test(body)
    : headers.some(([name]) => name.toLowerCase() === "cf-mitigated") ||
      /challenge-platform|Just a moment/i.test(body);

const normalizeBodyText = (text: string) => text.replace(/\s+/gu, " ").trim();

/**
 * Extracts only text from supported leaf elements in a strict complete document.
 * This bounded AST check is not a CSS/layout or rendered-visibility model.
 */
const visibleBodyText = (body: string) => {
  const parsed = parseHtmlDocument(body);
  if (parsed._tag !== "Success") return undefined;

  const { nodes } = parsed.snapshot;
  const bodyIndex = nodes.findIndex((node) => node.tag === "body");
  if (bodyIndex < 0) return undefined;
  if (
    nodes.some(
      (node) =>
        node.tag === "style" ||
        node.tag === "link" ||
        node.attributes.some(
          ([name, value]) =>
            name === "hidden" ||
            name === "inert" ||
            name === "style" ||
            (name === "aria-hidden" && value.trim().toLowerCase() === "true"),
        ),
    )
  )
    return undefined;

  const isInBody = (index: number) => {
    let parent = nodes[index]?.parent ?? -1;
    while (parent >= 0) {
      if (parent === bodyIndex) return true;
      parent = nodes[parent]?.parent ?? -1;
    }
    return false;
  };
  const bodyNode = nodes[bodyIndex];
  if (bodyNode === undefined) return undefined;
  const text: Array<string> = [];
  const noscriptText: Array<string> = [];
  for (let index = bodyIndex; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined || (index !== bodyIndex && !isInBody(index)))
      continue;
    if (node.tag === "noscript") {
      noscriptText.push(node.textContent);
      continue;
    }
    if (node.tag === "script") continue;
    const hasElementChildren = nodes.some((child) => child.parent === index);
    if (hasElementChildren) continue;
    text.push(node.textContent);
  }

  const supportedText = normalizeBodyText(text.join(" "));
  const rawBodyText = normalizeBodyText(bodyNode.textContent);
  return {
    text: supportedText,
    noscriptOnly:
      supportedText === "" &&
      rawBodyText !== "" &&
      normalizeBodyText(noscriptText.join(" ")) === rawBodyText,
  };
};

export const inspectProtectedBody = (input: {
  readonly target: Target;
  readonly initialBody: string;
  readonly finalBody: string;
  readonly finalStatus: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly finalChallengeRecognized: boolean;
  readonly expectedContent?: string;
}): {
  readonly bodyGate: typeof BodyGate.Type;
  readonly protectedContentVerified: boolean;
} => {
  const fail = (bodyGate: Exclude<typeof BodyGate.Type, "VERIFIED">) => ({
    bodyGate,
    protectedContentVerified: false,
  });
  if (input.finalStatus === 204 || input.finalBody.trim() === "")
    return fail("NO_BODY");
  if (input.finalBody === input.initialBody) return fail("UNCHANGED");
  const contentTypes = input.headers.flatMap(([name, value]) =>
    name.toLowerCase() === "content-type"
      ? [value.split(";", 1)[0]?.trim().toLowerCase() ?? ""]
      : [],
  );
  if (contentTypes.length !== 1 || contentTypes[0] !== "text/html")
    return fail("UNSUPPORTED_CONTENT_TYPE");
  if (
    input.finalChallengeRecognized ||
    hasKnownChallengeMarkers(input.target, input.headers, input.finalBody)
  )
    return fail("CHALLENGE_MARKER");

  const initial = visibleBodyText(input.initialBody);
  const final = visibleBodyText(input.finalBody);
  if (initial === undefined || final === undefined)
    return fail("NO_SUPPORTED_VERIFIER");
  if (final.text === "" && final.noscriptOnly) return fail("NOSCRIPT_ONLY");
  if (final.text === "") return fail("NO_BODY");
  if (
    /\b(?:challenge|error|interstitial|access denied|forbidden)\b/iu.test(
      final.text,
    )
  )
    return fail("BLOCKED_CONTENT");

  // Live targets deliberately have no expected protected-content marker yet.
  const expected = normalizeBodyText(input.expectedContent ?? "");
  if (
    expected === "" ||
    initial.text.includes(expected) ||
    !final.text.includes(expected)
  )
    return fail("NO_SUPPORTED_VERIFIER");
  return {
    bodyGate: BodyGate.make("VERIFIED"),
    protectedContentVerified: true,
  };
};

export const didProviderCookieChange = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
) =>
  [...after].some(([key, value]) => value !== "" && before.get(key) !== value);

export const isProven = (input: {
  readonly initialEnforcementObserved: boolean;
  readonly initialChallengeUrlMatches: boolean;
  readonly initialStatus: number;
  readonly hookInvocations: number;
  readonly evaluations: {
    readonly attempts: number;
    readonly success: number;
    readonly failure: number;
  };
  readonly failureClass: typeof FailureClass.Type;
  readonly failureReason: typeof FailureReason.Type;
  readonly networkDenied: number;
  readonly staticScriptsNotAllowed: number;
  readonly providerCookieChanged: boolean;
  readonly retried: boolean;
  readonly finalUrlMatches: boolean;
  readonly redirectCount: number | null;
  readonly finalStatus: number | null;
  readonly bodyGate: typeof BodyGate.Type;
  readonly protectedContentVerified: boolean;
  readonly finalChallengeRecognized: boolean;
  readonly finalMarkersPresent: boolean;
}) =>
  input.initialEnforcementObserved &&
  input.initialChallengeUrlMatches &&
  (input.initialStatus < 200 || input.initialStatus >= 300) &&
  input.hookInvocations === 1 &&
  input.evaluations.attempts === 1 &&
  input.evaluations.success === 1 &&
  input.evaluations.failure === 0 &&
  input.redirectCount === 0 &&
  input.failureClass === "NONE" &&
  input.failureReason === "NONE" &&
  input.networkDenied === 0 &&
  input.staticScriptsNotAllowed === 0 &&
  input.providerCookieChanged &&
  input.retried &&
  input.finalUrlMatches &&
  input.finalStatus !== null &&
  input.finalStatus >= 200 &&
  input.finalStatus < 300 &&
  input.finalStatus !== 204 &&
  input.bodyGate === "VERIFIED" &&
  input.protectedContentVerified &&
  !input.finalChallengeRecognized &&
  !input.finalMarkersPresent;

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
          {
            origin: "https://ct.captcha-delivery.com",
            allowedRequestKinds: ["script"],
          },
        ]
      : [{ origin, pathPrefix: "/cdn-cgi/challenge-platform/" }];
  const allowedOrigins = rules.map((rule) => rule.origin);
  const providerName = target === "datadome" ? "datadome" : "cf_clearance";
  let initialBody = "";
  const allowedPathPrefixes = Object.fromEntries(
    rules.flatMap((rule) =>
      rule.pathPrefix === undefined ? [] : [[rule.origin, [rule.pathPrefix]]],
    ),
  );
  const allowedRequestKinds = Object.fromEntries(
    rules.flatMap((rule) =>
      rule.allowedRequestKinds === undefined
        ? []
        : [[rule.origin, rule.allowedRequestKinds]],
    ),
  );
  const state = {
    initialStatus: 0,
    initialChallengeUrlMatches: false,
    initialRecognizedChallenge: false,
    initialMarkersPresent: false,
    hookInvocations: 0,
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
    evaluations: { attempts: 0, success: 0, failure: 0 },
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
    const firstHook = state.hookInvocations === 0;
    state.hookInvocations = incrementCount(state.hookInvocations);
    if (firstHook) {
      state.initialStatus = context.response.status;
      state.initialChallengeUrlMatches = context.response.url === pageUrl;
      state.initialRecognizedChallenge =
        Browser.recognizeChallenge(context.response) !== undefined;
      initialBody = context.body;
      state.initialMarkersPresent = hasKnownChallengeMarkers(
        target,
        context.response.headers,
        context.body,
      );
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
    }
    const before = yield* cookieSnapshot(context.transport);
    if (firstHook) state.providerCookieBefore = before.names.has(providerName);
    state.evaluations.attempts = incrementCount(state.evaluations.attempts);
    const started = yield* Clock.monotonicTimeNanos;
    const evaluation = yield* classifyEvaluation(context.evaluateDocument());
    state.failureClass = evaluation.failureClass;
    state.failureReason = evaluation.failureReason;
    if (evaluation.failureClass === "NONE")
      state.evaluations.success = incrementCount(state.evaluations.success);
    else state.evaluations.failure = incrementCount(state.evaluations.failure);
    const ended = yield* Clock.monotonicTimeNanos;
    const ms = Math.max(
      0,
      Math.round(Number(ended - started) / 100_000_000) * 100,
    );
    if (state.evaluationTimings.length < 16)
      state.evaluationTimings.push({
        ms,
        reachedBound: ms >= EVALUATION_TIMEOUT_MS - 250,
      });
    const after = yield* cookieSnapshot(context.transport);
    const changed = didProviderCookieChange(before.provider, after.provider);
    if (firstHook) {
      state.providerCookieAfter = after.names.has(providerName);
      state.providerCookieChanged = changed;
    }
    if (changed) state.retried = true;
    return changed ? Option.some({}) : Option.none();
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
      if (state.hookInvocations === 0)
        return yield* new Browser.BrowserScriptError({
          reason: "initial response unobserved",
        });
      const finalUrlMatches = page.url === pageUrl;
      const redirectCount =
        Number.isSafeInteger(page.redirectCount) && page.redirectCount >= 0
          ? page.redirectCount
          : null;
      const finalRedirected =
        (redirectCount !== null && redirectCount > 0) || !finalUrlMatches;
      const finalChallengeRecognized = page.challenge !== undefined;
      const finalMarkersPresent = hasKnownChallengeMarkers(
        target,
        page.headers,
        page.body,
      );
      const bodyEvidence = inspectProtectedBody({
        target,
        initialBody,
        finalBody: page.body,
        finalStatus: page.status,
        headers: page.headers,
        finalChallengeRecognized,
      });
      return Receipt.make({
        kind: "LIVE_CHALLENGE",
        target,
        ...state,
        finalStatus: page.status,
        redirectCount,
        finalRedirected,
        finalChallengeRecognized,
        finalMarkersPresent,
        ...bodyEvidence,
        proven: isProven({
          initialEnforcementObserved:
            state.initialRecognizedChallenge || state.initialMarkersPresent,
          initialChallengeUrlMatches: state.initialChallengeUrlMatches,
          initialStatus: state.initialStatus,
          hookInvocations: state.hookInvocations,
          evaluations: state.evaluations,
          failureClass: state.failureClass,
          failureReason: state.failureReason,
          networkDenied: state.network.denied,
          staticScriptsNotAllowed: state.staticScriptsNotAllowed,
          providerCookieChanged: state.providerCookieChanged,
          retried: state.retried,
          finalUrlMatches,
          redirectCount,
          finalStatus: page.status,
          ...bodyEvidence,
          finalChallengeRecognized,
          finalMarkersPresent,
        }),
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
      allowedPathPrefixes,
      ...(Object.keys(allowedRequestKinds).length === 0
        ? {}
        : { allowedRequestKinds }),
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
