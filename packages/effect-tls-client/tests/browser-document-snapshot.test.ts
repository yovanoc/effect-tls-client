import { vi } from "vitest";
import * as HtmlSnapshot from "../src/browser/HtmlSnapshot.js";
import { spawnSync } from "node:child_process";
import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeBrowserScriptRunnerSource } from "../src/browser/BrowserScriptRunner.js";
import {
  BrowserMock,
  BrowserScriptError,
  type BrowserScriptHost,
} from "../src/browser/index.js";
import { runBoundedScript } from "../src/browser/BrowserScript.js";

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
        for (const [html, failure] of [
          ["<html></html>", "UnsupportedInput"],
          ["<p><div></div></p>", "UnsupportedInput"],
          ["<div></div>".repeat(33), "SnapshotLimitExceeded"],
          [
            '<div title="' + "é".repeat(8192) + '"></div>',
            "SnapshotLimitExceeded",
          ],
          ["é".repeat(65537), "SnapshotLimitExceeded"],
          [
            "<div><span>" + "x".repeat(50000) + "</span></div>",
            "StartupLimitExceeded",
          ],
          [
            "<span>" + "\u0001".repeat(23000) + "</span>",
            "StartupLimitExceeded",
          ],
        ] satisfies ReadonlyArray<readonly [string, string]>) {
          const error = yield* runtime
            .evaluate('return "never";', { ...context, html })
            .pipe(Effect.flip);
          expect(error.reason).toMatch(/snapshot|128 KiB/);
          expect(error.documentInputFailure).toBe(failure);
          expect(Object.hasOwn(error, "documentInputRule")).toBe(false);
        }
      }).pipe(Effect.provide(layer));
      expect(spawns).toBe(0);
    }),
);

const wholeDocument =
  '<!doctype html><html lang="en" id="root"><head id="top" class="metadata"><meta name="fixture" content="yes"><style id="css">body{}</style><script id="inert" src="/never">throw 1;</script><title>Fixture</title></head><body id="page" class="main"><div id="seed" class="a b">one<span>two</span></div> </body></html>';

it.layer(
  BrowserMock.layer({
    allowedOrigins: ["http://localhost:43127"],
    timeoutMs: 4000,
  }).pipe(Layer.provide(NodeServices.layer)),
  { excludeTestServices: true },
)("explicit complete document", (it) => {
  it.effect(
    "includes structural roots in the shared nonrefundable node quota",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(
          `
      const node = document.createElement('div'); node.id = 'new'; document.body.appendChild(node);
      node.textContent = 'é'.repeat(8189);
      let dataRejected = false; try { node.textContent = 'xx'; } catch(e) { dataRejected = e instanceof RangeError; }
      if (!dataRejected) throw new Error('DOM data budget');
      let rejected = false; try { document.createElement('script'); } catch(e) { rejected = e instanceof RangeError; }
      if (!rejected) throw new Error('structural nodes not charged'); return 'ok';
    `,
          {
            ...context,
            document:
              "<!doctype html><html><head></head><body>" +
              "<span></span>".repeat(28) +
              "</body></html>",
          },
        );
        expect(result.value).toBe("ok");
      }),
  );
  it.effect(
    "materializes actual readonly roots, inert descendants and bounded append targets",
    () =>
      Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const result = yield* runtime.evaluate(
          `
      const root = document.documentElement, head = document.head, body = document.body;
      if (root !== document.querySelector('html#root') || root !== document.getElementsByTagName('html')[0] || root.getAttribute('LANG') !== 'en') throw new Error('root');
      if (head !== document.getElementById('top') || head !== document.querySelector('head.metadata') || head !== document.getElementsByTagName('head')[0]) throw new Error('head');
      if (body !== document.getElementById('page') || body !== document.querySelector('body.main') || body !== document.getElementsByTagName('body')[0]) throw new Error('body');
      if (body.textContent !== 'onetwo ' || root.textContent !== 'body{}throw 1;Fixtureonetwo ' || document.querySelector('title').textContent !== 'Fixture') throw new Error('text');
      const addedHead = document.createElement('span'); addedHead.id = 'headAppend'; head.appendChild(addedHead);
      addedHead.className = 'main';
      if (document.querySelector('.main') !== addedHead) throw new Error('head append must precede body');
      const addedBody = document.createElement('div'); addedBody.id = 'bodyAppend'; body.appendChild(addedBody);
      if (document.querySelector('#seed').parentNode !== body || body.parentNode !== root || head.parentNode !== root || addedBody.parentNode !== body || addedHead.parentNode !== head) throw new Error('parent');
      if ([...document.getElementsByTagName('div')].map(n => n.id).join(',') !== 'seed,bodyAppend' || [...document.getElementsByTagName('span')].map(n => n.id).join(',') !== 'headAppend,') throw new Error('order');
      for (const node of [root, head, body, document.querySelector('#inert')]) {
        for (const action of [() => node.id = 'changed', () => node.className = '', () => node.textContent = '', () => node.setAttribute('x','v'), () => node.attributes[0][1] = 'changed', () => node.innerHTML = '', () => body.appendChild(node)]) {
          let rejected = false; try { action(); } catch { rejected = true; } if (!rejected) throw new Error('mutation');
        }
      }
      if (typeof __documentRoot !== 'undefined' || typeof __documentSnapshot !== 'undefined') throw new Error('private binding');
      const frame = document.createElement('iframe'); frame.src = '/child';
      await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = () => reject(new Error('child')); body.appendChild(frame); });
      return 'ok';
    `,
          { ...context, document: wholeDocument },
          {
            ...host,
            loadFrame: (url) =>
              Effect.succeed({
                parentUrl: context.url,
                url,
                origin: "http://localhost:43127",
                status: 200,
                headers: [],
                cookie: null,
                scripts: [
                  "if (document.documentElement !== undefined || document.getElementById('root') !== null || document.body.textContent !== undefined || typeof __documentRoot !== 'undefined') throw new Error('root leaked');",
                ],
              }),
          },
        );
        expect(result.value).toBe("ok");
        expect(result.setCookies).toEqual([]);
      }),
  );
});

