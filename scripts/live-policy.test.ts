import { describe, expect, it } from "bun:test";
import { Cause, Deferred, Effect, Fiber, Layer, Result, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import {
  BrowserMock,
  BrowserMockOptions,
} from "../packages/effect-tls-client/src/browser/BrowserMock.js";
import { runBoundedScript } from "../packages/effect-tls-client/src/browser/BrowserScript.js";
import {
  BrowserScriptError,
  type BrowserScriptHost,
  type BrowserScriptRuntime,
} from "../packages/effect-tls-client/src/browser/BrowserScript.js";
import {
  HostRepliesSchema,
  classifyHostReply,
  countHostCall,
  makeHostCallCounters,
  MAX_HOST_CALL_COUNT,
  restrictHost,
} from "./live-policy.js";
import {
  classifyEvaluation,
  classifyInitialChallenge,
  classifyFrameOrigin,
  FrameLoadRequests,
  FrameOriginCounts,
  didProviderCookieChange,
  encodeReceipt,
  FailureReason,
  inspectProtectedBody,
  isProven,
  HostCallCountersSchema,
  inlineClassicPrograms,
  incrementCount,
  readExportedCookies,
  Receipt,
  NativePreflightRejections,
  restrictRuntime,
  staticHtmlObservations,
} from "./live-challenge.js";

const effectIt = <A, E>(name: string, run: () => Effect.Effect<A, E>) =>
  it(name, () => Effect.runPromise(run()));

const origin = "https://example.test";
const ctOrigin = "https://ct.captcha-delivery.com";
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
  effectIt(
    "permits only exact CT script loads and never delegates fetches or frames",
    () =>
      Effect.gen(function* () {
        const calls = {
          requests: [] as Array<Parameters<BrowserScriptHost["request"]>[0]>,
          receivers: [] as Array<unknown>,
          frames: [] as Array<string>,
        };
        const host = {
          request(
            this: BrowserScriptHost,
            input: Parameters<BrowserScriptHost["request"]>[0],
          ) {
            calls.receivers.push(this);
            calls.requests.push(input);
            return Effect.succeed({
              status: 200,
              url: input.url,
              headers: [],
              body: "",
              cookie: "",
            });
          },
          setCookie: () => Effect.succeed(""),
          loadFrame(this: BrowserScriptHost, url: string) {
            calls.receivers.push(this);
            calls.frames.push(url);
            return Effect.fail(
              new BrowserScriptError({ reason: "unexpected frame delegation" }),
            );
          },
        } satisfies BrowserScriptHost;
        const policy = restrictHost(
          [{ origin: ctOrigin, allowedRequestKinds: ["script"] }],
          host,
          `${origin}/page`,
        );
        const headers = [["accept", "*/*"]] as const;
        const scriptInput = {
          ...request(`${ctOrigin}/response.js`),
          kind: "script" as const,
          headers,
        };
        const getInput = request(`${ctOrigin}/collect`);
        const postInput = { ...getInput, method: "POST", body: "payload" };
        const siblingScript = {
          ...scriptInput,
          url: "https://geo.captcha-delivery.com/response.js",
        };

        const script = policy.host.request(scriptInput);
        expect(calls.requests).toEqual([]);
        expect(policy.hostCalls.request).toBe(0);
        yield* script;
        for (const input of [getInput, postInput, siblingScript]) {
          const result = yield* policy.host.request(input).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toBeInstanceOf(BrowserScriptError);
        }

        expect(calls.requests).toHaveLength(1);
        expect(calls.requests[0]).toMatchObject({
          kind: "script",
          url: `${ctOrigin}/response.js`,
          method: "GET",
          headers,
          body: null,
          bodyBytes: null,
        });
        expect(calls.requests[0]?.headers).toBe(headers);
        expect(calls.receivers).toEqual([host]);
        expect("loadFrame" in policy.host).toBe(false);
        expect(calls.frames).toEqual([]);
        expect(policy.counters).toEqual({ allowed: 1, denied: 3 });
        expect(policy.hostCalls).toEqual({
          request: 4,
          scriptLoad: 2,
          setCookie: 0,
          exportCookies: 0,
        });
      }),
  );

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
        expect(policy.hostCalls.request).toBe(1);
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

describe("finite host-call counters", () => {
  effectIt(
    "counts lazy requests and cookie writes once with the original receiver",
    () =>
      Effect.gen(function* () {
        const calls = {
          requests: [] as Array<unknown>,
          cookies: [] as Array<string>,
          receivers: [] as Array<unknown>,
        };
        const host = {
          request(
            this: BrowserScriptHost,
            input: Parameters<BrowserScriptHost["request"]>[0],
          ) {
            calls.receivers.push(this);
            calls.requests.push(input);
            return Effect.succeed({
              status: 200,
              url: input.url,
              headers: [],
              body: "",
              cookie: "",
            });
          },
          setCookie(this: BrowserScriptHost, value: string) {
            calls.receivers.push(this);
            calls.cookies.push(value);
            return Effect.succeed("");
          },
        } satisfies BrowserScriptHost;
        const policy = restrictHost(
          [{ origin, pathPrefix: prefix }],
          host,
          `${origin}/page`,
        );
        const fetchInput = request(`${origin}${prefix}fetch`);
        const scriptInput = {
          ...request(`${origin}${prefix}asset.js`),
          kind: "script" as const,
        };
        const fetch = policy.host.request(fetchInput);
        const script = policy.host.request(scriptInput);
        const cookieWrite = policy.host.setCookie("fixture=yes");

        expect(calls.requests).toEqual([]);
        expect(calls.cookies).toEqual([]);
        expect(policy.hostCalls).toEqual({
          request: 0,
          scriptLoad: 0,
          setCookie: 0,
          exportCookies: 0,
        });
        yield* fetch;
        yield* script;
        yield* cookieWrite;

        expect(calls.requests).toHaveLength(2);
        expect(calls.requests).toEqual([fetchInput, scriptInput]);
        expect(calls.cookies).toEqual(["fixture=yes"]);
        expect(calls.receivers).toEqual([host, host, host]);
        expect(policy.hostCalls).toEqual({
          request: 2,
          scriptLoad: 1,
          setCookie: 1,
          exportCookies: 0,
        });
        expect("loadFrame" in policy.host).toBe(false);
      }),
  );

  effectIt("counts exportCookies as a lazy Effect property", () =>
    Effect.gen(function* () {
      let executions = 0;
      const transport = {
        exportCookies: Effect.sync(() => {
          executions++;
          return "[]";
        }),
      };
      const hostCalls = makeHostCallCounters();
      const exported = readExportedCookies(transport, hostCalls);

      expect(typeof transport.exportCookies).not.toBe("function");
      expect(executions).toBe(0);
      expect(hostCalls.exportCookies).toBe(0);
      expect(yield* exported).toBe("[]");
      expect(executions).toBe(1);
      expect(hostCalls.exportCookies).toBe(1);
    }),
  );

  it("saturates each counter at its schema maximum and rejects extra receipt fields", () => {
    const counters = makeHostCallCounters();
    let attempts = 0;
    for (let index = 0; index < MAX_HOST_CALL_COUNT + 3; index++) {
      countHostCall(counters, "request");
      attempts = incrementCount(attempts);
    }
    expect(counters.request).toBe(MAX_HOST_CALL_COUNT);
    expect(attempts).toBe(MAX_HOST_CALL_COUNT);
    expect(Schema.decodeUnknownSync(HostCallCountersSchema)(counters)).toEqual(
      counters,
    );
    expect(() =>
      Schema.decodeUnknownSync(HostCallCountersSchema)({
        ...counters,
        request: MAX_HOST_CALL_COUNT + 1,
      }),
    ).toThrow();

    const unknownReceipt = {
      kind: "LIVE_CHALLENGE" as const,
      target: "datadome" as const,
      result: "UNKNOWN" as const,
    };
    expect(JSON.parse(encodeReceipt(unknownReceipt))).toEqual(unknownReceipt);
    const extraReceipt = { ...unknownReceipt, extra: "not allowed" };
    expect(() => encodeReceipt(extraReceipt)).toThrow();
  });

  it("keeps omitted runtime capabilities and host callbacks omitted", () => {
    const runtime: BrowserScriptRuntime = {
      evaluate: () => Effect.succeed({ value: "", setCookies: [] }),
    };
    const wrapped = restrictRuntime(runtime, [{ origin }], {
      allowed: 0,
      denied: 0,
    });
    expect("evaluateClassic" in wrapped).toBe(false);
    expect("evaluateDocument" in wrapped).toBe(false);
    expect("loadFrame" in fixture().host).toBe(false);
  });
});

describe("static HTML observations", () => {
  const pageUrl = "https://page.test/path";
  const html = `<script src="/app.js"></script>
    <script src="https://js.datadome.co/tags.js"></script>
    <script src="https://api-js.datadome.co/tags.js"></script>
    <script src="https://captcha-delivery.com/a.js"></script>
    <script src="https://ct.captcha-delivery.com/response.js"></script>
    <script src="https://geo.captcha-delivery.com/a.js"></script>
    <script src="https://challenges.cloudflare.com/a.js"></script>
    <script src="/cdn-cgi/challenge-platform/a.js"></script>
    <script src="https://other.test/a.js"></script>
    <script src="http://[::1"></script>
    <iframe></iframe><IFRAME src="frame.html"></IFRAME>`;
  const dataDomeAllowedOrigins = [
    "https://page.test",
    "https://js.datadome.co",
    "https://api-js.datadome.co",
    ctOrigin,
  ];
  const cloudflareAllowedOrigins = ["https://page.test"];

  it("counts each finite script class plus iframes", () => {
    expect(
      staticHtmlObservations(html, pageUrl, dataDomeAllowedOrigins),
    ).toEqual({
      staticScripts: {
        sameOrigin: 1,
        datadomeTag: 1,
        datadomeApi: 1,
        captchaDelivery: 3,
        cloudflare: 2,
        other: 1,
        unparsable: 1,
      },
      staticScriptsNotAllowed: 4,
      iframes: 2,
    });
  });

  for (const [target, allowedOrigins, expected] of [
    ["DataDome", dataDomeAllowedOrigins, 4],
    ["Cloudflare", cloudflareAllowedOrigins, 7],
  ] as const) {
    it(`counts static origins outside the ${target} allowlist`, () => {
      expect(
        staticHtmlObservations(html, pageUrl, allowedOrigins)
          .staticScriptsNotAllowed,
      ).toBe(expected);
    });
  }
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
    ["script evaluation timed out; process terminated", "TIMEOUT"],
    ["document script resource load failed", "RESOURCE_FAILURE"],
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

describe("conservative live proof gate", () => {
  const valid = (overrides: Partial<Parameters<typeof isProven>[0]> = {}) => ({
    initialEnforcementObserved: true,
    initialChallengeUrlMatches: true,
    initialStatus: 403,
    hookInvocations: 1,
    evaluations: { attempts: 1, success: 1, failure: 0 },
    failureClass: "NONE" as const,
    failureReason: "NONE" as const,
    nativePreflightRejections: 0 as const,
    networkDenied: 0,
    staticScriptsNotAllowed: 0,
    providerCookieChanged: true,
    retried: true,
    finalUrlMatches: true,
    redirectCount: 0,
    finalStatus: 200,
    bodyGate: "VERIFIED" as const,
    protectedContentVerified: true,
    finalChallengeRecognized: false,
    finalMarkersPresent: false,
    ...overrides,
  });

  const completeDocument = (body: string, head = "") =>
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
  const protectedBody = (input: {
    finalBody: string;
    finalStatus?: number;
    initialBody?: string;
    contentType?: string;
    expectedContent?: string;
  }) =>
    inspectProtectedBody({
      target: "cloudflare",
      initialBody:
        input.initialBody ?? completeDocument("<main>Just a moment</main>"),
      finalBody: input.finalBody,
      finalStatus: input.finalStatus ?? 200,
      headers: [
        ["content-type", input.contentType ?? "text/html; charset=utf-8"],
      ],
      finalChallengeRecognized: false,
      ...(input.expectedContent === undefined
        ? {}
        : { expectedContent: input.expectedContent }),
    });

  it("accepts only an authored synthetic expected-content verifier", () => {
    const marker = "Protected workspace: synthetic-record-42";
    const evidence = protectedBody({
      finalBody: completeDocument(`<main>${marker}</main>`),
      expectedContent: marker,
    });
    expect(evidence).toEqual({
      bodyGate: "VERIFIED",
      protectedContentVerified: true,
    });
    // This verifier is specific to this authored fixture; measure() supplies none.
    expect(isProven({ ...valid(), ...evidence })).toBe(true);
  });

  it("rejects a marker already present in the initial supported body text", () => {
    const marker = "Protected workspace: synthetic-record-42";
    const evidence = protectedBody({
      initialBody: completeDocument(`<main>${marker}</main>`),
      finalBody: completeDocument(`<main>Updated: ${marker}</main>`),
      expectedContent: marker,
    });
    expect(evidence).toEqual({
      bodyGate: "NO_SUPPORTED_VERIFIER",
      protectedContentVerified: false,
    });
    expect(isProven({ ...valid(), ...evidence })).toBe(false);
  });

  it("does not prove a changed provider cookie after failed document evaluation", () => {
    expect(
      isProven(
        valid({
          evaluations: { attempts: 1, success: 0, failure: 1 },
          failureClass: "SCRIPT",
          failureReason: "RESOURCE_FAILURE",
        }),
      ),
    ).toBe(false);
  });

  it("requires observed enforcement and zero denied or non-allowed work", () => {
    expect(isProven(valid({ initialEnforcementObserved: false }))).toBe(false);
    expect(isProven(valid({ networkDenied: 1 }))).toBe(false);
    expect(isProven(valid({ nativePreflightRejections: 1 }))).toBe(false);
    expect(isProven(valid({ nativePreflightRejections: "UNKNOWN" }))).toBe(
      false,
    );
    expect(isProven(valid({ staticScriptsNotAllowed: 1 }))).toBe(false);
  });

  it("requires one hook and one evaluation against the fixed URL with no redirects", () => {
    expect(isProven(valid({ hookInvocations: 0 }))).toBe(false);
    expect(isProven(valid({ hookInvocations: 2 }))).toBe(false);
    expect(
      isProven(valid({ evaluations: { attempts: 2, success: 2, failure: 0 } })),
    ).toBe(false);
    expect(
      isProven(valid({ evaluations: { attempts: 2, success: 1, failure: 1 } })),
    ).toBe(false);
    expect(isProven(valid({ initialChallengeUrlMatches: false }))).toBe(false);
    expect(isProven(valid({ initialStatus: 200 }))).toBe(false);
    expect(isProven(valid({ redirectCount: 1 }))).toBe(false);
    expect(isProven(valid({ redirectCount: null }))).toBe(false);
  });

  it("rejects external denial, non-success status, and URL changes", () => {
    expect(isProven(valid({ networkDenied: 1 }))).toBe(false);
    expect(isProven(valid({ finalStatus: 404 }))).toBe(false);
    expect(isProven(valid({ finalUrlMatches: false }))).toBe(false);
  });

  it("rejects no-body, unchanged, noscript-only, error, and interstitial content", () => {
    const blocked = [
      protectedBody({
        finalBody: completeDocument("<main>Protected marker</main>"),
        finalStatus: 204,
        expectedContent: "Protected marker",
      }),
      protectedBody({ finalBody: "", expectedContent: "Protected marker" }),
      protectedBody({
        finalBody: completeDocument(
          "<noscript>Please enable scripting</noscript>",
        ),
        expectedContent: "Please enable scripting",
      }),
      protectedBody({
        finalBody: completeDocument("<main>Internal server error</main>"),
        expectedContent: "Internal server error",
      }),
      protectedBody({
        finalBody: completeDocument("<main>Access denied interstitial</main>"),
        expectedContent: "Access denied interstitial",
      }),
      protectedBody({
        finalBody: completeDocument("Just a moment"),
        initialBody: completeDocument("Just a moment"),
        expectedContent: "Just a moment",
      }),
    ];
    expect(blocked.map((evidence) => evidence.bodyGate)).toEqual([
      "NO_BODY",
      "NO_BODY",
      "NOSCRIPT_ONLY",
      "BLOCKED_CONTENT",
      "BLOCKED_CONTENT",
      "UNCHANGED",
    ]);
    for (const evidence of blocked)
      expect(isProven({ ...valid(), ...evidence })).toBe(false);
  });

  it("fails closed for unsupported, malformed, and error-page bodies", () => {
    const marker = "Protected workspace: synthetic-record-42";
    const blocked = [
      protectedBody({
        finalBody: completeDocument(`<script>${marker}`),
        expectedContent: marker,
      }),
      protectedBody({
        finalBody: completeDocument(`<!-- ${marker}`),
        expectedContent: marker,
      }),
      protectedBody({
        finalBody: completeDocument(`<main hidden>${marker}</main>`),
        expectedContent: marker,
      }),
      protectedBody({
        finalBody: completeDocument(
          `<main style="display:none">${marker}</main>`,
        ),
        expectedContent: marker,
      }),
      protectedBody({
        finalBody: completeDocument(
          `<main>${marker}</main>`,
          "<style>main { display: none }</style>",
        ),
        expectedContent: marker,
      }),
      protectedBody({
        finalBody: completeDocument(
          "<main>Public summary</main>",
          `<title>${marker}</title>`,
        ),
        expectedContent: marker,
      }),
      protectedBody({
        finalBody: completeDocument(`<textarea>${marker}</textarea>`),
        expectedContent: marker,
      }),
      protectedBody({
        finalBody: completeDocument(`<main>${marker}</body>`),
        expectedContent: marker,
      }),
      protectedBody({
        finalBody: `{"error":"${marker}"}`,
        finalStatus: 500,
        contentType: "application/json; charset=utf-8",
        expectedContent: marker,
      }),
      protectedBody({
        finalBody: '{"error":',
        finalStatus: 500,
        contentType: "application/problem+json",
        expectedContent: marker,
      }),
    ];
    expect(
      blocked.every((evidence) => !evidence.protectedContentVerified),
    ).toBe(true);
    expect(blocked.every((evidence) => evidence.bodyGate !== "VERIFIED")).toBe(
      true,
    );
  });

  it("does not treat arbitrary nonempty app-looking content as protected evidence", () => {
    const evidence = protectedBody({
      finalBody: completeDocument("<main>Protected dashboard</main>"),
    });
    expect(evidence).toEqual({
      bodyGate: "NO_SUPPORTED_VERIFIER",
      protectedContentVerified: false,
    });
    expect(isProven({ ...valid(), ...evidence })).toBe(false);
  });

  it("compares authoritative cookie snapshots taken after the initial response", () => {
    const beforeEvaluation = new Map([
      ["datadome\n/\n", "initial-response-cookie"],
    ]);
    expect(
      didProviderCookieChange(beforeEvaluation, new Map(beforeEvaluation)),
    ).toBe(false);
    expect(
      didProviderCookieChange(
        beforeEvaluation,
        new Map([["datadome\n/\n", "guest-evaluation-cookie"]]),
      ),
    ).toBe(true);
  });
});

describe("trusted returned host replies", () => {
  effectIt(
    "preserves optional runtime properties, receivers and authored arguments",
    () =>
      Effect.gen(function* () {
        const source = "\r\nvar authored = 'source unchanged';\r\n";
        const context = {
          url: `${origin}/page`,
          cookie: "",
          userAgent: "fixture",
          document: "authored document",
        };
        const seen: Array<unknown> = [];
        const runtime: BrowserScriptRuntime = {
          allowedOrigins: [origin],
          allowedPathPrefixes: { [origin]: [prefix] },
          allowedRequestKinds: { [origin]: ["script"] },
          maxNetworkRequests: 16,
          timeoutMs: 25_000,
          evaluate(source, context, host) {
            seen.push([this, source, context, host]);
            return Effect.succeed({ value: "", setCookies: [] });
          },
          evaluateClassic(source, context, host) {
            seen.push([this, source, context, host]);
            return Effect.succeed({ value: "", setCookies: [] });
          },
          evaluateDocument(context, host) {
            seen.push([this, context, host]);
            return Effect.succeed({ value: "", setCookies: [] });
          },
        };
        const wrapped = restrictRuntime(runtime, [{ origin }], {
          allowed: 0,
          denied: 0,
        });
        const host = fixture().host;
        const evaluation = wrapped.evaluate(source, context, host);
        expect(seen).toEqual([]);
        yield* evaluation;
        if (
          wrapped.evaluateClassic === undefined ||
          wrapped.evaluateDocument === undefined
        )
          return yield* new BrowserScriptError({
            reason: "authored capability missing",
          });
        yield* wrapped.evaluateClassic(source, context, host);
        yield* wrapped.evaluateDocument(context, host);
        expect(seen).toHaveLength(3);
        expect(seen).toEqual([
          [
            runtime,
            source,
            context,
            expect.objectContaining({
              request: expect.any(Function),
              setCookie: expect.any(Function),
            }),
          ],
          [
            runtime,
            source,
            context,
            expect.objectContaining({
              request: expect.any(Function),
              setCookie: expect.any(Function),
            }),
          ],
          [
            runtime,
            context,
            expect.objectContaining({
              request: expect.any(Function),
              setCookie: expect.any(Function),
            }),
          ],
        ]);
        expect(wrapped.allowedOrigins).toBe(runtime.allowedOrigins);
        expect(wrapped.allowedPathPrefixes).toBe(runtime.allowedPathPrefixes);
        expect(wrapped.allowedRequestKinds).toBe(runtime.allowedRequestKinds);
        expect(wrapped.maxNetworkRequests).toBe(16);
        expect(wrapped.timeoutMs).toBe(25_000);
      }),
  );
  effectIt(
    "observes only returned replies, lazily, with single unchanged delegation",
    () =>
      Effect.gen(function* () {
        const source = "\r\nwindow.authored = 'unchanged';\r\n";
        const response = {
          status: 403,
          url: `${origin}/private?query=yes`,
          headers: [
            ["Content-Type", "text/javascript; charset=utf-8"],
            ["private", "secret"],
          ] as const,
          body: source,
          cookie: "private=value",
        };
        const inputs: Array<Parameters<BrowserScriptHost["request"]>[0]> = [];
        const receivers: Array<unknown> = [];
        let executions = 0;
        const host: BrowserScriptHost = {
          request(input) {
            inputs.push(input);
            receivers.push(this);
            return Effect.sync(() => {
              executions++;
              return response;
            });
          },
          setCookie: () => Effect.succeed(""),
        };
        const policy = restrictHost([{ origin }], host, `${origin}/page`);
        const input = {
          ...request(`${origin}/asset.js`),
          kind: "script" as const,
          body: "authored request",
          bodyBytes: null,
        };
        const pending = policy.host.request(input);
        expect(policy.hostReplies).toEqual([]);
        expect(inputs).toEqual([]);
        expect(executions).toBe(0);
        const returned = yield* pending;
        expect(returned).toBe(response);
        expect(returned.body).toBe(source);
        expect(inputs).toEqual([input]);
        expect(inputs[0]?.headers).toBe(input.headers);
        expect(receivers).toEqual([host]);
        expect(executions).toBe(1);
        expect(policy.hostReplies).toEqual([
          {
            operation: "script",
            statusClass: "4xx",
            mimeClass: "javascript",
            bodySize: "at-most-64KiB",
          },
        ]);
        yield* policy.host
          .request(request("https://denied.test/"))
          .pipe(Effect.result);
        expect(policy.hostReplies).toHaveLength(1);
        expect(executions).toBe(1);
      }),
  );

  effectIt(
    "failed operations propagate without a reply or error inspection",
    () =>
      Effect.gen(function* () {
        const error = new BrowserScriptError({
          reason: "authored private failure",
        });
        let reads = 0;
        Object.defineProperty(error, "reason", {
          get: () => {
            reads++;
            return "private";
          },
        });
        const policy = restrictHost(
          [{ origin }],
          {
            request: () => Effect.fail(error),
            setCookie: () => Effect.succeed(""),
          },
          `${origin}/page`,
        );
        const result = yield* policy.host
          .request(request(`${origin}/asset.js`))
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure).toBe(error);
        expect(reads).toBe(0);
        expect(policy.hostCalls.request).toBe(1);
        expect(policy.hostReplies).toEqual([]);
      }),
  );

  it("classifies only status, Content-Type and UTF-8 size; missing metadata stays unknown", () => {
    const reply = (
      status: number,
      headers: ReadonlyArray<readonly [string, string]>,
      body = "",
    ) => classifyHostReply("fetch", { status, headers, body });
    expect(reply(Number.NaN, [])).toEqual({
      operation: "fetch",
      statusClass: "UNKNOWN",
      mimeClass: "missing",
      bodySize: "empty",
    });
    for (const [status, label] of [
      [200, "2xx"],
      [399, "3xx"],
      [404, "4xx"],
      [599, "5xx"],
      [100, "other"],
      [600, "other"],
      [200.5, "UNKNOWN"],
      [Infinity, "UNKNOWN"],
    ] as const)
      expect(reply(status, []).statusClass).toBe(label);
    for (const [mime, label] of [
      ["TEXT/JAVASCRIPT; charset=utf-8", "javascript"],
      ["application/ecmascript", "javascript"],
      ["text/html", "html"],
      ["application/json", "json"],
      ["application/problem+json", "json"],
      ["text/plain", "text"],
      ["image/png", "other"],
      ["", "UNKNOWN"],
      ["not a mime", "UNKNOWN"],
    ] as const)
      expect(reply(200, [["Content-Type", mime]]).mimeClass).toBe(label);
    expect(
      reply(200, [
        ["content-type", "text/html"],
        ["CONTENT-TYPE", "text/html"],
      ]).mimeClass,
    ).toBe("UNKNOWN");
    // Body spelling never supplies MIME evidence.
    expect(reply(200, [], "<html>authored</html>").mimeClass).toBe("missing");
    for (const [body, label] of [
      ["", "empty"],
      ["é".repeat(32768), "at-most-64KiB"],
      ["x".repeat(65537), "at-most-1MiB"],
      ["x".repeat(1048576), "at-most-1MiB"],
      ["x".repeat(1048577), "larger"],
    ] as const)
      expect(reply(200, [], body).bodySize).toBe(label);
  });

  effectIt(
    "saturates reply storage, shares it across runtime evaluations, and validates the full envelope",
    () =>
      Effect.gen(function* () {
        const policy = fixture();
        let delegations = 0;
        const runtime: BrowserScriptRuntime = {
          evaluate: (_source, _context, host) =>
            Effect.gen(function* () {
              if (host === undefined)
                return yield* new BrowserScriptError({
                  reason: "authored host absent",
                });
              yield* host.request(request(`${origin}${prefix}asset.js`));
              delegations++;
              return { value: "", setCookies: [] };
            }),
        };
        const replies: Array<(typeof HostRepliesSchema.Type)[number]> = [];
        const wrapped = restrictRuntime(
          runtime,
          [{ origin }],
          { allowed: 0, denied: 0 },
          makeHostCallCounters(),
          replies,
        );
        for (let index = 0; index < MAX_HOST_CALL_COUNT + 3; index++)
          yield* wrapped.evaluate(
            "authored",
            { url: `${origin}/page`, cookie: "", userAgent: "fixture" },
            policy.host,
          );
        expect(delegations).toBe(MAX_HOST_CALL_COUNT + 3);
        expect(replies).toHaveLength(MAX_HOST_CALL_COUNT);
        expect(Schema.decodeUnknownSync(HostRepliesSchema)(replies)).toEqual(
          replies,
        );
        expect(() =>
          Schema.decodeUnknownSync(HostRepliesSchema)([...replies, replies[0]]),
        ).toThrow();
        const receipt = Receipt.make({
          kind: "LIVE_CHALLENGE",
          target: "cloudflare",
          initialStatus: 403,
          initialChallengeUrlMatches: true,
          initialRecognizedChallenge: true,
          initialMarkersPresent: true,
          hookInvocations: 1,
          inlinePrograms: 0,
          evaluationTimings: [],
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
          evaluations: { attempts: 1, success: 0, failure: 1 },
          failureClass: "SCRIPT",
          failureReason: "OTHER",
          network: { allowed: 1, denied: 0 },
          nativePreflightRejections: 0,
          frameLoadRequests: 0,
          frameOrigins: {
            datadomeCaptchaDelivery: 0,
            cloudflareChallenges: 0,
            sameOrigin: 0,
            other: 0,
            unparsable: 0,
          },
          datadomeResponseType: "missing",
          datadomeBlockType: "missing",
          cloudflareChallengeType: "missing",
          hostCalls: makeHostCallCounters(),
          hostReplies: replies,
          providerCookieBefore: false,
          providerCookieAfter: false,
          providerCookieChanged: false,
          retried: false,
          finalStatus: 403,
          redirectCount: 0,
          finalRedirected: false,
          finalChallengeRecognized: true,
          finalMarkersPresent: true,
          bodyGate: "NO_SUPPORTED_VERIFIER",
          protectedContentVerified: false,
          proven: false,
        });
        const encoded = encodeReceipt(receipt);
        expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64 * 1024);
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(Receipt), {
            onExcessProperty: "error",
          })(encoded),
        ).toEqual(receipt);
        for (const invalid of [
          { ...receipt, datadomeResponseType: "private" },
          { ...receipt, datadomeBlockType: "private" },
          { ...receipt, cloudflareChallengeType: "private" },
          { ...receipt, frameLoadRequests: 257 },
          { ...receipt, frameOrigins: { ...receipt.frameOrigins, other: 257 } },
        ])
          expect(() => Schema.decodeUnknownSync(Receipt)(invalid)).toThrow();
        const extra = {
          ...receipt,
          hostReplies: [{ ...replies[0], raw: "private" }],
        };
        expect(() => encodeReceipt(extra)).toThrow();
        expect(() =>
          Schema.decodeUnknownSync(Receipt)({
            ...receipt,
            hostReplies: [
              {
                operation: "script",
                statusClass: "200",
                mimeClass: "text/javascript",
                bodySize: "empty",
              },
            ],
          }),
        ).toThrow();
      }),
  );
});

