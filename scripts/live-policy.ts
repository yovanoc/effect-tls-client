import { Effect, Schema } from "effect";
import {
  BrowserScriptError,
  type BrowserScriptHost,
  type BrowserScriptNetworkResponse,
} from "../packages/effect-tls-client/src/browser/BrowserScript.js";

export interface LiveRule {
  readonly origin: string;
  /** Include the trailing slash: a directory, never a lookalike prefix. */
  readonly pathPrefix?: string;
  readonly allowedRequestKinds?: ReadonlyArray<"fetch" | "script" | "frame">;
}

export const MAX_HOST_CALL_COUNT = 256;

/** Returned trusted callback values only; never physical-wire or execution proof. */
export const HostReply = Schema.Struct({
  operation: Schema.Literals(["fetch", "script"]),
  statusClass: Schema.Literals([
    "2xx",
    "3xx",
    "4xx",
    "5xx",
    "other",
    "UNKNOWN",
  ]),
  mimeClass: Schema.Literals([
    "javascript",
    "html",
    "json",
    "text",
    "other",
    "missing",
    "UNKNOWN",
  ]),
  bodySize: Schema.Literals([
    "empty",
    "at-most-64KiB",
    "at-most-1MiB",
    "larger",
    "UNKNOWN",
  ]),
});
export interface HostReply extends Schema.Schema.Type<typeof HostReply> {}
export const HostRepliesSchema = Schema.Array(HostReply).check(
  Schema.isMaxLength(MAX_HOST_CALL_COUNT),
);

export const classifyHostReply = (
  operation: HostReply["operation"],
  response: Pick<BrowserScriptNetworkResponse, "status" | "headers" | "body">,
): HostReply => {
  let statusClass: HostReply["statusClass"] = "UNKNOWN";
  if (Number.isInteger(response.status)) {
    if (response.status >= 200 && response.status < 300) statusClass = "2xx";
    else if (response.status >= 300 && response.status < 400)
      statusClass = "3xx";
    else if (response.status >= 400 && response.status < 500)
      statusClass = "4xx";
    else if (response.status >= 500 && response.status < 600)
      statusClass = "5xx";
    else statusClass = "other";
  }
  let mimeClass: HostReply["mimeClass"] = "UNKNOWN";
  const contentTypes = response.headers.filter(
    ([name]) => name.toLowerCase() === "content-type",
  );
  if (contentTypes.length === 0) mimeClass = "missing";
  else if (contentTypes.length === 1) {
    const mime =
      contentTypes[0]?.[1].split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(mime)) {
      if (/^(?:text|application)\/(?:java|ecma)script$/.test(mime))
        mimeClass = "javascript";
      else if (mime === "text/html") mimeClass = "html";
      else if (
        mime === "application/json" ||
        /^application\/.+\+json$/.test(mime)
      )
        mimeClass = "json";
      else if (mime.startsWith("text/")) mimeClass = "text";
      else mimeClass = "other";
    }
  }
  // UTF-8 size of the returned decoded string, not original wire bytes.
  const bytes = Buffer.byteLength(response.body);
  let bodySize: HostReply["bodySize"] = "UNKNOWN";
  if (bytes === 0) bodySize = "empty";
  else if (bytes <= 64 * 1024) bodySize = "at-most-64KiB";
  else if (bytes <= 1024 * 1024) bodySize = "at-most-1MiB";
  else bodySize = "larger";
  return HostReply.make({ operation, statusClass, mimeClass, bodySize });
};

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
  hostReplies: Array<HostReply> = [],
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
      const response = yield* host.request.call(host, { ...input, url });
      if (hostReplies.length < MAX_HOST_CALL_COUNT)
        hostReplies.push(classifyHostReply(input.kind, response));
      return response;
    },
  );
  const setCookie: BrowserScriptHost["setCookie"] = (value) =>
    Effect.suspend(() => {
      countHostCall(hostCalls, "setCookie");
      return host.setCookie.call(host, value);
    });
  // Opt-in document mode grants no frame loading.
  return { host: { request, setCookie }, counters, hostCalls, hostReplies };
};