it.effect(
  "rejects strict document failures and serialized overflow before any spawn",
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
        const wrap = (body: string) =>
          "<!doctype html><html><head></head><body>" + body + "</body></html>";
        for (const [document, reason, failure] of [
          [
            "<html><head></head><body></body></html>",
            "unsupported HTML document",
            "UnsupportedInput",
          ],
          [wrap("<div>"), "unsupported HTML document", "UnsupportedInput"],
          [
            wrap("<div></div>".repeat(30)),
            "HTML document exceeds elements limit",
            "SnapshotLimitExceeded",
          ],
          [
            wrap('<div title="' + "x".repeat(8193) + '"></div>'),
            "HTML document exceeds attributeValueCharacters limit",
            "SnapshotLimitExceeded",
          ],
          [
            wrap('<div title="' + "é".repeat(8192) + '"></div>'),
            "HTML document exceeds attributesUtf8Bytes limit",
            "SnapshotLimitExceeded",
          ],
          [
            wrap("é".repeat(65536)),
            "HTML document exceeds inputBytes limit",
            "SnapshotLimitExceeded",
          ],
          [
            wrap("<div><span>" + "x".repeat(40000) + "</span></div>"),
            "script IPC start input exceeds its 128 KiB limit",
            "StartupLimitExceeded",
          ],
          [
            wrap("\u0001".repeat(12000)),
            "script IPC start input exceeds its 128 KiB limit",
            "StartupLimitExceeded",
          ],
        ] satisfies ReadonlyArray<readonly [string, string, string]>) {
          const error = yield* runBoundedScript(runtime, 'return "never";', {
            ...context,
            document,
          }).pipe(Effect.flip);
          expect(error.reason).toBe(reason);
          expect(error).toBeInstanceOf(BrowserScriptError);
          expect(error._tag).toBe("BrowserScriptError");
          expect(error.documentInputFailure).toBe(failure);
          if (failure !== "UnsupportedInput")
            expect(Object.hasOwn(error, "documentInputRule")).toBe(false);
        }
        const conflict = yield* runtime
          .evaluate('return "never";', {
            ...context,
            document: wholeDocument,
            html: "<div></div>",
          })
          .pipe(Effect.flip);
        expect(conflict.reason).toBe("unsupported HTML document");
        expect(conflict.documentInputFailure).toBe("ConflictingInputs");
        expect(Object.hasOwn(conflict, "documentInputRule")).toBe(false);
        const invalid = yield* runtime
          .evaluate('return "never";', {
            ...context,
            languages: Array.from({ length: 17 }, () => "en"),
          })
          .pipe(Effect.flip);
        expect(invalid.reason).toBe("invalid browser script context");
        expect(invalid.documentInputFailure).toBe("InvalidContext");
        expect(invalid.cause).toBeDefined();
        expect(Object.hasOwn(invalid, "documentInputRule")).toBe(false);
        const startup = yield* runtime
          .evaluate('return "never";', {
            ...context,
            userAgent: "x".repeat(131073),
          })
          .pipe(Effect.flip);
        expect(startup.reason).toBe(
          "script IPC start input exceeds its 128 KiB limit",
        );
        expect(startup.documentInputFailure).toBe("StartupLimitExceeded");
        expect(Object.hasOwn(startup, "documentInputRule")).toBe(false);
      }).pipe(Effect.provide(layer));
      expect(spawns).toBe(0);
    }),
);