const describeNative =
  process.env.TLS_CLIENT_INTEGRATION === "1" ? describe : describe.skip;

describeNative(
  "composed authored document parent preflight observations",
  () => {
    const pageUrl = "http://127.0.0.1:43127/page";
    const localOrigin = new URL(pageUrl).origin;
    const source =
      '\r\nwindow.finished = fetch("/fetch").then(r => r.text()).then(body => { window.fixtureBody = body; document.cookie = "authored-body=" + body; }, () => { window.fixtureBody = "caught"; });\r\n';
    const document = `<html><head><script>${source}</script></head><body><div id="fixture">authored</div></body></html>`;

    for (const mode of [
      "native-denied",
      "unset",
      "wrapper-denied",
      "permitted",
      "host-failed",
    ] as const) {
      effectIt(mode, () =>
        Effect.gen(function* () {
          let parentRejections = 0;
          const network = { allowed: 0, denied: 0 };
          const hostCalls = makeHostCallCounters();
          const hostReplies: Array<(typeof HostRepliesSchema.Type)[number]> =
            [];
          const seen: Array<unknown> = [];
          const cookieWrites: Array<string> = [];
          const body = "authored response unchanged";
          const host: BrowserScriptHost = {
            request(input) {
              seen.push([this, input]);
              return mode === "host-failed"
                ? Effect.fail(
                    new BrowserScriptError({ reason: "authored host failure" }),
                  )
                : Effect.succeed({
                    status: 200,
                    url: input.url,
                    headers: [],
                    body,
                    cookie: "",
                  });
            },
            setCookie: (value) =>
              Effect.sync(() => {
                cookieWrites.push(value);
                return "";
              }),
          };
          const options = {
            allowedOrigins: [localOrigin],
            ...(mode === "native-denied" || mode === "unset"
              ? { allowedRequestKinds: { [localOrigin]: [] } }
              : {}),
            ...(mode === "unset"
              ? {}
              : {
                  onNetworkRejected: Effect.sync(() => {
                    parentRejections++;
                  }),
                }),
          };
          const runtime = yield* Effect.service(BrowserMock).pipe(
            Effect.provide(
              BrowserMock.layer(options).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
          const wrapped = restrictRuntime(
            runtime,
            mode === "wrapper-denied" ? [] : [{ origin: localOrigin }],
            network,
            hostCalls,
            hostReplies,
          );
          const result = yield* runBoundedScript(
            wrapped,
            "",
            { url: pageUrl, cookie: "", userAgent: "fixture", document },
            host,
            "document",
          );
          expect(result).toEqual({ value: "", setCookies: [] });
          expect(inlineClassicPrograms(document)).toEqual([source]);
          expect(parentRejections).toBe(mode === "native-denied" ? 1 : 0);
          expect(network).toEqual(
            mode === "native-denied" || mode === "unset"
              ? { allowed: 0, denied: 0 }
              : mode === "wrapper-denied"
                ? { allowed: 0, denied: 1 }
                : { allowed: 1, denied: 0 },
          );
          expect(hostCalls.request).toBe(
            mode === "native-denied" || mode === "unset" ? 0 : 1,
          );
          expect(cookieWrites).toEqual(
            mode === "permitted" ? [`authored-body=${body}`] : [],
          );
          expect(hostCalls.setCookie).toBe(mode === "permitted" ? 1 : 0);
          expect(hostReplies).toHaveLength(mode === "permitted" ? 1 : 0);
          expect(seen).toHaveLength(
            mode === "permitted" || mode === "host-failed" ? 1 : 0,
          );
          if (seen.length > 0)
            expect(seen[0]).toEqual([
              host,
              { ...request(`${localOrigin}/fetch`), bodyBytes: null },
            ]);
        }),
      );
    }

    for (const [name, observer] of [
      [
        "failure",
        Effect.fail(
          new BrowserScriptError({ reason: "authored observer failure" }),
        ),
      ],
      ["defect", Effect.die("authored observer defect")],
      ["pending", Effect.never],
    ] as const) {
      effectIt(
        `observer ${name} cannot replace a caught request rejection`,
        () =>
          Effect.gen(function* () {
            let invocations = 0;
            const runtime = yield* Effect.service(BrowserMock).pipe(
              Effect.provide(
                BrowserMock.layer({
                  onNetworkRejected: Effect.sync(() => {
                    invocations++;
                  }).pipe(Effect.andThen(observer)),
                }).pipe(Layer.provide(NodeServices.layer)),
              ),
            );
            const result = yield* runBoundedScript(
              runtime,
              "",
              { url: pageUrl, cookie: "", userAgent: "fixture", document },
              {
                request: () =>
                  Effect.fail(
                    new BrowserScriptError({ reason: "must not delegate" }),
                  ),
                setCookie: () => Effect.succeed(""),
              },
              "document",
            );
            expect(result).toEqual({ value: "", setCookies: [] });
            expect(invocations).toBe(1);
          }),
      );
    }

    effectIt(
      "interruption during host execution is not a preflight rejection",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            let rejections = 0;
            const entered = yield* Deferred.make<void>();
            const runtime = yield* Effect.service(BrowserMock).pipe(
              Effect.provide(
                BrowserMock.layer({
                  allowedOrigins: [localOrigin],
                  onNetworkRejected: Effect.sync(() => {
                    rejections++;
                  }),
                }).pipe(Layer.provide(NodeServices.layer)),
              ),
            );
            const fiber = yield* runBoundedScript(
              runtime,
              "",
              { url: pageUrl, cookie: "", userAgent: "fixture", document },
              {
                request: () =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Effect.never),
                  ),
                setCookie: () => Effect.succeed(""),
              },
              "document",
            ).pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            expect(exit._tag).toBe("Failure");
            expect(rejections).toBe(0);
          }),
        ),
    );
  },
);

