import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import * as Cookies from "effect/unstable/http/Cookies";
import {
  TlsClient,
  type SessionConfig,
  type TlsResponse,
  type TlsSession,
} from "../src/TlsClient.js";
import {
  BrowserIdentity,
  BrowserSessionError,
  Chrome146Identity,
  Chrome152Identity,
  open,
} from "../src/browser/Browser.js";
import { BrowserScriptContext } from "../src/browser/BrowserScript.js";

const response: TlsResponse = {
  status: 202,
  url: "https://example.test/",
  headers: [["x-amzn-waf-action", "challenge"]],
  protocol: "HTTP/2.0",
  cookies: Cookies.empty,
  bytesRead: Effect.succeed(0),
  bytesWritten: Effect.succeed(0),
  stream: Stream.empty,
  bytes: Effect.succeed(new Uint8Array()),
  text: Effect.succeed(""),
  json: Effect.succeed({}),
  close: Effect.void,
};

const session: TlsSession = {
  id: "identity-test",
  request: () => Effect.succeed(response),
  webSocket: () => Effect.die("unused WebSocket"),
  cookies: () => Effect.succeed(Cookies.empty),
  setCookies: () => Effect.void,
  scriptCookies: () => Effect.succeed(""),
  exportCookies: Effect.succeed("[]"),
  importCookies: () => Effect.void,
  bandwidth: Effect.succeed({ read: 0, written: 0 }),
  resetBandwidth: Effect.void,
  setProxy: () => Effect.void,
};

const recordingClient = (configs: Array<SessionConfig>) =>
  Layer.mock(TlsClient, {
    session: (config) =>
      Effect.sync(() => {
        configs.push(config);
        return session;
      }),
  });

