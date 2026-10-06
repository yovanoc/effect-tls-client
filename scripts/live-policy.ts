import { Effect } from "effect";
import {
  BrowserScriptError,
  type BrowserScriptHost,
} from "../packages/effect-tls-client/src/browser/BrowserScript.js";

export interface LiveRule {
  readonly origin: string;
  /** Include the trailing slash: a directory, never a lookalike prefix. */
  readonly pathPrefix?: string;
}

/** Restricts guest host calls; the library still owns redirects and cookies. */
export const restrictHost = (
  rules: ReadonlyArray<LiveRule>,
  host: BrowserScriptHost,
  pageUrl: string,
) => {
  const counters = { allowed: 0, denied: 0 };
  const request: BrowserScriptHost["request"] = Effect.fnUntraced(
    function* (input) {
      const url = yield* Effect.try({
        try: () => {
          // Reject ambiguous spellings BEFORE URL's dot-segment normalization.
          if (
            /[\\\u0000-\u0020\u007f]/.test(input.url) ||
            /%(?:2e|2f|5c|25)/i.test(input.url) ||
            /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(input.url)
          )
            throw new BrowserScriptError({
              reason: "live network policy denied",
            });
          const resolved = new URL(input.url, pageUrl);
          if (
            resolved.username !== "" ||
            resolved.password !== "" ||
            !rules.some(
              (rule) =>
                resolved.origin === rule.origin &&
                (rule.pathPrefix === undefined ||
                  (rule.pathPrefix.endsWith("/") &&
                    resolved.pathname.startsWith(rule.pathPrefix))),
            )
          )
            throw new BrowserScriptError({
              reason: "live network policy denied",
            });
          return resolved.href;
        },
        catch: () => {
          counters.denied++;
          return new BrowserScriptError({
            reason: "live network policy denied",
          });
        },
      });
      counters.allowed++;
      return yield* host.request({ ...input, url });
    },
  );
  // No iframe grant: this measurement selects root inline classic programs only.
  return { host: { request, setCookie: host.setCookie }, counters };
};