it("validates native observation counts separately, including unknown and saturation", () => {
  for (const value of [0, MAX_HOST_CALL_COUNT, "UNKNOWN"] as const)
    expect(Schema.decodeUnknownSync(NativePreflightRejections)(value)).toBe(
      value,
    );
  for (const value of [-1, 0.5, MAX_HOST_CALL_COUNT + 1, "0", null])
    expect(() =>
      Schema.decodeUnknownSync(NativePreflightRejections)(value),
    ).toThrow();
  expect(incrementCount(MAX_HOST_CALL_COUNT)).toBe(MAX_HOST_CALL_COUNT);
});

it("keeps the parent observer opt-in and Effect-valued", () => {
  const options = Schema.decodeSync(BrowserMockOptions)({});
  expect(Object.hasOwn(options, "onNetworkRejected")).toBe(false);
  const observer = Effect.void;
  expect(
    Schema.decodeSync(BrowserMockOptions)({ onNetworkRejected: observer })
      .onNetworkRejected,
  ).toBe(observer);
  for (const onNetworkRejected of [null, "observer", () => Effect.void])
    expect(() =>
      Schema.decodeUnknownSync(BrowserMockOptions)({ onNetworkRejected }),
    ).toThrow();
});

describe("initial challenge closed labels", () => {
  const html = (source: string) =>
    `<html><head><script>${source}</script></head><body></body></html>`;
  for (const [rt, responseType] of [
    ["c", "captcha"],
    ["i", "interstitial"],
    ["secret", "other"],
    ["missing", "other"],
  ] as const)
    for (const [t, blockType] of [
      ["fe", "fe"],
      ["bv", "bv"],
      ["secret", "other"],
    ] as const)
      it(`classifies DataDome ${responseType}/${blockType}`, () => {
        expect(
          classifyInitialChallenge(
            "datadome",
            html(`var dd={rt:'${rt}',t:'${t}',id:'private'};`),
          ),
        ).toEqual({
          datadomeResponseType: responseType,
          datadomeBlockType: blockType,
          cloudflareChallengeType: "missing",
        });
      });
  for (const cType of [
    "managed",
    "non-interactive",
    "interactive",
    "secret",
    "missing",
  ] as const)
    it(`classifies Cloudflare ${cType}`, () => {
      expect(
        classifyInitialChallenge(
          "cloudflare",
          html(`window._cf_chl_opt = {cType:"${cType}"};`),
        ),
      ).toEqual({
        datadomeResponseType: "missing",
        datadomeBlockType: "missing",
        cloudflareChallengeType:
          cType === "secret" || cType === "missing" ? "other" : cType,
      });
    });
  it("marks absent/non-target fields missing and ambiguous values other", () => {
    expect(
      classifyInitialChallenge("datadome", html("var dd={t:'bv'};"))
        .datadomeResponseType,
    ).toBe("missing");
    for (const source of [
      "var dd={rt:'c',rt:'c'};",
      "var dd={rt:'c',rt:'i'};",
      "var dd={rt:lookup()};",
      "var dd={rt:'c'}; var dd={rt:'i'};",
      "var dd={rt:'c' + 'i'};",
      "var dd={rt:'\\x63'};",
      "var dd={nested:{rt:'c'}};",
    ])
      expect(
        classifyInitialChallenge("datadome", html(source)).datadomeResponseType,
      ).toBe("other");
    expect(
      classifyInitialChallenge(
        "cloudflare",
        html("window._cf_chl_opt={cType:'managed',cType:'managed'};"),
      ).cloudflareChallengeType,
    ).toBe("other");
    for (const body of [
      "",
      "<script>var dd={rt:'c'}</script>",
      html("// var dd={rt:'c'};"),
    ])
      expect(
        classifyInitialChallenge("datadome", body).datadomeResponseType,
      ).not.toBe("captcha");
    expect(
      classifyInitialChallenge("cloudflare", html("var dd={rt:'c',t:'fe'};"))
        .datadomeResponseType,
    ).toBe("missing");
  });
});