const configFailure = (input: unknown) =>
  Effect.gen(function* () {
    const configs: Array<SessionConfig> = [];
    const error = yield* open(input).pipe(
      Effect.provide(recordingClient(configs)),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(BrowserSessionError);
    if (Schema.is(BrowserSessionError)(error)) {
      expect(error.kind).toBe("Config");
    }
    expect(configs).toEqual([]);
  });

describe("browser profile identity", () => {
  for (const [profile, identity] of [
    ["chrome_146", Chrome146Identity],
    ["chrome_146_PSK", Chrome146Identity],
    ["chrome_152", Chrome152Identity],
    ["chrome_152_PSK", Chrome152Identity],
  ] as const) {
    it.effect(`derives ${profile} before transport acquisition`, () =>
      Effect.gen(function* () {
        const configs: Array<SessionConfig> = [];
        const browser = yield* open({
          transport: {
            profile,
            proxyUrl: "http://localhost:8080",
            forceHttp1: true,
          },
        }).pipe(Effect.provide(recordingClient(configs)));
        expect(browser.transport).toBe(session);
        expect(configs).toEqual([
          {
            profile,
            proxyUrl: "http://localhost:8080",
            forceHttp1: true,
            identity,
          },
        ]);
      }),
    );
    it.effect(
      `rejects a mismatched identity for ${profile} before acquisition`,
      () =>
        configFailure({
          transport: { profile },
          identity:
            identity === Chrome146Identity
              ? Chrome152Identity
              : Chrome146Identity,
        }),
    );
  }

  for (const transport of [
    { profile: "firefox_132" },
    { profile: "unknown_profile" },
    { customProfile: { ja3String: "771,4865,0,29,0" } },
  ]) {
    it.effect(
      `requires explicit identity for ${JSON.stringify(transport)}`,
      () => configFailure({ transport }),
    );
    it.effect(
      `preserves explicit identity for ${JSON.stringify(transport)}`,
      () =>
        Effect.gen(function* () {
          const configs: Array<SessionConfig> = [];
          const identity = BrowserIdentity.make({
            headers: [
              ["user-agent", "application/1"],
              ["accept-language", "de-DE,de;q=0.8"],
            ],
          });
          yield* open({ transport, identity }).pipe(
            Effect.provide(recordingClient(configs)),
          );
          expect(configs).toEqual([{ ...transport, identity }]);
        }),
    );
  }

  it.effect("allows custom headers with a matching major", () =>
    Effect.gen(function* () {
      const configs: Array<SessionConfig> = [];
      const identity = BrowserIdentity.make({
        headers: [
          ["User-Agent", "Mozilla/5.0 Chrome/152.1.2.3 Safari/537.36"],
          ["Accept-Language", "de-DE,de;q=0.9"],
          ["x-device", "custom"],
        ],
        headerOrder: ["user-agent", "accept-language", "x-device"],
      });
      yield* open({ transport: { profile: "chrome_152" }, identity }).pipe(
        Effect.provide(recordingClient(configs)),
      );
      expect(configs[0]?.identity).toEqual(identity);
    }),
  );

  it.effect("requires Chrome UA for an explicit known-profile identity", () =>
    configFailure({
      transport: { profile: "chrome_152" },
      identity: { headers: [["user-agent", "Firefox/152.0"]] },
    }),
  );
  it.effect("retains custom-profile Schema validation", () =>
    configFailure({
      transport: { customProfile: { h2Settings: { UNKNOWN_SETTING: 1 } } },
      identity: Chrome152Identity,
    }),
  );
  it.effect("rejects Cookie identity headers before acquisition", () =>
    Effect.gen(function* () {
      const configs: Array<SessionConfig> = [];
      const error = yield* open({
        transport: { profile: "chrome_152" },
        identity: {
          headers: [
            ...Chrome152Identity.headers,
            ["Cookie", "session=private"],
          ],
        },
      }).pipe(Effect.provide(recordingClient(configs)), Effect.flip);
      expect(error).toBeInstanceOf(BrowserSessionError);
      if (Schema.is(BrowserSessionError)(error)) {
        expect(error.kind).toBe("CookieHeader");
      }
      expect(configs).toEqual([]);
    }),
  );

  for (const [acceptLanguage, languages] of [
    ["fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7", ["fr-FR", "fr", "en-US", "en"]],
    [
      "en;q=0.5,de-DE;q=1,fr;q=0,*;q=0.9,DE-de;q=0.8,invalid_1;q=1",
      ["de-DE", "en"],
    ],
    ["en;bogus=1,fr;0.9,de;q=1.1,es;q=0.001,it;q=0.000", ["es"]],
    ["*;q=1,en;q=0", []],
    ["", []],
    [
      Array.from({ length: 20 }, (_, index) => `en-x${index}`).join(","),
      Array.from({ length: 16 }, (_, index) => `en-x${index}`),
    ],
  ] as const) {
    it.effect(`passes declared language preferences ${acceptLanguage}`, () =>
      Effect.gen(function* () {
        const configs: Array<SessionConfig> = [];
        const identity = BrowserIdentity.make({
          headers: [
            ...Chrome152Identity.headers.filter(
              ([name]) => name !== "accept-language",
            ),
            ["Accept-Language", acceptLanguage],
          ],
        });
        const contexts: Array<BrowserScriptContext | undefined> = [];
        const browser = yield* open(
          { transport: { profile: "chrome_152" }, identity },
          {
            scriptRuntime: {
              evaluate: (_source, context) =>
                Effect.sync(() => {
                  contexts.push(context);
                  return { value: "ok", setCookies: [] };
                }),
            },
            challengeHandler: (_challenge, context) =>
              context
                .evaluate("return navigator.language")
                .pipe(Effect.as(Option.none())),
          },
        ).pipe(Effect.provide(recordingClient(configs)));
        yield* browser.navigate(response.url);
        expect(contexts).toHaveLength(1);
        expect(contexts[0]?.languages).toEqual(languages);
        expect(contexts[0]?.userAgent).toEqual(identity.headers[0]?.[1]);
      }),
    );
  }

  it.effect("bounds language sequences at the shared context boundary", () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeEffect(BrowserScriptContext)({
        url: "about:blank",
        cookie: "",
        userAgent: "",
        languages: Array.from({ length: 17 }, () => "en"),
      }).pipe(Effect.flip);
      expect(error).toBeDefined();
    }),
  );
});
