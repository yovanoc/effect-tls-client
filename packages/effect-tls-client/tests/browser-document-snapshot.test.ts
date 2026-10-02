import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { BrowserMock, type BrowserScriptHost } from "../src/browser/index.js";

const context = {
  url: "http://localhost:43127/page",
  cookie: "",
  userAgent: "fixture",
};
const host: BrowserScriptHost = {
  request: () => Effect.die("snapshot initiated a request"),
  setCookie: () => Effect.die("snapshot wrote a cookie"),
  loadFrame: (url) =>
    Effect.succeed({
      parentUrl: context.url,
      url,
      origin: "http://localhost:43127",
      status: 200,
      headers: [],
      cookie: null,
      scripts: [
        "if (document.getElementById('seed') !== null || document.body.textContent !== undefined || typeof __documentSnapshot !== 'undefined') throw new Error('snapshot leaked');",
      ],
    }),
};

it.layer(
  BrowserMock.layer({
    allowedOrigins: ["http://localhost:43127"],
    timeoutMs: 4000,
  }).pipe(Layer.provide(NodeServices.layer)),
  { excludeTestServices: true },
)("explicit document fragment", (it) => {
  it.effect(
    "returns immutable actual records in document order with identity and inert raw text",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(
          `
      const node = document.getElementById('seed');
      if (node !== document.querySelector('DIV#seed.a.b') || node.textContent !== 'one&two' || node.tagName !== 'DIV' || node.className !== 'a b' || node.getAttribute('DATA-X') !== 'v' || !node.hasAttribute('data-x')) throw new Error('record');
      if (document.querySelector('#Seed') !== null || document.querySelector('.A') !== null || document.getElementById('missing') !== null) throw new Error('fabrication');
      if (document.body.textContent !== 'one&twothrow 1;body{}' || document.getElementsByTagName('script')[0] !== document.querySelector('#inert')) throw new Error('text/order');
      for (const action of [() => node.setAttribute('id','changed'), () => node.id = 'changed', () => node.textContent = '', () => node.attributes[0][1] = 'changed', () => document.body.appendChild(document.querySelector('#inert'))]) {
        let rejected = false; try { action(); } catch { rejected = true; } if (!rejected) throw new Error('mutation');
      }
      if (typeof __documentSnapshot !== 'undefined' || typeof __consumeBudget !== 'undefined') throw new Error('private helper');
      return 'ok';
    `,
          {
            ...context,
            html: '<div id="seed" class="a b" data-x="v">one&amp;<span>two</span></div><script id="inert" src="/never">throw 1;</script><style>body{}</style>',
          },
          host,
        );
        expect(result.value).toBe("ok");
      }),
  );
  it.effect("rejects unsupported selectors explicitly", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMock;
      const result = yield* runtime.evaluate(
        `
      for (const selector of ['div span', '*', '[id=x]', 'div,span', ':first-child', '', '#', '.a>b']) {
        let rejected = false; try { document.querySelector(selector); } catch (e) { rejected = e instanceof TypeError && e.message.includes('unsupported selector'); } if (!rejected) throw new Error(selector);
      } return 'ok';
    `,
        { ...context, html: "<div></div>" },
      );
      expect(result.value).toBe("ok");
    }),
  );
  it.effect(
    "charges snapshot nodes without refunds and isolates children",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(
          `
      const frame = document.createElement('iframe'); frame.src = '/child';
      await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = () => reject(new Error('frame failed')); document.body.appendChild(frame); });
      const script = document.createElement('script'); script.id = 'temporary'; script.removeAttribute('id');
      let rejected = false; try { document.createElement('script'); } catch (e) { rejected = e instanceof RangeError; } if (!rejected) throw new Error('quota refunded'); return 'ok';
    `,
          {
            ...context,
            html: '<div id="seed"></div>' + "<span></span>".repeat(29),
          },
          host,
        );
        expect(result.value).toBe("ok");
      }),
  );
  it.effect(
    "rejects complete documents, repair syntax, UTF-8 and serialized IPC overflow before spawning",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        for (const html of [
          "<!doctype html><html><body></body></html>",
          "<div>",
          "<div></div>".repeat(33),
          '<div title="' + "é".repeat(8192) + '"></div>',
          "<div>" + "é".repeat(65536) + "</div>",
          "<div><span>" + "x".repeat(50000) + "</span></div>",
        ]) {
          const result = yield* runtime
            .evaluate('return "never";', { ...context, html })
            .pipe(Effect.flip);
          expect(result.reason).toMatch(/snapshot|128 KiB/);
        }
      }),
  );
  it.effect(
    "shares cumulative UTF-8 attribute budgets with dynamic records",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(
          `
      const script = document.createElement('script');
      script.id = 'é'.repeat(4088); script.removeAttribute('id');
      let rejected = false; try { script.id = 'é'.repeat(4088); } catch (e) { rejected = e instanceof RangeError; }
      if (!rejected) throw new Error('attribute quota refunded'); return 'ok';
    `,
          { ...context, html: '<div title="' + "é".repeat(4096) + '"></div>' },
        );
        expect(result.value).toBe("ok");
      }),
  );
  it.effect(
    "preserves snapshot-before-dynamic ordering and ignores unattached nodes",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(
          `
      const detached = document.createElement('script'); detached.id = 'detached';
      const frame = document.createElement('iframe'); frame.id = 'same'; frame.src = '/child';
      await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = () => reject(new Error('frame failed')); document.body.appendChild(frame); });
      if (document.getElementById('same') !== document.querySelector('span#same') || document.querySelector('#detached') !== null || document.querySelector('iframe#same') !== frame) throw new Error('order'); return 'ok';
    `,
          { ...context, html: '<span id="same"></span>' },
          host,
        );
        expect(result.value).toBe("ok");
      }),
  );
});

it.effect(
  "rejects unsupported fragments and every startup quota with zero spawns",
  () =>
    Effect.gen(function* () {
      let spawns = 0;
      const layer = BrowserMock.layer().pipe(
        Layer.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
            spawn: () => {
              spawns += 1;
              return Effect.die("unexpected spawn");
            },
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        for (const html of [
          "<html></html>",
          "<p><div></div></p>",
          "<div></div>".repeat(33),
          '<div title="' + "é".repeat(8192) + '"></div>',
          "é".repeat(65537),
          "<div><span>" + "x".repeat(50000) + "</span></div>",
          "<span>" + "\u0001".repeat(23000) + "</span>",
        ]) {
          const error = yield* runtime
            .evaluate('return "never";', { ...context, html })
            .pipe(Effect.flip);
          expect(error.reason).toMatch(/snapshot|128 KiB/);
        }
      }).pipe(Effect.provide(layer));
      expect(spawns).toBe(0);
    }),
);
