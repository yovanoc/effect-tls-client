import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import * as Cookies from "effect/unstable/http/Cookies";
import type { TlsResponse, TlsSession } from "../src/TlsClient.js";
import {
  BrowserMock,
  BrowserScriptError,
  Chrome152Identity,
  fromSession,
  type BrowserFrameReviewer,
  type BrowserScriptHost,
} from "../src/browser/index.js";

const parseOutcome = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      outcome: Schema.String,
      marker: Schema.String,
      opaque: Schema.Boolean,
      noRealm: Schema.Boolean,
    }),
  ),
);

const origin = "http://localhost:43127";
const other = "http://127.0.0.1:43128";
const root = origin + "/private?nonce=fixture";
const append = (url = "/frame") => `
  globalThis.rootMarker = 'parent'; Object.prototype.rootPrototypeMarker = true;
  const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(url)};
  const outcome = await new Promise(resolve => {
    frame.onload = () => resolve('load'); frame.onerror = () => resolve('error');
    document.body.appendChild(frame);
  });
  return JSON.stringify({ outcome, marker: rootMarker, opaque: frame.contentWindow === null || (frame.contentWindow.document === undefined && frame.contentWindow.rootMarker === undefined), noRealm: frame.contentWindow === null });
`;
const host = (
  scripts: ReadonlyArray<string>,
  cookie: string | null = null,
): BrowserScriptHost => ({
  request: () => Effect.die("unexpected parent network request"),
  setCookie: () => Effect.die("unexpected cookie write"),
  loadFrame: (url) =>
    Effect.succeed({
      parentUrl: root,
      url,
      origin: url.startsWith(other + "/") ? other : origin,
      status: 200,
      headers: [],
      scripts,
      cookie,
    }),
});
const context = {
  url: root,
  cookie: "parent=private",
  userAgent: "fixture-UA",
  languages: ["fr-FR", "en"],
};
const response = (url: string): TlsResponse => {
  const body =
    url === root
      ? "synthetic parent fixture"
      : "<script>throw new Error('unselected HTML executed')</script>";
  const bytes = new TextEncoder().encode(body);
  return {
    status: url === root ? 202 : 200,
    url,
    headers: url === root ? [["x-amzn-waf-action", "challenge"]] : [],
    protocol: "HTTP/1.1",
    cookies: Cookies.empty,
    bytesRead: Effect.succeed(bytes.length),
    bytesWritten: Effect.succeed(0),
    stream: Stream.succeed(bytes),
    bytes: Effect.succeed(bytes),
    text: Effect.succeed(body),
    json: Effect.succeed({}),
    close: Effect.void,
  };
};
const fixture = (calls: string[]): TlsSession => ({
  id: "same-profile-frame-fixture",
  request: (url) =>
    Effect.sync(() => {
      const value = typeof url === "string" ? url : url.url;
      calls.push(value);
      return response(value);
    }),
  scriptCookies: () => Effect.succeed("granted=fixture"),
  webSocket: () => Effect.die("unused"),
  cookies: () => Effect.succeed(Cookies.empty),
  setCookies: () => Effect.die("unused"),
  exportCookies: Effect.die("unused"),
  importCookies: () => Effect.die("unused"),
  bandwidth: Effect.succeed({ read: 0, written: 0 }),
  resetBandwidth: Effect.void,
  setProxy: () => Effect.die("unused"),
});

