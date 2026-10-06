import { describe, expect, it } from "bun:test";
import { Cause, Effect, Result, Schema } from "effect";
import {
  BrowserScriptError,
  type BrowserScriptHost,
  type BrowserScriptRuntime,
} from "../packages/effect-tls-client/src/browser/BrowserScript.js";
import {
  countHostCall,
  makeHostCallCounters,
  MAX_HOST_CALL_COUNT,
  restrictHost,
} from "./live-policy.js";
import {
  classifyEvaluation,
  didProviderCookieChange,
  encodeReceipt,
  FailureReason,
  inspectProtectedBody,
  isProven,
  HostCallCountersSchema,
  inlineClassicPrograms,
  incrementCount,
  readExportedCookies,
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