it("rejects forged root structures on the runner IPC boundary before guest execution", () => {
  const runner = makeBrowserScriptRunnerSource({
    maxTimeoutMs: 120000,
    maxInputLineBytes: 8388608,
    maxControlInputLineBytes: 131072,
    maxOutputLineBytes: 131072,
    maxOutputBytes: 1048576,
    maxCookieBytes: 65536,
    maxCookieWrites: 64,
    maxNetworkRequests: 8,
    maxRequestBodyBytes: 16384,
    maxTotalNetworkBytes: 1048576,
    maxHeaders: 128,
    maxHeaderBytes: 65536,
    maxTimers: 64,
    maxTimerDelayMs: 120000,
  });
  const node = (tag: string, parent: number) => ({
    tag,
    parent,
    attributes: [],
    textContent: "",
  });
  const forgedNodes = [
    [],
    [node("html", -1), node("body", 0), node("head", 0)],
    [node("html", -1), node("head", 0), node("body", -1)],
    [node("html", -1), node("head", 0), node("body", 1)],
    [node("html", -1), node("head", 0), node("div", 1), node("body", 0)],
    [node("html", -1), node("head", 0), node("body", 0), node("head", 2)],
    [node("html", -1), node("head", 0), node("body", 0), node("span", 1)],
    [node("html", -1), node("head", 0), node("body", 0), node("iframe", 2)],
    [
      node("html", -1),
      node("head", 0),
      node("body", 0),
      node("script", 2),
      node("span", 3),
    ],
    [
      node("html", -1),
      node("head", 0),
      node("body", 0),
      node("div", 2),
      node("span", 2),
      node("b", 3),
    ],
  ];
  for (const documentRoot of [
    null,
    ...forgedNodes.map((nodes) => ({ nodes, textContent: "" })),
  ]) {
    const result = spawnSync(process.execPath, ["--permission", "-e", runner], {
      input:
        JSON.stringify({
          type: "start",
          timeoutMs: 1000,
          source: 'return "GUEST_EXECUTED";',
          ...context,
          documentRoot,
        }) + "\n",
      encoding: "utf8",
      timeout: 4000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toMatch(/invalid document (root structure|snapshot)/);
    expect(result.stdout).not.toContain("GUEST_EXECUTED");
  }
});

it.layer(
  BrowserMock.layer({ timeoutMs: 4000 }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  { excludeTestServices: true },
)("document failure provenance across process IPC", (it) => {
  for (const documentInputRule of [
    "Doctype",
    "SnapshotRecordInvariant",
    "guest-chosen",
  ]) {
    for (const [reason, documentInputFailure] of [
      ["invalid browser script context", "InvalidContext"],
      ["unsupported HTML document", "ConflictingInputs"],
      ["unsupported HTML body-fragment snapshot", "UnsupportedInput"],
      ["HTML document exceeds elements limit", "SnapshotLimitExceeded"],
      [
        "script IPC start input exceeds its 128 KiB limit",
        "StartupLimitExceeded",
      ],
    ]) {
      const properties = JSON.stringify({
        message: reason,
        reason,
        _tag: "BrowserScriptError",
        documentInputFailure,
        documentInputRule,
      });
      for (const [guestThrow, source] of [
        ["nativeError", `throw new Error(${JSON.stringify(reason)});`],
        [
          "errorWithSpoofData",
          `throw Object.assign(new Error(${JSON.stringify(reason)}), ${properties});`,
        ],
        ["plainObject", `throw ${properties};`],
      ]) {
        for (const mode of ["async", "classic"] as const) {
          it.effect(
            `does not confer host labels: ${documentInputRule}/${documentInputFailure}/${guestThrow}/${mode}`,
            () =>
              Effect.gen(function* () {
                const runtime = yield* BrowserMock;
                const error = yield* runBoundedScript(
                  runtime,
                  source,
                  context,
                  undefined,
                  mode,
                ).pipe(Effect.flip);
                expect(error).toBeInstanceOf(BrowserScriptError);
                expect(error._tag).toBe("BrowserScriptError");
                expect(error.reason).toBe(reason);
                expect(Object.hasOwn(error, "documentInputFailure")).toBe(
                  false,
                );
                expect(Object.hasOwn(error, "documentInputRule")).toBe(false);
              }),
          );
        }
      }
    }
  }
});

it.effect(
  "retains the error schema and omitted-field construction contract",
  () =>
    Effect.gen(function* () {
      const cause = new Error("authored cause");
      const original = new BrowserScriptError({
        reason: "authored reason",
        cause,
      });
      expect(original.cause).toBe(cause);
      expect(Object.hasOwn(original, "documentInputRule")).toBe(false);
      expect(original._tag).toBe("BrowserScriptError");
      expect(Object.hasOwn(original, "documentInputFailure")).toBe(false);
      const decoded = yield* Schema.decodeEffect(BrowserScriptError)({
        _tag: "BrowserScriptError",
        reason: "authored reason",
      });
      expect(decoded.reason).toBe(original.reason);
      expect(Object.hasOwn(decoded, "documentInputRule")).toBe(false);
      expect(Object.hasOwn(decoded, "documentInputFailure")).toBe(false);
      const invalid = yield* Schema.decodeUnknownEffect(BrowserScriptError)({
        _tag: "BrowserScriptError",
        reason: "authored reason",
        documentInputFailure: "guest-chosen",
      }).pipe(Effect.result);
      expect(invalid._tag).toBe("Failure");
      const invalidRule = yield* Schema.decodeUnknownEffect(BrowserScriptError)(
        {
          _tag: "BrowserScriptError",
          reason: "authored reason",
          documentInputRule: "guest-chosen",
        },
      ).pipe(Effect.result);
      expect(invalidRule._tag).toBe("Failure");
      for (const documentInputRule of HtmlSnapshot.DOCUMENT_INPUT_RULES) {
        const labeled = yield* Schema.decodeEffect(BrowserScriptError)({
          _tag: "BrowserScriptError",
          reason: "authored reason",
          documentInputRule,
        });
        expect(labeled.documentInputRule).toBe(documentInputRule);
      }
    }),
);

it.effect(
  "labels host document rejection families in both modes before any external effects",
  () =>
    Effect.gen(function* () {
      let spawns = 0,
        requests = 0,
        writes = 0;
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
      const inertHost: BrowserScriptHost = {
        request: () => {
          requests += 1;
          return Effect.die("unexpected request");
        },
        setCookie: () => {
          writes += 1;
          return Effect.die("unexpected cookie write");
        },
      };
      yield* Effect.gen(function* () {
        const runtime = yield* BrowserMock;
        const wrap = (body: string) =>
          "<!doctype html><html><head></head><body>" + body + "</body></html>";
        for (const [rule, document] of [
          ["InputEncoding", wrap("\u0000")],
          ["Doctype", "<html></html>"],
          ["DocumentStructure", "<!doctype html><head></head>"],
          [
            "HeadContentSubset",
            "<!doctype html><html><head><table></table></head><body></body></html>",
          ],
          ["CommentSyntax", wrap("<!--unfinished")],
          ["MarkupSyntax", wrap("<?instruction>")],
          ["CharacterReference", wrap("&copy;")],
          ["TagSyntax", wrap("<custom-widget>")],
          ["ClosingStructure", wrap("<div></span>")],
          ["ImplicitRepair", wrap("<p><div></div></p>")],
          ["AttributeSyntax", wrap('<div a="x"b="y"></div>')],
          ["SelfClosingNormal", wrap("<div/>")],
          ["RawTextSubset", wrap("<script><!--x--></script>")],
          [
            "TitleRcdataSubset",
            "<!doctype html><html><head><title><b>x</b></title></head><body></body></html>",
          ],
          ["DocumentElementSubset", wrap("<html></html>")],
          ["TableSubset", wrap("<table></table>")],
          ["SelectSubset", wrap("<select></select>")],
          ["TemplateSubset", wrap("<template></template>")],
          ["ScriptingDependentSubset", wrap("<noscript></noscript>")],
          ["ForeignContentSubset", wrap("<svg></svg>")],
          ["ElementSubset", wrap("<form></form>")],
        ] satisfies ReadonlyArray<readonly [string, string]>) {
          for (const mode of ["async", "classic"] as const) {
            const error = yield* runBoundedScript(
              runtime,
              'throw new Error("never");',
              { ...context, document },
              inertHost,
              mode,
            ).pipe(Effect.flip);
            expect(error.reason).toBe("unsupported HTML document");
            expect(error.documentInputFailure).toBe("UnsupportedInput");
            expect(error).toMatchObject({ documentInputRule: rule });
          }
        }
        const spy = vi
          .spyOn(HtmlSnapshot, "parseHtmlDocument")
          .mockReturnValue({
            _tag: "Success",
            snapshot: { nodes: [], textContent: "" },
          });
        try {
          for (const mode of ["async", "classic"] as const) {
            const error = yield* runBoundedScript(
              runtime,
              'return "never";',
              { ...context, document: wholeDocument },
              inertHost,
              mode,
            ).pipe(Effect.flip);
            expect(error.reason).toBe("unsupported HTML document");
            expect(error.documentInputFailure).toBe("UnsupportedInput");
            expect(error).toMatchObject({
              documentInputRule: "SnapshotRecordInvariant",
            });
          }
        } finally {
          spy.mockRestore();
        }
        expect(HtmlSnapshot.parseHtmlDocument(wholeDocument)._tag).toBe(
          "Success",
        );
      }).pipe(Effect.provide(layer));
      expect([spawns, requests, writes]).toEqual([0, 0, 0]);
    }),
);
