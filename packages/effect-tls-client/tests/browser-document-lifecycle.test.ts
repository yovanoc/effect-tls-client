import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { BrowserMock } from "../src/browser/BrowserMock.js";
import {
  runBoundedScript,
  type BrowserScriptHost,
} from "../src/browser/BrowserScript.js";

const document = (scripts: string) =>
  `<!doctype html><html><head></head><body>${scripts}</body></html>`;

const run = (scripts: string, host?: BrowserScriptHost, timeoutMs = 1_000) =>
  Effect.gen(function* () {
    const runtime = yield* BrowserMock;
    return yield* Effect.result(
      runBoundedScript(
        runtime,
        "",
        {
          url: "https://fixture.test/page",
          cookie: "",
          userAgent: "fixture",
          document: document(scripts),
        },
        host,
        "document",
      ),
    );
  }).pipe(
    Effect.provide(
      BrowserMock.layer({
        allowedOrigins: ["https://fixture.test"],
        timeoutMs,
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );

const recordingHost = (
  assets: Readonly<Record<string, string>>,
  writes: string[],
): BrowserScriptHost => ({
  request: (request) =>
    Effect.succeed({
      status: assets[new URL(request.url).pathname] === undefined ? 404 : 200,
      url: request.url,
      headers: [],
      body: assets[new URL(request.url).pathname] ?? "",
      cookie: "",
    }),
  setCookie: (value) =>
    Effect.sync(() => {
      writes.push(value);
      return "";
    }),
});

describe("document-mode lifecycle", () => {
  it.live("runs authored readiness listeners after initially loading", () =>
    Effect.gen(function* () {
      const output = yield* run(`<script>
        document.cookie = "initial=" + document.readyState;
        document.onreadystatechange = () => { document.cookie = "state=" + document.readyState; };
        document.addEventListener("DOMContentLoaded", event => {
          document.cookie = "ready=" + document.readyState + ":" + (event.target === document) + ":" + (event.currentTarget === document) + ":" + event.bubbles + ":" + event.isTrusted;
        }, { once: true });
        window.onload = event => {
          document.cookie = "load=" + document.readyState + ":" + (event.target === document) + ":" + (event.currentTarget === window) + ":" + event.isTrusted;
        };
      </script>`);
      expect(output._tag).toBe("Success");
      if (output._tag === "Success")
        expect(output.success.setCookies).toEqual([
          "initial=loading",
          "state=interactive",
          "ready=interactive:true:true:true:false",
          "state=complete",
          "load=complete:true:true:false",
        ]);
    }),
  );

  it.live(
    "bubbles DOMContentLoaded only to window, preserving target and once",
    () =>
      Effect.gen(function* () {
        const output = yield* run(`<script>
        var once = 0, captured;
        document.addEventListener("DOMContentLoaded", event => { once++; captured = event; }, { once: true });
        window.addEventListener("DOMContentLoaded", event => {
          document.cookie = "bubble=" + (event.target === document) + ":" + (event.currentTarget === window) + ":" + once;
        }, { once: true });
        window.onload = () => {
          document.cookie = "after=" + (captured.currentTarget === null);
          document.dispatchEvent(new Event("DOMContentLoaded"));
          document.cookie = "once=" + once;
        };
      </script>`);
        expect(output._tag).toBe("Success");
        if (output._tag === "Success")
          expect(output.success.setCookies).toEqual([
            "bubble=true:true:1",
            "after=true",
            "once=1",
          ]);
      }),
  );

  for (const stop of ["stopPropagation", "stopImmediatePropagation"]) {
    it.live(`honors ${stop} without a general DOM propagation framework`, () =>
      Effect.gen(function* () {
        const output = yield* run(`<script>
          document.addEventListener("DOMContentLoaded", event => { document.cookie = "first=doc"; event.${stop}(); });
          document.addEventListener("DOMContentLoaded", () => { document.cookie = "second=doc"; });
          window.addEventListener("DOMContentLoaded", () => { document.cookie = "unexpected=window"; });
          window.onload = () => { document.cookie = "loaded=yes"; };
        </script>`);
        expect(output._tag).toBe("Success");
        if (output._tag === "Success")
          expect(output.success.setCookies).toEqual(
            stop === "stopPropagation"
              ? ["first=doc", "second=doc", "loaded=yes"]
              : ["first=doc", "loaded=yes"],
          );
      }),
    );
  }

  it.live(
    "runs ordered defer while interactive and before DOMContentLoaded",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const output = yield* run(
          `<script>
        document.onreadystatechange = () => { document.cookie = "state=" + document.readyState; };
        document.addEventListener("DOMContentLoaded", () => { document.cookie = "ready=done"; });
        window.onload = () => { document.cookie = "load=done"; };
      </script><script defer src="/one.js"></script><script defer src="/two.js"></script>`,
          recordingHost(
            {
              "/one.js": 'document.cookie = "one=" + document.readyState;',
              "/two.js": 'document.cookie = "two=" + document.readyState;',
            },
            writes,
          ),
        );
        expect(output._tag).toBe("Success");
        expect(writes).toEqual([
          "state=interactive",
          "one=interactive",
          "two=interactive",
          "ready=done",
          "state=complete",
          "load=done",
        ]);
      }),
  );

  it.live(
    "does not wait for static async before DOMContentLoaded, but does before load",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        let release = () => {};
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        const base = recordingHost({}, writes);
        const output = yield* run(
          `<script>
        document.addEventListener("DOMContentLoaded", () => { document.cookie = "ready=done"; });
        window.onload = () => { document.cookie = "load=done"; };
      </script><script async src="/async.js"></script>`,
          {
            ...base,
            request: (request) =>
              Effect.promise(async () => {
                await ready;
                return {
                  status: 200,
                  url: request.url,
                  headers: [],
                  body: 'document.cookie = "async=" + document.readyState;',
                  cookie: "",
                };
              }),
            setCookie: (value) =>
              base.setCookie(value).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (value === "ready=done") release();
                  }),
                ),
              ),
          },
        );
        expect(output._tag).toBe("Success");
        expect(writes).toEqual([
          "ready=done",
          "async=interactive",
          "load=done",
        ]);
      }),
  );

  it.live(
    "awaits chained dynamic loads from DOMContentLoaded and element load listeners",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const output = yield* run(
          `<script>
        function append(src, next) {
          const script = document.createElement("script"); script.src = src;
          script.onload = () => { document.cookie = "element=" + src + ":" + document.readyState; if (next) append(next); };
          document.head.appendChild(script);
        }
        document.addEventListener("DOMContentLoaded", () => { document.cookie = "ready=done"; append("/one.js", "/two.js"); });
        window.onload = () => { document.cookie = "load=done"; };
      </script>`,
          recordingHost(
            {
              "/one.js": 'document.cookie = "one=executed";',
              "/two.js": 'document.cookie = "two=executed";',
            },
            writes,
          ),
        );
        expect(output._tag).toBe("Success");
        expect(writes).toEqual([
          "ready=done",
          "one=executed",
          "element=/one.js:interactive",
          "two=executed",
          "element=/two.js:interactive",
          "load=done",
        ]);
      }),
  );

  it.live(
    "rechecks load delays in the queued completion entry after a zero-count microtask adds work",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const output = yield* run(
          `<script>
        document.addEventListener("DOMContentLoaded", () => {
          const first = document.createElement("script"); first.src = "/one.js";
          first.onload = () => { Promise.resolve().then(() => Promise.resolve().then(() => {
            const next = document.createElement("script"); next.src = "/two.js";
            next.onload = () => { document.cookie = "two=" + document.readyState; };
            document.head.appendChild(next);
          })); };
          document.head.appendChild(first);
        });
        window.onload = () => { document.cookie = "load=done"; };
      </script>`,
          recordingHost({ "/one.js": "", "/two.js": "" }, writes),
        );
        expect(output._tag).toBe("Success");
        expect(writes).toEqual(["two=interactive", "load=done"]);
      }),
  );

  it.live("releases resource errors after their element error listeners", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const output = yield* run(
        `<script>
        const script = document.createElement("script"); script.src = "/missing.js";
        script.onerror = () => { document.cookie = "error=" + document.readyState; throw new Error("listener fixture"); };
        window.onerror = () => { document.cookie = "reported=yes"; return true; };
        document.head.appendChild(script);
        window.onload = () => { document.cookie = "load=done"; };
      </script>`,
        recordingHost({}, writes),
      );
      expect(output._tag).toBe("Success");
      expect(writes).toEqual([
        "error=interactive",
        "reported=yes",
        "load=done",
      ]);
    }),
  );

  it.live(
    "completes lifecycle before returning the fixed static resource failure",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const output = yield* run(
          `<script src="/missing.js"></script><script>
        document.cookie = "later=done";
        document.addEventListener("DOMContentLoaded", () => { document.cookie = "ready=done"; });
        window.onload = () => { document.cookie = "load=done"; };
      </script>`,
          recordingHost({}, writes),
        );
        expect(output._tag).toBe("Failure");
        if (output._tag === "Failure")
          expect(output.failure.reason).toBe(
            "document script resource load failed",
          );
        expect(writes).toEqual(["later=done", "ready=done", "load=done"]);
      }),
  );

  it.live(
    "fetch/XHR, timers and FileReader do not delay load; post-load retention still flushes",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        let release = () => {};
        const loaded = new Promise<void>((resolve) => {
          release = resolve;
        });
        const base = recordingHost({}, writes);
        const output = yield* run(
          `<script>
        fetch("/fetch").then(() => { document.cookie = "fetch=" + document.readyState; });
        const xhr = new XMLHttpRequest(); xhr.open("GET", "/xhr");
        xhr.onload = () => { document.cookie = "xhr=" + document.readyState; }; xhr.send();
        const reader = new FileReader(); reader.readAsText(new Blob(["fixture"]));
        setTimeout(() => { document.cookie = "timer=" + document.readyState; }, 100);
        window.onload = () => { document.cookie = "load=done"; };
      </script>`,
          {
            ...base,
            request: (request) =>
              Effect.promise(async () => {
                await loaded;
                return {
                  status: 200,
                  url: request.url,
                  headers: [],
                  body: "",
                  cookie: "",
                };
              }),
            setCookie: (value) =>
              base.setCookie(value).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (value === "load=done") release();
                  }),
                ),
              ),
          },
        );
        expect(output._tag).toBe("Success");
        expect(writes).toContain("timer=complete");
        expect(writes.filter((value) => !value.startsWith("timer="))).toEqual([
          "load=done",
          "fetch=complete",
          "xhr=complete",
        ]);
      }),
  );

  it.live(
    "checkpoints lifecycle reactions without timer tasks between adjacent classics",
    () =>
      Effect.gen(function* () {
        const output = yield* run(`<script>
        var trace = ["first"];
        setTimeout(() => trace.push("timer"), 0);
        Promise.resolve().then(() => Promise.resolve().then(() => trace.push("inline-job")));
        document.onreadystatechange = () => {
          trace.push(document.readyState);
          Promise.resolve().then(() => Promise.resolve().then(() => trace.push(document.readyState + "-job")));
        };
        document.addEventListener("DOMContentLoaded", () => {
          trace.push("ready"); Promise.resolve().then(() => Promise.resolve().then(() => trace.push("ready-job")));
        });
        window.onload = () => { document.cookie = "trace=" + trace.filter(x => x !== "timer").join(","); };
      </script><script>trace.push("second"); document.cookie = "adjacent=" + trace.join(",");</script>`);
        expect(output._tag).toBe("Success");
        if (output._tag === "Success")
          expect(output.success.setCookies).toEqual([
            "adjacent=first,inline-job,second",
            "trace=first,inline-job,second,interactive,interactive-job,ready,ready-job,complete",
          ]);
      }),
  );

  it.live(
    "treats resources created by complete/load listeners as post-completion work",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const output = yield* run(
          `<script>
        document.onreadystatechange = () => {
          if (document.readyState === "complete") {
            const script = document.createElement("script"); script.src = "/late.js";
            document.head.appendChild(script);
          }
        };
        window.onload = () => { document.cookie = "load=done"; };
      </script>`,
          recordingHost(
            { "/late.js": 'document.cookie = "late=" + document.readyState;' },
            writes,
          ),
        );
        expect(output._tag).toBe("Success");
        expect(writes).toEqual(["load=done", "late=complete"]);
      }),
  );

  for (const source of [
    'document.addEventListener("DOMContentLoaded", () => { while (true) {} });',
    "window.onload = () => { while (true) {} };",
    "document.onreadystatechange = () => { function again() { Promise.resolve().then(again); } again(); };",
  ]) {
    it.live(
      `bounds a nonterminating lifecycle callback: ${source.slice(0, 28)}`,
      () =>
        Effect.gen(function* () {
          const started = performance.now();
          const output = yield* run(
            `<script>${source}</script>`,
            undefined,
            500,
          );
          expect(output._tag).toBe("Failure");
          expect(performance.now() - started).toBeLessThan(2_000);
        }),
    );
  }

  it.live("never turns an unfinished load delay into retention success", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const output = yield* run(
        `<script>
        document.addEventListener("DOMContentLoaded", () => {
          document.cookie = "ready=done";
          const script = document.createElement("script"); script.src = "/never.js"; document.head.appendChild(script);
        });
        window.onload = () => { document.cookie = "unexpected=load"; };
      </script>`,
        { ...recordingHost({}, writes), request: () => Effect.never },
        500,
      );
      expect(output._tag).toBe("Failure");
      expect(writes).toEqual(["ready=done"]);
    }),
  );

  for (const kind of ["static async", "frame"] as const) {
    it.live(
      `bounds a never-resolving ${kind} load after DOMContentLoaded`,
      () =>
        Effect.gen(function* () {
          const writes: string[] = [];
          const output = yield* run(
            `<script>
            document.addEventListener("DOMContentLoaded", () => { document.cookie = "ready=done"; });
            window.onload = () => { document.cookie = "unexpected=load"; };
            ${kind === "frame" ? 'const frame = document.createElement("iframe"); frame.src = "/never"; document.body.appendChild(frame);' : ""}
          </script>${kind === "static async" ? '<script async src="/never.js"></script>' : ""}`,
            {
              ...recordingHost({}, writes),
              request: () => Effect.never,
              loadFrame: () => Effect.never,
            },
            500,
          );
          expect(output._tag).toBe("Failure");
          expect(writes).toEqual(["ready=done"]);
        }),
    );
  }

  it.live(
    "awaits only explicitly granted frame loads; children keep complete without auto lifecycle",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const output = yield* run(
          `<script>
        document.addEventListener("DOMContentLoaded", () => {
          const frame = document.createElement("iframe"); frame.src = "/frame";
          frame.onload = () => { document.cookie = "frame=" + document.readyState; };
          document.body.appendChild(frame);
        });
        window.onload = () => { document.cookie = "load=done"; };
      </script>`,
          {
            ...recordingHost({}, writes),
            loadFrame: () =>
              Effect.succeed({
                parentUrl: "https://fixture.test/page",
                url: "https://fixture.test/frame",
                origin: "https://fixture.test",
                status: 200,
                headers: [],
                cookie: null,
                scripts: [
                  'if (document.readyState !== "complete") throw "child readiness changed"; window.onload = () => { throw "unexpected child lifecycle"; };',
                  'document.addEventListener("DOMContentLoaded", () => { throw "unexpected child lifecycle"; });',
                ],
              }),
          },
        );
        expect(output._tag).toBe("Success");
        expect(writes).toEqual(["frame=interactive", "load=done"]);
      }),
  );

  it.live(
    "does not grant denied frames and releases their error load delay",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const output = yield* run(
          `<script>
        const frame = document.createElement("iframe"); frame.src = "/frame";
        frame.onerror = () => { document.cookie = "frame=denied"; };
        document.body.appendChild(frame);
        window.onload = () => { document.cookie = "load=done"; };
      </script>`,
          recordingHost({}, writes),
        );
        expect(output._tag).toBe("Success");
        expect(writes).toEqual(["frame=denied", "load=done"]);
      }),
  );

  for (const mode of ["classic", "async"] as const) {
    it.live(
      `keeps ${mode} snapshots complete with no automatic lifecycle`,
      () =>
        Effect.gen(function* () {
          const runtime = yield* BrowserMock;
          const output = yield* runBoundedScript(
            runtime,
            `
          document.cookie = "initial=" + document.readyState;
          document.onreadystatechange = () => { document.cookie = "unexpected=state"; };
          document.addEventListener("DOMContentLoaded", () => { document.cookie = "unexpected=ready"; });
          window.onload = () => { document.cookie = "unexpected=load"; };
        `,
            {
              url: "https://fixture.test/page",
              cookie: "",
              userAgent: "fixture",
              document: document('<script>throw "inert";</script>'),
            },
            undefined,
            mode,
          );
          expect(output.setCookies).toEqual(["initial=complete"]);
        }).pipe(
          Effect.provide(
            BrowserMock.layer().pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
    );
  }

  it.live(
    "captures/deletes lifecycle helpers and rejects private delivery collisions",
    () =>
      Effect.gen(function* () {
        const output = yield* run(`<script>
        if ("__documentMode" in globalThis || "__documentLifecycle" in globalThis) throw "helper leaked";
        globalThis.__documentLifecycle = () => { throw "tampered"; };
        document.onreadystatechange = () => { document.cookie = "state=" + document.readyState; };
      </script>`);
        expect(output._tag).toBe("Success");
        if (output._tag === "Success")
          expect(output.success.setCookies).toEqual([
            "state=interactive",
            "state=complete",
          ]);
        const collision = yield* run("<script>var __dispatch;</script>");
        expect(collision._tag).toBe("Failure");
      }),
  );
});
