import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Cookies from "effect/unstable/http/Cookies";
import type { TlsResponse, TlsSession } from "../src/TlsClient.js";
import {
  BrowserChallenge,
  Chrome152Identity,
  fromSession,
  recognizeAwsWafChallenge,
  recognizeChallenge,
  type BrowserChallengeContext,
  type BrowserHandlers,
} from "../src/browser/Browser.js";

const PAGE_URL = "https://example.test/";
const cfHeaders: TlsResponse["headers"] = [["cF-MiTiGaTeD", " \tchallenge\t "]];
const body = '<script>throw new Error("must not run")</script>';

const response = (
  headers: TlsResponse["headers"],
  status = 403,
  text = body,
  close: Effect.Effect<void> = Effect.void,
): TlsResponse => {
  const bytes = new TextEncoder().encode(text);
  return {
    status,
    url: PAGE_URL,
    headers,
    protocol: "HTTP/2.0",
    cookies: Cookies.empty,
    bytesRead: Effect.succeed(bytes.byteLength),
    bytesWritten: Effect.succeed(0),
    stream: Stream.succeed(bytes),
    bytes: Effect.succeed(bytes),
    text: Effect.succeed(text),
    json: Effect.succeed({}),
    close,
  };
};

const fakeSession = (
  result: TlsResponse,
  requests: Array<string>,
): TlsSession => ({
  id: "challenge-detection-test",
  request: (input) =>
    Effect.gen(function* () {
      requests.push(Predicate.isString(input) ? input : input.url);
      yield* Effect.addFinalizer(() => result.close);
      return result;
    }),
  webSocket: () => Effect.die("unused WebSocket"),
  cookies: () => Effect.die("unexpected cookie read"),
  setCookies: () => Effect.die("unexpected cookie write"),
  scriptCookies: () => Effect.die("unexpected script cookies"),
  exportCookies: Effect.die("unused cookie export"),
  importCookies: () => Effect.die("unused cookie import"),
  bandwidth: Effect.succeed({ read: 0, written: 0 }),
  resetBandwidth: Effect.void,
  setProxy: () => Effect.void,
});

const forbiddenRuntime: BrowserHandlers["scriptRuntime"] = {
  evaluate: () => Effect.die("unexpected script execution"),
};