it("refuses inert, duplicate and oversized initial configuration", () => {
  const page = (scripts: string) =>
    `<html><head>${scripts}</head><body></body></html>`;
  for (const body of [
    page(`<script type="module">var dd={rt:'c'};</script>`),
    page(`<script src="/private">var dd={rt:'c'};</script>`),
    page(`<!-- <script>var dd={rt:'c'};</script> -->`),
    page(`<script>var dd={rt:'c'};</script><script>dd={rt:'i'};</script>`),
    page(`<script>var dd={rt:'c',private:'${"x".repeat(8192)}'};</script>`),
  ])
    expect(
      classifyInitialChallenge("datadome", body).datadomeResponseType,
    ).not.toBe("captcha");
});

describe("frame origin closed labels", () => {
  for (const [url, label] of [
    ["https://captcha-delivery.com/private", "datadomeCaptchaDelivery"],
    ["https://geo.captcha-delivery.com/private", "datadomeCaptchaDelivery"],
    ["https://challenges.cloudflare.com/private", "cloudflareChallenges"],
    ["/private", "sameOrigin"],
    ["https://notcaptcha-delivery.com/private", "other"],
    ["https://challenges.cloudflare.com.evil.test/private", "other"],
    ["data:text/html,private", "other"],
    ["http://[::1", "unparsable"],
  ] as const)
    it(`classifies ${label} without retaining URL`, () => {
      expect(classifyFrameOrigin(url, `${origin}/page`)).toBe(label);
    });
  it("validates finite frame counts", () => {
    for (const value of [0, 256, "UNKNOWN"] as const)
      expect(Schema.decodeUnknownSync(FrameLoadRequests)(value)).toBe(value);
    for (const value of [-1, 0.5, 257, "0", null])
      expect(() =>
        Schema.decodeUnknownSync(FrameLoadRequests)(value),
      ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(FrameOriginCounts)({ sameOrigin: 257 }),
    ).toThrow();
  });
});

