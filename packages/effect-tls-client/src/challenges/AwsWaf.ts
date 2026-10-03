import { Effect, Option, Predicate, Schema } from "effect";
import {
  BrowserSessionError,
  type BrowserChallengeHandler,
  type BrowserOperationError,
} from "../browser/Browser.js";
import { reviewedChallengeHandler } from "../browser/ReviewedChallenge.js";
import {
  normalizeAllowedOrigins,
  resolveAllowedUrl,
} from "../browser/ScriptPolicy.js";
import { discoverAwsWafScripts } from "./internal/AwsWafPage.js";

/** @experimental Explicitly reviewed classic scripts; unsupported discovery is never executable. */
export const AwsWafPageScript = Schema.TaggedUnion({
  External: { url: Schema.NonEmptyString },
  Inline: { source: Schema.String },
  Unsupported: { reason: Schema.NonEmptyString },
});
export type AwsWafPageScript = typeof AwsWafPageScript.Type;

/** @experimental Bounded discovery in document order, not a DOM or JavaScript parser. */
export const AwsWafPage = Schema.Struct({
  url: Schema.String,
  status: Schema.Int,
  scripts: Schema.Array(AwsWafPageScript).check(Schema.isMaxLength(16)),
});
export interface AwsWafPage extends Schema.Schema.Type<typeof AwsWafPage> {}

/** @experimental The callback alone authorizes these scripts; page acquisition is the default. */
export const AwsWafBootstrap = Schema.Struct({
  scripts: Schema.Array(AwsWafPageScript).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  acquisition: Schema.optionalKey(Schema.Literals(["page", "getToken"])),
});
export interface AwsWafBootstrap extends Schema.Schema.Type<
  typeof AwsWafBootstrap
> {}

/** @experimental Origins also require independent authorization in BrowserMock.allowedOrigins. */
export interface AwsWafChallengeOptions {
  readonly scriptOrigins: readonly [string, ...Array<string>];
  readonly bootstrap: (
    page: AwsWafPage,
  ) => Effect.Effect<Option.Option<AwsWafBootstrap>, BrowserOperationError>;
}

const Options = Schema.Struct({
  scriptOrigins: Schema.NonEmptyArray(Schema.NonEmptyString),
  // The callable signature is application-trusted; only callability is runtime-checkable.
  bootstrap: Schema.declare<AwsWafChallengeOptions["bootstrap"]>(
    (input): input is AwsWafChallengeOptions["bootstrap"] =>
      Predicate.isFunction(input),
  ),
});

const configError = (message: string, cause?: unknown) =>
  BrowserSessionError.make({
    operation: "AWS WAF challenge bootstrap",
    kind: "Config",
    message,
    cause,
  });

/** Observe existing page calls, preserving receiver, arguments and the original return value. */
const OBSERVER = `
const awsPending = [];
const awsFailures = [];
const awsWrapped = new WeakSet();
let awsCallDepth = 0;
function observeAwsAcquisition() {
  const sdk = window.AwsWafIntegration;
  if (!sdk) return;
  for (const name of ["getToken", "forceRefreshToken"]) {
    const original = sdk[name];
    if (typeof original !== "function" || awsWrapped.has(original)) continue;
    const wrapped = function (...args) {
      const root = awsCallDepth === 0;
      awsCallDepth++;
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { if (root) awsFailures.push(error); throw error; }
      finally { awsCallDepth--; }
      if (root) {
        awsPending.push(Promise.resolve(result).then(
          () => undefined,
          error => { awsFailures.push(error); }
        ));
      }
      return result;
    };
    if (!Reflect.set(sdk, name, wrapped) || sdk[name] !== wrapped)
      throw new TypeError("AWS WAF acquisition method cannot be observed: " + name);
    awsWrapped.add(wrapped);
  }
}
`;