describe("explicit challenge detection", () => {
  it.effect("decodes correlated Cloudflare kind and evidence", () =>
    Effect.gen(function* () {
      const value: BrowserChallenge = {
        kind: "Cloudflare",
        evidence: "cf-mitigated",
        status: 503,
        url: PAGE_URL,
        headers: cfHeaders,
      };
      const decoded: BrowserChallenge =
        yield* Schema.decodeEffect(BrowserChallenge)(value);
      expect(decoded).toEqual(value);
      expect(
        Schema.is(BrowserChallenge)({
          ...decoded,
          evidence: "x-amzn-waf-action",
        }),
      ).toBe(false);
      expect(Schema.is(BrowserChallenge)({ ...decoded, kind: "AwsWaf" })).toBe(
        false,
      );
    }),
  );

  it("recognizes mixed-case header names and trimmed values regardless of status", () => {
    for (const status of [200, 202, 302, 403, 503]) {
      const result = response(cfHeaders, status);
      expect(recognizeChallenge(result)).toEqual({
        kind: "Cloudflare",
        evidence: "cf-mitigated",
        status,
        url: PAGE_URL,
        headers: cfHeaders,
      });
      expect(recognizeAwsWafChallenge(result)).toBeUndefined();
    }
  });

  it("requires the exact documented Cloudflare marker value", () => {
    for (const value of [
      "",
      "managed",
      "Challenge",
      "challenge, challenge",
      "not-challenge",
    ]) {
      expect(
        recognizeChallenge(response([["cf-mitigated", value]])),
      ).toBeUndefined();
    }
  });

  it("preserves AWS WAF priority and normalization when both markers are present", () => {
    for (const headers of [
      [["X-AmZn-WaF-AcTiOn", " \tCHALLENGE \t"], ...cfHeaders],
      [...cfHeaders, ["X-AmZn-WaF-AcTiOn", " \tCHALLENGE \t"]],
    ] satisfies Array<TlsResponse["headers"]>) {
      const result = response(headers, 202);
      expect(recognizeChallenge(result)).toEqual(
        recognizeAwsWafChallenge(result),
      );
      expect(recognizeChallenge(result)?.kind).toBe("AwsWaf");
    }
  });

  it.effect(
    "does not infer a challenge from forbidden status, server, ray, or widget HTML",
    () =>
      Effect.gen(function* () {
        for (const headers of [
          [],
          [["server", "cloudflare"]],
          [["cf-ray", "fixture-ray"]],
          [["server", "CloudFront"]],
          [["x-amzn-waf-action", "captcha"]],
        ] satisfies Array<TlsResponse["headers"]>) {
          const html =
            '<div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>';
          const original = response(headers, 403, html);
          const requests: Array<string> = [];
          const page = yield* fromSession(
            fakeSession(original, requests),
            Chrome152Identity,
            {
              scriptRuntime: forbiddenRuntime,
              challengeHandler: () =>
                Effect.die("unexpected challenge dispatch"),
            },
          ).navigate(PAGE_URL);
          expect(page.challenge).toBeUndefined();
          expect(page.body).toBe(html);
          expect(page.response).toBe(original);
          expect(page.cloudFrontForbidden).toBe(
            headers[0]?.[1] === "CloudFront",
          );
          expect(requests).toEqual([PAGE_URL]);
        }
      }),
  );

  it.effect(
    "leaves a default Cloudflare challenge unresolved without execution or retry",
    () =>
      Effect.gen(function* () {
        for (const handlers of [{}, { scriptRuntime: forbiddenRuntime }]) {
          const requests: Array<string> = [];
          const original = response(cfHeaders, 503);
          const page = yield* fromSession(
            fakeSession(original, requests),
            Chrome152Identity,
            handlers,
          ).navigate(PAGE_URL);
          expect(page.challenge?.kind).toBe("Cloudflare");
          expect(page.status).toBe(503);
          expect(page.body).toBe(body);
          expect(page.response).toBe(original);
          expect(page.close).toBe(original.close);
          expect(requests).toEqual([PAGE_URL]);
        }
      }),
  );

  it.effect(
    "declining preserves the response and suppresses HTML and Location redirects",
    () =>
      Effect.gen(function* () {
        for (const status of [200, 302]) {
          const requests: Array<string> = [];
          const contexts: Array<BrowserChallengeContext> = [];
          let closes = 0;
          const original = response(
            [...cfHeaders, ["Location", "/not-requested"]],
            status,
            '<meta http-equiv="refresh" content="0;url=/not-requested">' + body,
            Effect.sync(() => {
              closes += 1;
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const page = yield* fromSession(
                fakeSession(original, requests),
                Chrome152Identity,
                {
                  scriptRuntime: forbiddenRuntime,
                  challengeHandler: (challenge, context) =>
                    Effect.sync(() => {
                      expect(challenge.kind).toBe("Cloudflare");
                      contexts.push(context);
                      return Option.none();
                    }),
                },
              ).navigate(PAGE_URL);
              expect(page.response).toBe(original);
              expect(page.headers).toBe(original.headers);
              expect(page.body).toBe(yield* original.text);
              expect(page.challenge?.evidence).toBe("cf-mitigated");
              expect(page.cloudFrontForbidden).toBe(false);
              expect(contexts).toHaveLength(1);
              expect(contexts[0]?.response).toBe(original);
              expect(contexts[0]?.body).toBe(page.body);
              expect(page.close).toBe(original.close);
              expect(closes).toBe(0);
              expect(requests).toEqual([PAGE_URL]);
            }),
          );
          expect(closes).toBe(1);
        }
      }),
  );
});