it("keeps frame observation opt-in and parent-only", () => {
  expect(
    Object.hasOwn(
      Schema.decodeSync(BrowserMockOptions)({}),
      "onFrameLoadRequested",
    ),
  ).toBe(false);
  const observer = (_url: string) => Effect.void;
  expect(
    Schema.decodeSync(BrowserMockOptions)({ onFrameLoadRequested: observer })
      .onFrameLoadRequested,
  ).toBe(observer);
  for (const onFrameLoadRequested of [null, "observer", Effect.void])
    expect(() =>
      Schema.decodeUnknownSync(BrowserMockOptions)({ onFrameLoadRequested }),
    ).toThrow();
});

describeNative("authored frame attempts stay denied", () => {
  for (const mode of [
    "origin-denied",
    "reviewer-absent",
    "failure",
    "defect",
    "pending",
  ] as const)
    effectIt(mode, () =>
      Effect.gen(function* () {
        let count = 0;
        const counts = {
          datadomeCaptchaDelivery: 0,
          cloudflareChallenges: 0,
          sameOrigin: 0,
          other: 0,
          unparsable: 0,
        };
        const runtime = yield* Effect.service(BrowserMock).pipe(
          Effect.provide(
            BrowserMock.layer({
              ...(mode === "origin-denied" ? {} : { allowedOrigins: [origin] }),
              onFrameLoadRequested: (url) =>
                Effect.sync(() => {
                  count = incrementCount(count);
                  const label = classifyFrameOrigin(url, `${origin}/page`);
                  counts[label] = incrementCount(counts[label]);
                }).pipe(
                  Effect.andThen(
                    mode === "failure"
                      ? Effect.fail(
                          new BrowserScriptError({ reason: "private" }),
                        )
                      : mode === "defect"
                        ? Effect.die("private")
                        : mode === "pending"
                          ? Effect.never
                          : Effect.void,
                  ),
                ),
            }).pipe(Layer.provide(NodeServices.layer)),
          ),
        );
        const source = `var frame = document.createElement('iframe'); frame.src='/private'; frame.onerror = function() { document.cookie='denied=yes'; }; document.body.appendChild(frame); if ('onFrameLoadRequested' in window) throw new Error('observer leaked');`;
        const writes: string[] = [];
        const network = { allowed: 0, denied: 0 };
        const hostCalls = makeHostCallCounters();
        const wrapped = restrictRuntime(
          runtime,
          [{ origin }],
          network,
          hostCalls,
        );
        const result = yield* runBoundedScript(
          wrapped,
          "",
          {
            url: `${origin}/page`,
            cookie: "",
            userAgent: "fixture",
            document: `<html><head></head><body><script>${source}</script></body></html>`,
          },
          {
            request: () =>
              Effect.fail(
                new BrowserScriptError({ reason: "must not delegate" }),
              ),
            setCookie: (value) =>
              Effect.sync(() => {
                writes.push(value);
                return "";
              }),
          },
          "document",
        ).pipe(Effect.result);
        expect(Result.isSuccess(result)).toBe(true);
        expect(count).toBe(1);
        expect(counts.sameOrigin).toBe(1);
        expect(writes).toEqual(["denied=yes"]);
        expect(network).toEqual({ allowed: 0, denied: 0 });
        expect(hostCalls.request).toBe(0);
      }),
    );
});