const buildSource = (
  scripts: ReadonlyArray<AwsWafPageScript>,
  acquisition: "page" | "getToken",
): string => {
  const observe = acquisition === "page" ? "observeAwsAcquisition();" : "";
  const statements = scripts.map((script) =>
    AwsWafPageScript.match(script, {
      External: ({ url }) =>
        `${observe}\nawait document.loadScript(${JSON.stringify(url)});\n${observe}`,
      // Explicit window assignments survive; document-scoped declarations do not.
      Inline: ({ source }) =>
        `${observe}\nawait (async function () {\n${source}\n}).call(window);\n${observe}`,
      // Rejected before source construction.
      Unsupported: () => "",
    }),
  );
  return `${acquisition === "page" ? OBSERVER : ""}\n${statements.join("\n")}\n${
    acquisition === "getToken"
      ? `const sdk = window.AwsWafIntegration;
if (!sdk || typeof sdk.getToken !== "function") throw new TypeError("AWS WAF getToken is unavailable");
const token = await sdk.getToken();
if (typeof token !== "string" || token.length === 0) throw new TypeError("AWS WAF getToken returned an empty or invalid token");`
      : `for (let index = 0; index < awsPending.length; index++) await awsPending[index];
observeAwsAcquisition();
if (awsFailures.length) throw awsFailures[0];
if (awsPending.length === 0) throw new TypeError("AWS WAF page did not initiate an observed acquisition");`
  }
return "";`;
};

/**
 * @experimental Opt-in AWS bootstrap, not a general solver or proof of clearance.
 * Public SDK contract: getToken() returns Promise<string> and stores the token cookie.
 * https://docs.aws.amazon.com/waf/latest/developerguide/waf-js-challenge-api-specification.html
 * https://docs.aws.amazon.com/waf/latest/developerguide/waf-js-challenge-api-get-token.html
 * https://docs.aws.amazon.com/waf/latest/developerguide/waf-tokens.html
 * forceRefreshToken is observed only if supplied by a reviewed page; it is not a public mode.
 */
export const awsWafChallengeHandler = (
  options: AwsWafChallengeOptions,
): BrowserChallengeHandler =>
  Effect.fn("AwsWaf.challengeHandler")(function* (challenge, context) {
    if (challenge.kind !== "AwsWaf") return Option.none();
    const config = yield* Schema.decodeEffect(Options)(options).pipe(
      Effect.mapError((cause) =>
        configError("invalid AWS WAF challenge options", cause),
      ),
    );
    const origins = yield* Effect.try({
      try: () => normalizeAllowedOrigins(config.scriptOrigins),
      catch: (cause) => configError("invalid AWS WAF script origins", cause),
    });
    const page = AwsWafPage.make({
      url: context.response.url,
      status: context.response.status,
      scripts: discoverAwsWafScripts(context.body),
    });
    const decision = yield* config.bootstrap(page);
    if (Option.isNone(decision)) return Option.none();
    const bootstrap = yield* Schema.decodeEffect(AwsWafBootstrap)(
      decision.value,
    ).pipe(
      Effect.mapError((cause) =>
        configError("invalid AWS WAF bootstrap", cause),
      ),
    );
    const scripts = yield* Effect.try({
      try: () => {
        let challengeAsset = false;
        const selected = bootstrap.scripts.map((script): AwsWafPageScript => {
          if (AwsWafPageScript.guards.Unsupported(script))
            throw new TypeError(`unsupported AWS WAF script: ${script.reason}`);
          if (AwsWafPageScript.guards.Inline(script)) {
            if (script.source.trim() === "")
              throw new TypeError("empty AWS WAF inline script");
            return script;
          }
          const url = resolveAllowedUrl(script.url, page.url, origins);
          if (url.pathname.endsWith("/challenge.js")) challengeAsset = true;
          return { _tag: "External", url: url.toString() };
        });
        if (!challengeAsset)
          throw new TypeError(
            "AWS WAF bootstrap requires an external /challenge.js asset",
          );
        return selected;
      },
      catch: (cause) => configError("invalid AWS WAF selected scripts", cause),
    });
    const source = buildSource(scripts, bootstrap.acquisition ?? "page");
    if (new TextEncoder().encode(source).byteLength > 64 * 1024) {
      return yield* configError(
        "AWS WAF bootstrap exceeds the 64 KiB source limit",
      );
    }
    return yield* reviewedChallengeHandler({
      source,
      cookieNames: ["aws-waf-token"],
    })(challenge, context);
  });
