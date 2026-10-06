import { Effect } from "effect";
import {
  BrowserScriptError,
  type BrowserScriptHost,
} from "../packages/effect-tls-client/src/browser/BrowserScript.js";

export interface LiveRule {
  readonly origin: string;
  /** Include the trailing slash: a directory, never a lookalike prefix. */
  readonly pathPrefix?: string;
  readonly allowedRequestKinds?: ReadonlyArray<"fetch" | "script" | "frame">;
}

export const MAX_HOST_CALL_COUNT = 256;

export interface LiveHostCallCounters {
  request: number;
  scriptLoad: number;
  setCookie: number;
  exportCookies: number;
}

export const makeHostCallCounters = (): LiveHostCallCounters => ({
  request: 0,
  scriptLoad: 0,
  setCookie: 0,
  exportCookies: 0,
});

export const countHostCall = (
  counters: LiveHostCallCounters,
  operation: keyof LiveHostCallCounters,
) => {
  counters[operation] = Math.min(counters[operation] + 1, MAX_HOST_CALL_COUNT);
};

/** Restricts guest host calls; the library still owns redirects and cookies. */
export const restrictHost = (
  rules: ReadonlyArray<LiveRule>,
  host: BrowserScriptHost,
  pageUrl: string,
  hostCalls = makeHostCallCounters(),
) => {
  const counters = { allowed: 0, denied: 0 };
  const request: BrowserScriptHost["request"] = Effect.fnUntraced(
    function* (input) {
      countHostCall(hostCalls, "request");
      if (input.kind === "script") countHostCall(hostCalls, "scriptLoad");
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
                (rule.allowedRequestKinds === undefined ||
                  rule.allowedRequestKinds.includes(input.kind)) &&
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
      return yield* host.request.call(host, { ...input, url });
    },
  );
  const setCookie: BrowserScriptHost["setCookie"] = (value) =>
    Effect.suspend(() => {
      countHostCall(hostCalls, "setCookie");
      return host.setCookie.call(host, value);
    });
  // Opt-in document mode grants no frame loading.
  return { host: { request, setCookie }, counters, hostCalls };
};