it.layer(
  BrowserMock.layer({ allowedOrigins: [origin, other], timeoutMs: 5000 }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  { excludeTestServices: true },
)("isolated frame LOAD runtime", (it) => {
  it.effect("honors a configured timeout beyond the default two seconds", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(
        "await new Promise(resolve => setTimeout(resolve, 2300));" + append(),
        context,
        host(["new Promise(resolve => setTimeout(resolve, 100))"]),
      );
      expect(parseOutcome(result.value).outcome).toBe("load");
    }),
  );
  it.effect(
    "separates globals/intrinsics, freezes identity, and grants only a read-only snapshot",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const scripts = [
          `
      if (typeof rootMarker !== 'undefined' || ({}).rootPrototypeMarker) throw new Error('parent alias');
      globalThis.rootMarker = 'child'; Object.prototype.childMarker = true;
      if (document.cookie !== 'granted=fixture' || navigator.userAgent !== 'fixture-UA' || navigator.language !== 'fr-FR') throw new Error('identity');
      if (!Object.isFrozen(location) || !Object.isFrozen(navigator) || location.href !== '${origin}/frame') throw new Error('location');
      if (parent === globalThis || parent.document || top.document || typeof process !== 'undefined' || typeof __childRealm !== 'undefined' || typeof __consumeBudget !== 'undefined' || typeof __receive !== 'undefined') throw new Error('authority leak');
      const blocked = (fn) => { try { fn(); return false; } catch (e) { return e instanceof Error; } };
      if (!blocked(() => document.cookie = 'elevated=1') || !blocked(() => parent.postMessage({sdk:'fake'}, '*')) || !blocked(() => postMessage('fake', '*'))) throw new Error('unsupported messaging');
      if (!blocked(() => parent.postMessage.constructor('return process')()) || !blocked(() => document.createElement.constructor('return process')())) throw new Error('host constructor');
      if (document.referrer !== '${root}') throw new Error('referrer');
    `,
        ];
        expect(
          parseOutcome(
            (yield* runtime.evaluate(
              append(),
              context,
              host(scripts, "granted=fixture"),
            )).value,
          ),
        ).toEqual({
          outcome: "load",
          marker: "parent",
          opaque: true,
          noRealm: false,
        });
      }),
  );
  it.effect(
    "hides private callbacks and prevents cookie-sync forgery in both realms",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const check = `
        const before = document.cookie;
        let rejected = false;
        try { __receive(JSON.stringify({type:'cookie.sync',cookie:'frame=forged',version:1,applied:true})); }
        catch (error) { if (!(error instanceof ReferenceError)) throw error; rejected = true; }
        if (typeof __receive !== 'undefined' || !rejected || document.cookie !== before) throw new Error('cookie-sync forgery');
        for (const key of ['__receive','__cookieSnapshot','__cookieFlush','__safeMessage','__post','__childRealm','__consumeBudget','__urlOperation','__pageUrl','__pageLocation','__referrer','__cookie','__userAgent','__languages','__authoritativeCookies','__performanceNow','__performanceTimeOrigin','__randomBytes','__cryptoOperation','__encodeBlobText','__decodeBlobText']) {
          if (typeof globalThis[key] !== 'undefined' || key in globalThis) throw new Error('private binding visible: ' + key);
        }
      `;
        const result = yield* runtime.evaluate(
          check + append(),
          context,
          host([check], "granted=fixture"),
        );
        expect(parseOutcome(result.value)).toEqual({
          outcome: "load",
          marker: "parent",
          opaque: true,
          noRealm: false,
        });
        expect(result.setCookies).toEqual([]);
      }),
  );
  it.effect(
    "cross-origin child has no cookies, private referrer, DOM alias, or network authority",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const scripts = [
          `(async () => {
      if (document.cookie !== '' || document.referrer !== '${origin}/' || location.origin !== '${other}') throw new Error('privacy');
      for (const operation of [() => fetch('/private'), () => document.loadScript('/code'), () => { const x = new XMLHttpRequest(); x.open('GET', '/private'); x.send(); }]) {
        let rejected = false; try { await operation(); } catch (e) { rejected = e instanceof TypeError; } if (!rejected) throw new Error('network not rejected');
      }
    })()`,
        ];
        expect(
          parseOutcome(
            (yield* runtime.evaluate(
              append(other + "/frame"),
              context,
              host(scripts),
            )).value,
          ).outcome,
        ).toBe("load");
      }),
  );
  for (const [name, reviewer] of [
    ["absent reviewer", undefined],
    ["unreviewed", () => Effect.succeedNone],
    ["empty selection", () => Effect.succeedSome({ scripts: [] })],
    [
      "granted projection",
      () =>
        Effect.succeedSome({
          scripts: [
            "if(document.cookie !== 'granted=fixture') throw new Error('cookie');",
          ],
          cookiePolicy: "same-origin",
        }),
    ],
  ] satisfies ReadonlyArray<
    readonly [string, BrowserFrameReviewer | undefined]
  >) {
    it.effect(
      name + " uses the production host on the same mock Go session",
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const calls: string[] = [];
          let value = "";
          const browser = fromSession(fixture(calls), Chrome152Identity, {
            scriptRuntime: runtime,
            ...(reviewer === undefined ? {} : { frameReviewer: reviewer }),
            challengeHandler: (_challenge, ctx) =>
              ctx.evaluate(append()).pipe(
                Effect.tap((output) =>
                  Effect.sync(() => {
                    value = output;
                  }),
                ),
                Effect.as(Option.none()),
              ),
          });
          const page = yield* browser.navigate(root);
          yield* page.close;
          const result = parseOutcome(value);
          const denied = name === "absent reviewer" || name === "unreviewed";
          expect(result.outcome).toBe(denied ? "error" : "load");
          expect(result.noRealm).toBe(denied);
          expect(calls).toEqual(
            name === "absent reviewer" ? [root] : [root, origin + "/frame"],
          );
        }).pipe(Effect.scoped),
    );
  }
  it.effect(
    "selected source errors are evaluation failures, not load success",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* Effect.result(
          runtime.evaluate(
            append(),
            context,
            host(["throw new Error('selected fixture failed')"]),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.reason).toContain("selected fixture failed");
      }),
  );
  it.effect(
    "fetch failure and blocked origin do not create a child realm",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const failed: BrowserScriptHost = {
          ...host([]),
          loadFrame: () =>
            Effect.fail(
              new BrowserScriptError({ reason: "fixture fetch failed" }),
            ),
        };
        for (const [source, capability] of [
          [append(), failed],
          [
            append("http://blocked.test/frame"),
            host(["throw new Error('must not execute')"]),
          ],
        ] as const) {
          expect(
            parseOutcome(
              (yield* runtime.evaluate(source, context, capability)).value,
            ).noRealm,
          ).toBe(true);
        }
      }),
  );
  it.effect("rejects unsupported frame inputs and caps frames/nodes", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime
        .evaluate(
          `
      let count = 0;
      const f = document.createElement('iframe'); for (const src of ['about:blank','blob:test','data:text/html,test','javascript:1','http://user:pass@localhost/x']) { try { f.src = src; } catch(e) { count++; } }
      return count;
    `,
          context,
          host([]),
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") expect(result.success.value).toBe("5");
      const limit = yield* Effect.result(
        runtime.evaluate(
          "for(let i=0;i<5;i++)document.createElement('iframe');",
          context,
          host([]),
        ),
      );
      expect(limit._tag).toBe("Failure");
      const unsupported = yield* runtime.evaluate(
        `const f=document.createElement('iframe'); let count=0; for(const key of ['srcdoc','sandbox','credentialless','crossOrigin','referrerPolicy']) {try {f[key]='x'} catch(e){count++}} return count;`,
        context,
        host([]),
      );
      expect(unsupported.value).toBe("5");
    }),
  );
  it.effect("shares active timer and script-node ceilings across realms", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      for (const [setup, script, reason] of [
        [
          "for(let i=0;i<64;i++)setTimeout(()=>{},120000);",
          "setTimeout(()=>{},120000);",
          "timer budget",
        ],
        [
          "for(let i=0;i<31;i++)document.createElement('script');",
          "document.createElement('script');",
          "element budget",
        ],
      ] as const) {
        const result = yield* Effect.result(
          runtime.evaluate(setup + append(), context, host([script])),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.reason).toContain(reason);
      }
    }),
  );
  it.effect(
    "shares native crypto calls rather than minting a fresh allowance",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const importKey = `crypto.subtle.importKey('raw', new Uint8Array(16), {name:'AES-GCM'}, false, ['encrypt'])`;
        const setup = `const key=await ${importKey}; for(let i=0;i<63;i++) await crypto.subtle.encrypt({name:'AES-GCM',iv:new Uint8Array(12)},key,new Uint8Array(1));`;
        const result = yield* Effect.result(
          runtime.evaluate(
            setup + append(),
            context,
            host([`(async()=>{await ${importKey}})()`]),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.reason).toContain("crypto operation budget");
      }),
  );
  it.effect("aggregates timer fires across parent and child", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* Effect.result(
        runtime.evaluate(
          "for(let i=0;i<256;i++)await new Promise(resolve=>setTimeout(resolve,0));" +
            append(),
          context,
          host(["new Promise(resolve=>setTimeout(resolve,0))"]),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.reason).toContain("256 fires");
    }),
  );
  it.effect(
    "rejects cross-origin cookie elevation and cumulative selected-source growth",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        expect(
          parseOutcome(
            (yield* runtime.evaluate(
              append(other + "/frame"),
              context,
              host([], "elevated=1"),
            )).value,
          ).noRealm,
        ).toBe(true);
        const source = "/*" + "x".repeat(33000) + "*/";
        const result = yield* runtime.evaluate(
          source + append(),
          context,
          host([source]),
        );
        expect(parseOutcome(result.value).noRealm).toBe(true);
      }),
  );
});

it.layer(
  BrowserMock.layer({ allowedOrigins: [origin], timeoutMs: 1000 }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  { excludeTestServices: true },
)("shared short evaluation deadline", (it) => {
  it.effect(
    "terminates runaway child work within the root deadline and can evaluate again",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const started = Date.now();
        const result = yield* Effect.result(
          runtime.evaluate(append(), context, host(["while(true){}"])),
        );
        expect(result._tag).toBe("Failure");
        expect(Date.now() - started).toBeLessThan(4500);
        expect(
          (yield* runtime.evaluate("return 'clean';", context)).value,
        ).toBe("clean");
      }),
  );
  it.effect(
    "parent and child waits cannot restart the configured deadline",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* Effect.result(
          runtime.evaluate(
            "await new Promise(resolve => setTimeout(resolve, 650));" +
              append(),
            context,
            host(["new Promise(resolve => setTimeout(resolve, 650))"]),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.reason).toContain("timed out");
      }),
  );
});
