import { describe, expect, it } from "bun:test";
import { Cause, Effect, Result, Schema } from "effect";
import {
  BrowserScriptError,
  type BrowserScriptHost,
} from "../packages/effect-tls-client/src/browser/BrowserScript.js";
import { restrictHost } from "./live-policy.js";
import {
  classifyEvaluation,
  FailureReason,
  inlineClassicPrograms,
  staticHtmlObservations,
} from "./live-challenge.js";

const effectIt = <A, E>(name: string, run: () => Effect.Effect<A, E>) =>
  it(name, () => Effect.runPromise(run()));

const origin = "https://example.test";
const prefix = "/cdn-cgi/challenge-platform/";
const request = (url: string) => ({
  kind: "fetch" as const,
  url,
  method: "GET",
  headers: [],
  body: null,
  bodyBytes: null,
});
const fixture = () => {
  const seen: Array<string> = [];
  const host: BrowserScriptHost = {
    request: (input) =>
      Effect.sync(() => {
        seen.push(input.url);
        return {
          status: 200,
          url: input.url,
          headers: [],
          body: "",
          cookie: "",
        };
      }),
    setCookie: () => Effect.succeed(""),
  };
  return {
    seen,
    ...restrictHost([{ origin, pathPrefix: prefix }], host, `${origin}/page`),
  };
};

describe("live script network policy", () => {
  effectIt("allows directory prefixes and resolves relative URLs", () =>
    Effect.gen(function* () {
      const policy = fixture();
      yield* policy.host.request(request(`${origin}${prefix}asset.js`));
      yield* policy.host.request(request(`${prefix}collect?x=1`));
      expect(policy.seen).toEqual([
        `${origin}${prefix}asset.js`,
        `${origin}${prefix}collect?x=1`,
      ]);
      expect(policy.counters).toEqual({ allowed: 2, denied: 0 });
    }),
  );
  for (const url of [
    "/other",
    "https://other.test/cdn-cgi/challenge-platform/a",
    "/cdn-cgi/challenge-platform",
    "/cdn-cgi/challenge-platform-lookalike/a",
    "/cdn-cgi/challenge-platform/../other",
    "/cdn-cgi/other/../challenge-platform/a",
    "/cdn-cgi/challenge-platform/%2e%2E/other",
    "/cdn-cgi/challenge-platform/.%2e/other",
    "/cdn-cgi/challenge-platform/%252e%252e/other",
    "/cdn-cgi/challenge-platform/%2fother",
    "/cdn-cgi/challenge-platform/..\\other",
    "https://user@example.test/cdn-cgi/challenge-platform/a",
  ]) {
    effectIt(`denies ${url}`, () =>
      Effect.gen(function* () {
        const policy = fixture();
        const result = yield* policy.host
          .request(request(url))
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure).toBeInstanceOf(BrowserScriptError);
        expect(policy.seen).toEqual([]);
        expect(policy.counters).toEqual({ allowed: 0, denied: 1 });
      }),
    );
  }
  effectIt("supports origin-only DataDome rules", () =>
    Effect.gen(function* () {
      const policy = fixture();
      const restricted = restrictHost(
        [{ origin: "https://js.datadome.co" }],
        policy.host,
        `${origin}/page`,
      );
      // The wrapped downstream fixture denies this origin; the outer grant still counts as allowed.
      yield* restricted.host
        .request(request("https://js.datadome.co/tags.js"))
        .pipe(Effect.result);
      expect(restricted.counters).toEqual({ allowed: 1, denied: 0 });
      expect(policy.counters).toEqual({ allowed: 0, denied: 1 });
    }),
  );
});

describe("static HTML observations", () => {
  it("counts provider, same-origin, other, and unparsable scripts plus iframes", () => {
    expect(
      staticHtmlObservations(
        `<script src="/app.js"></script>
        <script src="https://js.datadome.co/tags.js"></script>
        <script src="https://api-js.datadome.co/tags.js"></script>
        <script src="https://captcha-delivery.com/a.js"></script>
        <script src="https://geo.captcha-delivery.com/a.js"></script>
        <script src="https://challenges.cloudflare.com/a.js"></script>
        <script src="/cdn-cgi/challenge-platform/a.js"></script>
        <script src="https://other.test/a.js"></script>
        <script src="http://[::1"></script>
        <iframe></iframe><IFRAME src="frame.html"></IFRAME>`,
        "https://page.test/path",
      ),
    ).toEqual({
      staticScripts: { sameOrigin: 1, provider: 6, other: 1, unparsable: 1 },
      iframes: 2,
    });
  });
});

describe("unchanged inline classic selection", () => {
  it("keeps source and document order without selecting external/module/inert scripts", () => {
    const first = "\r\nvar original = '<tag>';\r\n";
    const second = "window.second = true;";
    expect(
      inlineClassicPrograms(`<!doctype html><html><head>
      <!-- <script>comment()</script> -->
      <script data-test=">">${first}</script>
      <script src="asset.js">external()</script>
      <script type="module">module()</script>
      </head><body><noscript><script>inert()</script></noscript>
      <script TYPE='text/javascript' >${second}</script></body></html>`),
    ).toEqual([first, second]);
  });
  it("fails closed on ambiguous attributes or script escape syntax", () => {
    expect(() =>
      inlineClassicPrograms('<script type="" TYPE="module">bad()</script>'),
    ).toThrow(BrowserScriptError);
    expect(() =>
      inlineClassicPrograms("<script><!-- escaped() --></script>"),
    ).toThrow(BrowserScriptError);
    expect(() => inlineClassicPrograms("<script>unterminated()")).toThrow(
      BrowserScriptError,
    );
    expect(() =>
      inlineClassicPrograms("<!-- <script>comment()</script>"),
    ).toThrow(BrowserScriptError);
  });
});

describe("evaluation receipt failure metadata", () => {
  effectIt(
    "classifies success, timeout, interruption and defects without free text",
    () =>
      Effect.gen(function* () {
        expect(yield* classifyEvaluation(Effect.void)).toEqual({
          failureClass: "NONE",
          failureReason: "NONE",
        });
        expect(
          yield* classifyEvaluation(Effect.fail(new Cause.TimeoutError())),
        ).toEqual({ failureClass: "TIMEOUT", failureReason: "TIMEOUT" });
        expect(yield* classifyEvaluation(Effect.interrupt)).toEqual({
          failureClass: "TIMEOUT",
          failureReason: "INTERRUPTED",
        });
        expect(
          yield* classifyEvaluation(Effect.die("private payload")),
        ).toEqual({ failureClass: "OTHER", failureReason: "OTHER" });
      }),
  );
  for (const [reason, label] of [
    ["unsupported HTML document", "UNSUPPORTED_DOCUMENT"],
    ["invalid document snapshot", "INVALID_SNAPSHOT"],
    ["document evaluation requires a complete document", "MISSING_DOCUMENT"],
    ["HTML document exceeds elements limit", "DOCUMENT_ELEMENTS"],
    ["script IPC start input exceeds its 128 KiB limit", "START_INPUT_LIMIT"],
    [
      "Runtime does not support document script evaluation",
      "RUNTIME_UNSUPPORTED",
    ],
    ["live network policy denied", "LIVE_POLICY_DENIED"],
    ["script evaluation timed out", "TIMEOUT"],
    [
      "script evaluation timed out and the process was terminated",
      "PROCESS_TIMEOUT",
    ],
    [
      "BrowserMock requires Node 25+ network permission denial support",
      "NODE_UNSUPPORTED",
    ],
    ["private guest data", "OTHER"],
    ["unsupported HTML document private suffix", "OTHER"],
    ["prefix script evaluation timed out", "OTHER"],
    ["__proto__", "OTHER"],
  ] as const) {
    effectIt(`maps exact authored reason to ${label}`, () =>
      Effect.gen(function* () {
        const error = new BrowserScriptError({ reason });
        Object.defineProperty(error, "cause", {
          get: () => {
            throw new Error("cause read");
          },
        });
        const result = yield* classifyEvaluation(Effect.fail(error));
        expect(result).toEqual({
          failureClass: "SCRIPT",
          failureReason: label,
        });
        expect(
          Schema.decodeUnknownSync(FailureReason)(result.failureReason),
        ).toBe(label);
        expect(Object.keys(result)).toEqual(["failureClass", "failureReason"]);
      }),
    );
  }
  it("rejects free text as receipt metadata", () => {
    expect(() =>
      Schema.decodeUnknownSync(FailureReason)("private guest data"),
    ).toThrow();
  });
});
