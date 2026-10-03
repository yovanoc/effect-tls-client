# Browser layer

`effect-tls-client/browser` is a small browser-shaped facade over one scoped
`TlsSession`. It does not create a second cookie jar, runtime, or native
transport.

## Runnable example

Build the package, then run the example with either supported runtime:

```sh
bun run build
node examples/browser.mjs
bun examples/browser.mjs
```

Set `TLS_CLIENT_EXAMPLE_URL` and `TLS_CLIENT_EXAMPLE_PROFILE` to change the
request. The example accepts `chrome_146`, `chrome_146_PSK`, `chrome_152`, and
`chrome_152_PSK`; `Browser.open` derives the matching Chrome identity from the
selected profile. It uses the platform-neutral `examples/runtime.mjs` loader.

## Session and identity

Create a browser session with `Browser.open` and a `BrowserSessionConfig`:

```ts
import { Effect } from "effect";
import * as Browser from "effect-tls-client/browser";

const program = Effect.scoped(
  Effect.gen(function* () {
    const browser = yield* Browser.open({
      transport: { profile: "chrome_152_PSK" },
    });
    const page = yield* browser.navigate("https://example.test/");
    console.log(page.status, page.url);
  }),
);
```

When `identity` is omitted, `Browser.open` derives the Chrome identity for
`chrome_146`, `chrome_146_PSK`, `chrome_152`, and `chrome_152_PSK`. An explicit
identity is a customization escape hatch, but for known Chrome profiles only
its User-Agent's Chrome major is checked; this does not guarantee full
fingerprint or platform consistency. A major mismatch fails with
`BrowserSessionError` kind `Config`. Other and custom profiles require an
explicit identity. `Browser.fromSession` always requires one: the existing
`TlsSession` is opaque, so the caller must keep the supplied identity aligned
with its fixed headers and header order; Browser cannot verify the alignment.
Create the transport without a `Cookie` header. Both APIs keep the Go Jar
authoritative, and browser requests reject manually supplied `Cookie` headers.
`browser.get` stamps XHR/fetch-style headers; `browser.post` can use those
headers or navigation-style headers with `navigation: true`; `browser.navigate`
uses document navigation headers.

Navigation follows `Location` only for 301, 302, 303, 307, and 308 responses,
plus actual HTML `<meta http-equiv="refresh">` directives. It does not infer
redirects from JavaScript text or forms/hidden fields, including content in
comments or `<noscript>`, and it never executes page scripts automatically.
Reviewed script execution is opt-in: an application-provided challenge handler
must explicitly call `context.evaluate` with a caller-supplied runtime such as
`BrowserMock`. Referrers use strict-origin-when-cross-origin behavior:
same-origin URLs keep their path and query after credentials and fragments are
removed, cross-origin requests send only the origin, and HTTPS-to-HTTP
downgrades send no referrer.
`maxRedirects` and `maxChallengeRetries` are independent bounded configuration
values. Keep the enclosing `Effect.scoped` alive until the page and response are
no longer needed.

## Cookies

The Go-side transport cookie jar is authoritative. Browser requests reject a
manually supplied `Cookie` header. Use the existing transport session API for
cookie changes so `HttpOnly`, domain, path, expiry, and redirect behavior stay
correct:

```ts
import { Effect } from "effect";
import { Cookies } from "effect/unstable/http";

const program = Effect.gen(function* () {
  yield* browser.transport.setCookies(
    "http://example.test/",
    Cookies.fromSetCookie("consent=yes; Path=/"),
  );
});
```

## WebSockets

Use the existing transport socket from the browser facade; it shares the same
scoped Go session, TLS profile, proxy, Jar, and fixed identity headers selected
by `Browser.open`. Go performs an HTTP/1.1 WebSocket upgrade (not HTTP/3).
Neither the Browser facade nor `BrowserMock` provides WebSocket support or
synthesizes an `Origin` or `Referer` header; supply `Origin` explicitly when
needed. With `fromSession`, the transport identity remains opaque as described
above.

```ts
const program = Effect.scoped(
  Effect.gen(function* () {
    const browser = yield* Browser.open({
      transport: { profile: "chrome_152_PSK" },
    });
    const socket = yield* browser.transport.webSocket(
      "wss://example.test/socket",
      { headers: [["origin", "https://example.test"]] },
    );
    const reader = yield* socket.reader; // opens the handshake
    const writer = yield* socket.writer;
    yield* writer.write("ping");
    const [reply] = yield* reader.pull; // next batch
    console.log(reply);
  }),
);
```

## Challenge and script boundary

`Browser.navigate` surfaces only explicit challenge response markers as
`page.challenge`: AWS WAF's trimmed `x-amzn-waf-action` value is matched
case-insensitively to `challenge` first; otherwise Cloudflare's trimmed
`cf-mitigated` value must be exactly lowercase `challenge`. Header names are
case-insensitive. A
generic status/body or `cf-ray` alone is not evidence. Without a handler, or
when a handler returns `None`, the original response and body are preserved;
recognition alone neither evaluates scripts nor retries. An optional
`challengeHandler` may explicitly inspect the response and request a bounded
retry. A CloudFront `403` is exposed separately through
`page.cloudFrontForbidden`, not reported as a solved challenge.

The [Cloudflare research notes](research/cloudflare-integration.md) cover
Turnstile and clearance limits, including the lack of a public iframe
`postMessage` acquisition contract. The [DataDome notes](research/datadome-integration.md)
cover Device Check's browser/device assessment. The experimental iframe path
below is load-only; it supplies neither a renderer nor a provider's iframe
SDK/messaging protocol.

```ts
import { Effect } from "effect";

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* Browser.open(
      { transport: { profile: "chrome_152_PSK" } },
      {
        challengeHandler: (_challenge, _context) => {
          // Solve only with an application-owned, externally reviewed integration.
          return Effect.succeedNone;
        },
      },
    );
  }),
);
```

### Composing challenge handlers

Use `composeChallengeHandlers` to try application-defined handlers in order:

```ts
import {
  composeChallengeHandlers,
  type BrowserChallengeHandler,
} from "effect-tls-client/browser";

// Implement these in your application; these are not built-in adapters.
declare const primaryHandler: BrowserChallengeHandler;
declare const fallbackHandler: BrowserChallengeHandler;

const challengeHandler = composeChallengeHandlers(
  primaryHandler,
  fallbackHandler,
);
// Pass { challengeHandler } to Browser.open or Browser.fromSession.
```

Each handler receives the same challenge and context, once per combined-handler
invocation. `None` falls through; the first `Some` retry decision is returned
unchanged and skips later handlers. Empty or all-declining compositions return
`None`. Typed failures and interruption propagate immediately: a failed handler
is not a decline, so errors do not trigger fallback. Navigation's existing
5-second whole-handler deadline and `maxChallengeRetries` cover the entire
composition; this helper adds no deadlines or retries. A retry decision is not
proof of clearance—inspect the follow-up page.

`BrowserMock` is an optional process-backed runtime for reviewed challenge
scripts. A fresh VM context exposes `document.cookie`, `document.referrer` from
the sanitized navigation `Referer` header (empty when absent), and a frozen
location snapshot shared by `window.location` and `document.location`. It exposes
only read-only `href`, `origin`, `protocol`, `host`, `hostname`, `port`,
`pathname`, `search`, and `hash`; this snapshot is not subject to the context-local
`URL` helper's 8,192-character input limit. `window.isSecureContext` is true for
HTTPS and HTTP loopback URLs (`localhost`/`.localhost`, including trailing-dot
hostnames, IPv4 `127.0.0.0/8`, or `[::1]`) and false for ordinary HTTP; other URL
schemes are not modeled as secure
contexts. The VM's `navigator.userAgent` comes from the resolved identity's
`User-Agent` header, while `navigator.language` and `navigator.languages` come
from its `Accept-Language` header. For a `Browser.open` identity, absent or
invalid `Accept-Language` yields `language: ""` and `languages: []`; a
standalone `BrowserMock` evaluation with omitted `languages` instead defaults
to `en-US`. It does not synthesize platform or hardware properties. The VM also
exposes a small `console` and a context-local
`performance` with monotonic `now()` and numeric `timeOrigin` backed by the
runner's real monotonic clock. `getEntries()`, `getEntriesByType(type)`, and
`getEntriesByName(name, type?)` return fresh realm-local empty arrays: no
navigation, resource, mark, measure, or other entries are recorded or fabricated.
The required type/name arguments and DOMString conversions are validated.
Context-local `PerformanceObserver` validates a callable constructor callback
and converts the `observe()` dictionary before checking options. `entryTypes`
accepts iterable objects (including empty sequences); unsupported types are
ignored. It cannot be combined with `type` or `buffered`, even `buffered: false`.
An observer cannot switch between `entryTypes` and `type`, even after
`disconnect()` (a realm-local Error named `InvalidModificationError` is thrown;
a full DOMException interface is not supplied). `supportedEntryTypes` is the
same frozen empty realm-local array on each read; observers never call callbacks,
and `takeRecords()` returns a fresh empty realm-local array. These APIs are an
unrecorded timeline subset, not Resource Timing or acquisition evidence.
`document.readyState` is read-only and statically `"complete"` as a model
convention, not proof that the actual reviewed page's lifecycle completed.
Challenge response HTML is not passed into the realm: head/body are synthetic
append targets containing only explicitly created and appended modeled nodes.
No HTML parsing, loading/interactive transitions, lifecycle simulation,
`readystatechange`, `DOMContentLoaded`, or document/window lifecycle `load`
events are generated. Modeled element load events remain separate.
It exposes context-local `URL` and `URLSearchParams` backed by a private,
string-only Node URL parser closure. URL parsing accepts bounded strings and an
optional base, and provides `href`, `origin`, `protocol`, `host`, `hostname`,
`port`, `pathname`, `search`, `hash`, and `toString()`. `URLSearchParams`
accepts a query string and implements `get(name)` only. Both APIs are read-only:
URL property writes and query mutations throw; non-string initializers and other
query methods are unsupported. URL inputs are capped at 8,192 UTF-16 code units
and serialized parser results at 64 KiB. Context-local `TextEncoder` supports
UTF-8 `encode()` and `encodeInto()`, including replacement of malformed
surrogates and non-splitting partial writes. `crypto.getRandomValues` uses
Node's secure random source through a private serialized-byte closure. It
supports integer typed arrays (including BigInt), fills only the supplied view,
returns the same view, and enforces the 65,536-byte per-call limit;
floating-point arrays and `DataView` reject with context-local errors. The
crypto subset also provides RFC 4122 v4 `crypto.randomUUID()` and
`crypto.subtle.importKey("raw", ..., { name: "AES-GCM" }, false, ["encrypt"])`
plus AES-GCM `encrypt()` with optional additional data and supported tag
lengths. Imported keys are non-extractable and limited to AES-128/192/256;
`CryptoKey` values, promises, results, and errors are VM-local façades, while
Node WebCrypto keys stay in a private store. Each evaluation allows at most 8
keys, 64 AES-GCM import/encrypt operations, and 64 KiB per raw input. This
operation cap does not count `getRandomValues()` or `randomUUID()`. Other WebCrypto operations
(including decrypt/export) are unsupported. It synthesizes no browser
fingerprint metrics. The context also provides
Promise-based `fetch`, asynchronous `XMLHttpRequest`, `document.loadScript`,
bounded timeout/interval APIs
(`setTimeout`/`clearTimeout` and `setInterval`/`clearInterval`), and small
context-local `Event` listeners on `document` and `window`. Listener callbacks run synchronously on the target, with capturing listeners
first and registration order within each group; duplicate
`(type, callback, capture)` registrations are ignored, matching removals,
`once`, and `passive` work; `AbortSignal` listeners are unsupported and reject.
`dispatchEvent` accepts only this runtime's synthetic `Event` instances
(`isTrusted` is always `false`). There is no DOM tree, event propagation, or
automatic lifecycle/user-event delivery. Listener exceptions are reported as
`BrowserScriptError` and fail evaluation. Context-local `Blob` supports UTF-8
strings, ArrayBuffers, views, nested Blobs, `size`, `type`, `text()`,
`arrayBuffer()`, and `slice()`. Its cumulative per-evaluation allocation quota
is 1 MiB, including Blob data, type metadata, and materialized reads; quota
failures use context-local `QuotaExceededError`. `Blob.stream()` and native line
endings explicitly reject. Context-local `Request` supports URL/string input,
method, `Headers`, string or `FormData` bodies, `credentials: "same-origin"`,
and `redirect: "follow"`; other credential/redirect modes, explicit `mode`,
streamed bodies, and abort signals are unsupported. `fetch` accepts these Request
objects and applies the same origin, body, and header limits as URL/init calls.
Request URL strings are retained for host-side resolution against the page URL.
A Request retains its FormData body by reference, so mutations before `fetch()`
are reflected because multipart serialization happens at fetch time. Context-local
`FormData` stores ordered duplicate fields and supports `append`, `set`, `delete`, `get`, `getAll`, `has`, `keys`,
`values`, `entries`, iteration, and `forEach`. Values are strings (other values
are string-coerced) or copied context-local Blobs; Blob types are preserved,
Blob parts use the default `filename="blob"`, and File metadata or explicit
filenames are unsupported. Passing an HTML form argument or optional filename
arguments rejects. FormData names, string values, Blob data, and type metadata
share the 1 MiB Blob quota, and at most 256 entries are allowed. Fetch and XHR
serialize FormData as multipart with a secure random boundary; values are UTF-8
encoded, line endings are normalized, and quotes/newlines in field names are
escaped. A multipart `Content-Type` is added only when the script did not
supply one. The complete
serialized body, including framing, is capped at 16 KiB before allocation.
Direct Blob request bodies are unsupported. Context-local `FileReader`
asynchronously supports
`readAsArrayBuffer`, UTF-8-only `readAsText`, and `readAsDataURL` with
`loadstart`, `progress`, `load`, `error`, `abort`, and
`loadend` events, with local `ProgressEvent` values for progress events. It
shares the Blob quota, including the locally encoded DataURL result. Active
`abort()` cancels the pending read and emits `abort`/`loadend` immediately; it
leaves the reader `DONE` with null result/error. In `EMPTY` or `DONE`, `abort()`
only clears the result and preserves the state/error. Concurrent-read errors
stay inside the VM. Its events remain synthetic (`isTrusted === false`), and its result, errors, and callbacks
are context-local. DataURL base64 is only used as the script-visible local
result, never for Bridge or network body transport. Workers and object URLs are
not provided. It does not expose `process`, filesystem,
WebSocket, or general DOM APIs. Network operations
are serialized to the host and made through the same scoped `TlsSession`; Go
remains authoritative for cookies.

The only executable DOM-like script support is VM-local external asynchronous classic
`<script>` elements: `document.createElement("script")`, plus
`document.head.appendChild` and `document.body.appendChild`. Appending returns
the same element and starts that element at most once. Resource failures (including
HTTP, network, policy, and byte-budget failures) fire synthetic element `error`
without `load`. A successfully fetched classic script that fails parsing or
execution instead reports a cancelable, realm-local `ErrorEvent` on `window`
before element `load`. Events remain synthetic (`isTrusted === false`). Same-origin
errors expose the thrown guest value (a guest `SyntaxError` for parsing failures),
message, and final script URL as `filename`. Cross-origin final URLs are no-CORS
and muted: `message: "Script error."`, `filename: ""`, `lineno: 0`, `colno: 0`,
and `error: null`. Locations are also 0 for same-origin errors: host stacks are
not parsed and source locations are not modeled. Legacy `window.onerror` receives
`(message, source, lineno, colno, error)`; returning `true` cancels the event.
Uncaught timer, event-listener, XHR, FileReader, and script-element `load`/`error`
callback exceptions are reported as cancelable realm-local `ErrorEvent`s on
`window`; evaluation continues, and errors thrown by error handlers do not
recurse. These async errors use the page URL as `filename`, with `lineno` and
`colno` 0; cross-origin muting does not apply to them.
The nonstandard direct `document.loadScript` convenience API remains separate:
parsing/execution failures reject with the existing `loaded script failed: `
prefix, rather than reporting a Window event and resolving.
This is not acquisition or clearance evidence. At most 32 combined snapshot,
script, frame, and ordinary elements may exist per evaluation. Cumulative
attribute-name/value data and mutable ordinary text share the existing 16 KiB
UTF-8 budget; charges are never refunded. Each attribute value and each mutable
text assignment is limited to 8,192 characters. Inline content, module or other
non-JavaScript types, nonempty `integrity` (SRI is rejected, not ignored), any
`crossorigin`, `defer`/`nomodule`, and setting `async = false` are unsupported
and reject. `document.createElement` also accepts `"iframe"` as described
below and the bounded ordinary tags listed next. This is not a general DOM or
renderer and adds no `postMessage` API.

### Caller-created ordinary elements

`createElement` supports h1–h6, div, span, p, address, article, aside, b,
blockquote, code, em, footer, header, i, main, section, small, strong, sub, sup,
and u. Names use DOMString conversion and ASCII-only case folding, without
trimming. Omitted/undefined/null options and dictionaries with no defined `is`
are accepted for ordinary, script, and frame creation. Unknown dictionary
members are ignored; defined `is` and legacy string options explicitly reject:
there is no custom-element registry. Getter/conversion failures remain guest
failures. Unsupported tags, including image/media/link, canvas, forms, SVG,
and custom tags, reject rather than enabling resource or rendering behavior.

Each ordinary record is a stable realm-local object with readonly
`tagName`/`nodeName` and `parentNode`, mutable `id`, `className`, and `textContent`,
and `getAttribute`/`setAttribute`/`hasAttribute`/`removeAttribute`. Writable
attributes are id, class, title, lang, dir, role, and ASCII data-/aria- names.
They store strings only; event-handler, style, and resource attributes reject.
Null/undefined text becomes empty; text is literal, never parsed or executed.
Text reads include ordinary descendants; a successful text assignment detaches
children. Failed data-budget assignments leave attributes, text, and children
unchanged. Snapshot text is still readonly and is not charged as mutable text.

Head/body accept ordinary records, and ordinary `appendChild` accepts only other
ordinary records from the same realm. It returns the same object, moves an
already-parented ordinary record to the end, and rejects self/ancestor cycles,
foreign objects, snapshot records, and executable script/frame children.
Queries see only attached actual records in preorder, never detached creations
or invented original-page elements. No removal API, text-node API, full native
prototype hierarchy, general `innerHTML`, styles/layout, rendering, lifecycle
callbacks, or automatic JS/frames/navigation/fetch/cookies is supplied.
Unsupported property mutation explicitly rejects even in non-strict source.
Ordinary append itself never initiates a request; child realms remain isolated.

### Explicit body-fragment snapshot (experimental)

Low-level callers may explicitly pass `html?: string` in `BrowserScriptContext`:

```ts
const source = 'return document.querySelector("div#notice.note").textContent;';
const context = {
  url: "https://example.com/",
  cookie: "",
  userAgent: "fixture",
  html: '<div id="notice" class="note">Local &amp; explicit</div>',
};
const evaluation = runtime.evaluate(source, context);
```

This is a **complete supplied body fragment**, not an actual full reviewed page,
HTML excerpt selection, full-document parsing, renderer, or provider proof.
There is no automatic navigation/challenge body plumbing or Browser fragment option.
The caller supplies it deliberately; use is explicit and nonautomated.

The host parses the strict `HtmlSnapshot` subset before spawning. Supported ordinary
tags are a, address, article, aside, b, blockquote, code, div, em, footer, header,
i, main, p, section, small, span, strong, sub, sup, u; standard void tags except
col are accepted. Script/style contain inert raw text. Simple comments, properly
nested explicit closing tags, quoted/unquoted/boolean attributes, amp/apos/gt/lt/quot
and valid numeric references are supported. Full documents, doctype, document repair,
unsupported tags/references and script escape syntax reject the whole fragment.
Unsupported syntax and limits become finite `BrowserScriptError` reasons, without
embedding HTML. Raw HTML is not sent over IPC, fetched, or persisted by BrowserMock;
only Schema-validated parsed records and complete textContent cross the boundary.

Limits stay at 128 KiB UTF-8 input, 32 combined snapshot/script/frame/ordinary
elements, 16 KiB cumulative UTF-8 attribute-name/value bytes (now also shared
with mutable ordinary text), and 8,192 characters per value.
The **actual serialized startup line including its newline** must fit 128 KiB.
Repeated ancestor textContent and JSON escaping can exceed that limit even for a
valid small fragment: fail before spawn, never trim text or raise quotas.
Snapshot quotas are charged before guest execution and never refunded; all other
source/network/timer/frame/deadline budgets remain unchanged.

Each parsed element has one stable immutable realm-local object with actual
uppercase `tagName`/`nodeName`, readonly attribute pairs, `id`, `className`, complete
`textContent`, `getAttribute` and `hasAttribute` (ASCII-case-insensitive names).
`document.body.textContent` is the complete supplied fragment text. Missing IDs
are not fabricated. Mutations or appending snapshot elements reject, including
parsed scripts: parsing never evaluates, fetches, writes cookies, triggers
lifecycle events, or requests frames. Only the root gets these records; reviewed
child frames see no parent snapshot or private data helpers.

`document.querySelector` accepts **one compound selector**: optional ASCII tag
plus at most one `#id` and zero or more `.classes`. Tag grammar is
`[A-Za-z][A-Za-z0-9-]*`; ID/class tokens use `[A-Za-z_][A-Za-z0-9_-]*`.
No whitespace, escapes, Unicode tokens, wildcards, combinators, attribute selectors,
pseudo-classes or lists: unsupported syntax throws a realm-local TypeError, not
`null`. Supported selectors return the first actual attached record in the modeled
order or `null`; tag-only head/body selectors return the existing append targets.
IDs/classes are case-sensitive under this fixed standards-style fragment model;
no original-page quirks mode or full-page first-match guarantee is claimed.
There is no `querySelectorAll`, unbounded element creation, layout, rendering,
native-browser fingerprinting or provider-selector support.

### Explicit complete-document snapshot (experimental)

Low-level callers may instead pass `document?: string` in `BrowserScriptContext`,
mutually exclusive with `html`. Supply a complete `<!doctype html>` document with
explicit `html`, `head`, and `body` opening and closing tags:

```ts
const context = {
  url: "http://localhost:43127/page",
  cookie: "",
  userAgent: "fixture",
  document:
    '<!doctype html><html lang="en" id="root"><head id="top"><meta name="fixture" content="yes"><title>Fixture</title></head><body id="page"><div id="seed">one<span>two</span></div></body></html>',
};
const evaluation = runtime.evaluate(
  'return document.getElementById("seed").textContent;',
  context,
); // value: "onetwo"
```

All supported root attributes, head metadata, and ordinary body records are
retained, or the entire input fails with `Unsupported` or `LimitExceeded`;
there is no fragment extraction, HTML repair, rendering, or automatic execution.
Head accepts only meta/link/title/script/style; title supports conservative
character references but no `<`, and script/style text remains inert.
Body uses the existing strict fragment grammar. Table, noscript, foreign content,
form, base, omitted structural parts, legacy doctypes, and BOMs reject.
Whitespace after `</body>` or `</html>` is appended to html/body `textContent`, following the native insertion-mode rules.

Original parsed html/head/body attributes and record identity are readonly;
`document.documentElement` is the actual root, also reachable by the supported
query, tag, and ID lookups. Head/body bounded append delegates only to existing
explicit caller-created script, frame, and ordinary-element authorization.
Parsed LINK/META/SCRIPT/STYLE never load resources, run code, or fire events.

The limits are 32 elements including these three roots, 16 KiB cumulative attribute-name/value
bytes (shared with later mutable ordinary text), and 8,192 characters per attribute value or
ordinary text assignment. Parsed snapshot text is bounded by the 128 KiB input and actual
serialized IPC-line limits. Repeated ancestor `textContent` or JSON escaping can cause rejection.
Child frames do not share the parent document. This is a source VM snapshot,
not a full browser: no layout, styles, or `classList` support is claimed.
Default challenge evaluation does not automatically supply response HTML or JS.
The existing `html` fragment contract is unchanged; without `document`,
`document.documentElement` remains absent.

Challenge handlers can forward the **entire unmodified** `context.body` to the
same strict document parser, keeping original reviewed program source separate:

```ts
const evaluation = Effect.gen(function* () {
  return yield* context.evaluateClassic(originalSource, {
    document: "response",
  });
});
```

Use `yield*`, not `await`: these methods return Effects. Async-body
`context.evaluate(originalSource, { document: "response" })` takes the same strict
option; omission supplies no document. No `context.html`, excerpts, repair,
automatic HTML-script execution or lifecycle is added. Parsed records stay inert;
resource/cookie grants and caps stay unchanged. No renderer, `classList`, native
HTML-parser fidelity, provider fit, selector acquisition or clearance is promised.

### Experimental modeled element lookup

Without a snapshot, `document.getElementsByTagName` supports `"head"`, `"body"`,
`"script"`, and all allowed ordinary tags (including empty collections before
creation; ASCII case-insensitive, without trimming). A snapshot additionally enables its actual tag names. Each realm caches VM-local,
read-only live collections: numeric access, `in` for currently present canonical
numeric indices and actual collection properties, `length`, `item(index)`
(unsigned 32-bit index coercion, `null` out of range), and iteration. Numeric
access out of range is `undefined`; `in` is false for out-of-range and
noncanonical indices. These are not arrays or complete `HTMLCollection`
implementations: `namedItem` explicitly rejects; named-property lookup and
numeric-property enumeration are not provided. Collection writes, deletion,
property definition, preventing extensions, and prototype replacement reject.

Head/body lookup returns the actual frozen append targets, which cannot be
replaced. Script lookup includes only successfully appended modeled script
nodes, including nodes whose subsequent load fails, not merely created nodes.
Order is head subtree preorder, supplied fragment preorder, then body subtree
preorder. Script/frame duplicate append remains a no-op even to the other target.
Only ordinary records support reparenting and `parentNode`; `insertBefore` and
removal are not supplied. Lookup itself performs
no network request or execution and does not increase any quota.

`document.getElementById(id)` performs a read-only scan of actual attached
snapshot, ordinary, modeled script and iframe records, returning the same node object or `null`.
IDs are exact and case-sensitive; an empty or missing ID matches no node. The
argument uses DOMString coercion (omitting it or passing a Symbol rejects).
Lookup follows head subtree preorder, fragment preorder, then body subtree
preorder, including mixed ordinary/scripts/frames. Script/frame duplicate
appends neither duplicate nor move nodes; ordinary reparenting updates order. Attribute changes are read live: script `id`/`setAttribute`/`removeAttribute`
and iframe `id`/`setAttribute` retain the existing cumulative UTF-8 attribute
budget. Frame IDs can change after append, but frame navigation still rejects.
The frozen head/body targets have no modeled ID attributes and cannot match.
Created but unattached nodes and all nodes in other realms are excluded. No
registry, automatically acquired page HTML, fabricated missing elements, or renderer is provided;
lookup adds no network, execution, cookie, or frame authority in either async
or classic evaluation. A missing original-page element honestly returns `null`,
not provider acquisition, Device Check compatibility, or clearance evidence.

There is no HTML parsing or synthetic initial-page script node: the evaluated
bootstrap and `document.loadScript` calls are VM programs, not DOM elements.
Child realms get only their own targets, ordinary nodes, and collections, never
parent nodes; child dynamic script append remains unsupported. Without a snapshot
containing the tag, `"iframe"`, `"*"`, and other unsupported tag queries explicitly
reject rather than pretending to query a full DOM. This subset adds no lifecycle/DOMReady, history, worker, rendering,
messaging, navigation, or cookie authority, and is not a Cloudflare resolver
or evidence of clearance.

### Experimental reviewed iframe loading

The optional `BrowserHandlers.frameReviewer` lets `BrowserMock` load an
HTTP(S) frame candidate through the same scoped `TlsSession`. The reviewer
receives a Schema-validated `UntrustedFrameCandidate` (`parentUrl`, `url`,
`origin`, `status`, `headers`, and untrusted HTML `body`) and must return a
Schema-checked `Option.some({ scripts })` to grant specific source strings, or
`Option.none()` to deny. Page scripts are never extracted or selected
automatically. `BrowserMock.layer({ allowedOrigins })` separately allowlists
exact network origins: allowing a fetch does not grant code execution.

This synthetic example selects only its own fixture source:

```ts
import { Effect, Option } from "effect";
import * as Browser from "effect-tls-client/browser";

const frameReviewer: Browser.BrowserFrameReviewer = (candidate) =>
  candidate.origin === "https://example.test" &&
  candidate.url === "https://example.test/frame"
    ? Effect.succeed(
        Option.some({ scripts: ["window.syntheticFixture = true;"] }),
      )
    : Effect.succeed(Option.none());

const program = Effect.scoped(
  Effect.gen(function* () {
    const scriptRuntime = yield* Browser.BrowserMock;
    return yield* Browser.open(
      { transport: { profile: "chrome_152_PSK" } },
      { scriptRuntime, frameReviewer },
    );
  }),
);
```

Provide `BrowserMock.layer({ allowedOrigins: ["https://example.test"] })`
and `TlsClient.layer` as usual. The origin grant permits the frame request;
the reviewer independently grants the selected source. Frames accept only
HTTP(S) `src` URLs without credentials and `src`/`id`/`name` attributes. Per
evaluation limits are four frames, 32 combined script/frame nodes, 16 KiB of
attribute data (8,192 characters per value), at most eight selected scripts per
frame, and 64 KiB of aggregate source including the parent script. Frame loads
share the existing eight-request and 1 MiB network-data budgets, the default
2-second `BrowserMock` process deadline, and the 5-second whole challenge-handler
deadline.

By default the reviewed frame cookie is `null`, so child `document.cookie` is
empty. Only an explicit `cookiePolicy: "same-origin"` grant for a frame whose
origin matches the parent provides a read-only Go-Jar projection; child cookie
writes still reject. Cross-origin frame requests omit credentials and ignore
response `Set-Cookie`. The child realm has separate globals, intrinsics, and
read-only location; `parent`, `top`, and `contentWindow` are opaque. Child
`fetch`, XHR, `document.loadScript`, cookie writes, navigation, and `postMessage`
are unsupported. There is no rendering or general DOM. A synthetic `load`
event is not SDK completion or clearance evidence, and no vendor success
message is forged. This is experimental load-only support, not full iframe,
Turnstile, DataDome Device Check, or clearance support. Existing frame fixtures
are synthetic and do not establish cross-platform Node 25+ coverage.

Network access is denied unless each origin is explicitly configured. HTTPS
origins must be allowlisted; plain HTTP is allowed only for loopback origins.
Redirects are followed manually, each hop must satisfy the same policy,
HTTPS-to-HTTP downgrades are rejected, and authorization headers are removed on
cross-origin redirects. The default allowlist is empty. Configure the runtime
layer with only the exact origins required:

```ts
const runtimeLayer = Browser.BrowserMock.layer({
  allowedOrigins: ["https://challenge.example.test"],
});
```

### Opt-in reviewed challenge handler

`reviewedChallengeHandler` runs only the source you supply, never extracts or
executes page JavaScript automatically. This synthetic fixture example requires
no network assets:

```ts
const program = Effect.scoped(
  Effect.gen(function* () {
    const scriptRuntime = yield* Browser.BrowserMock;
    yield* Browser.open(
      { transport: { profile: "chrome_152_PSK" } },
      {
        scriptRuntime,
        challengeHandler: Browser.reviewedChallengeHandler({
          source: `
            window.acquireFixtureCookie = async () => {
              document.cookie = "fixture-clearance=ready; Path=/";
            };
            await window.acquireFixtureCookie();
            return "fixture finished";
          `,
          cookieNames: ["fixture-clearance"],
        }),
      },
    );
  }),
);
```

### Await external script loading and acquisition separately

For example, a reviewed synthetic asset at `https://challenge.example.test/acquire.js`
may define `window.acquireFixture` as its own asynchronous acquisition operation.
Within the explicitly evaluated source, wait for both steps:

```js
const script = document.createElement("script");
script.src = "https://challenge.example.test/acquire.js";
const loaded = new Promise((resolve, reject) => {
  script.addEventListener("load", resolve, { once: true });
  script.addEventListener("error", reject, { once: true });
});
document.head.appendChild(script);
await loaded; // Fetch and script execution finished; this is not clearance.
await window.acquireFixture(); // Separate, fixture-defined acquisition promise.
```

Awaiting `load` alone does not mean acquisition succeeded. The external asset
must be reviewed and its exact origin allowed; verify the actual follow-up page
rather than treating a load event or returned value as clearance. Unawaited load
or acquisition work ends when evaluation completes.

Options are Schema-validated when the handler executes; invalid options fail
with `BrowserSessionError` kind `Config` before evaluation. `cookieNames` is a
nonempty readonly tuple of nonempty names, and `source` must be nonempty. The
handler reads the Go Jar for `context.response.url` before and after awaiting
`context.evaluate` (which flushes pending cookie writes). It requests a
same-URL retry only if every named cookie has a nonempty value afterward and
at least one value changed or was newly created. Script return strings never
count as clearance. Missing, empty, or unchanged cookies leave the challenge
visible; runtime and transport failures retain their existing typed errors.
Retries remain bounded by `maxChallengeRetries`. Cookie presence and freshness
are retry evidence, not proof that the page is solved: inspect the follow-up
page and its challenge/status yourself.

### Caller-reviewed classic root source

`context.evaluate(source)` remains async-body evaluation: top-level `return` and
`await` work, and `var` declarations stay local. For original caller-reviewed
classic scripts, explicitly use `context.evaluateClassic(source)`. BrowserMock
compiles the original source as-is as a `vm.Script` in the root realm: top-level
`var` and functions become window globals; `let`/`const` remain global lexical
bindings, not window properties. Later dynamic classic scripts share that realm.

The runtime capability `BrowserScriptRuntime.evaluateClassic` is optional.
Existing custom runtimes remain valid for async evaluation; requesting classic
execution without that capability fails with `BrowserScriptError`, reason
`Runtime does not support classic script evaluation`, never an async fallback.
Direct callers can use `runBoundedScript(runtime, source, context, host, "classic")`;
the fifth argument is Schema-validated and defaults to `"async"`.

The script completion value is awaited once under the same shared deadline,
then authoritative host cookie writes are flushed. A final expression Promise
can explicitly wait for acquisition work; undefined completion returns an empty
string, not clearance or a retry. Unawaited acquisition is **not** implicitly
awaited. This adds no HTML script discovery, source rewriting, automatic SDK
configuration, vendor resolver, or claim of challenge clearance. All existing
source/network/frame/crypto/timer/DOM quotas, origins, credentials, Node permission
denials and the hard process cutoff remain unchanged. String-based `eval` and
`Function` work in the VM for caller-reviewed code; WebAssembly code generation
remains disabled. This VM is not a hostile-code sandbox (see below).
Trusted snapshot/flush/error helpers are captured before guest source and are
not in its lexical scope. Reserved delivery-name collisions fail before trusted
callbacks are installed; delivery names are removed and checked inside the realm
before callback execution.

If reviewed source uses `document.loadScript`, await the actual acquisition
operation too, not just asset loading. Assign shared entry points to `window`
globals when using default async evaluation: that source runs inside an async
wrapper, so local declarations are not shared globals. Unawaited work ends when evaluation completes. The
runtime defaults to a 2-second hard deadline; navigation also caps the whole
handler at 5 seconds. Origin review/allowlisting does not provide an exact-byte
asset integrity pin. Existing source, input, body, origin, credential, and
network quotas still apply. For advanced per-response configuration, use the
existing custom `challengeHandler` rather than a separate callback API.

The bridge is intentionally small: up to 8 network requests per evaluation.
Host-side network requests are serialized to preserve authoritative cookie
snapshots. Other
limits are 128 request headers and 64 KiB of header-name/value bytes per
request, 16 KiB per request body, 64 KiB per fetch/XHR response, 1 MiB per
`document.loadScript` asset, and 1 MiB of total network data per evaluation
(including serialized requests, response headers, and bodies). The 64 KiB
initial `context.evaluate` source limit is separate from the network-loaded
script asset limit. Host-to-runner network-response JSON IPC is capped at 8 MiB
per line, and all host-to-runner messages share an 8 MiB evaluation budget;
startup and control lines remain capped at 128 KiB. This covers the sixfold
worst-case JSON escaping of a 1 MiB body plus bounded headers and cookie state.
Runner-to-host IPC remains capped at 128 KiB per line and 1 MiB per evaluation.
Script cookie state and writes are capped at 64 KiB, with at most 64 writes,
64 active timers, and 256 timer firings. Timers are capped at 120 seconds.
Evaluation defaults to a 2-second hard process deadline (configurable up to
120 seconds); the child and its timers are terminated on completion, failure,
timeout, or scope closure. Fetch supports string URLs, string bodies, and bounded
FormData multipart bodies. It rejects explicit `mode` values, `credentials` values
other than `same-origin`, and `redirect` values other than `follow`. Credentials
are sent only when each request hop matches the page origin: cross-origin fetches
remain allowed, but session Authorization, Proxy-Authorization, Jar cookies, and
response Set-Cookie updates are omitted. XHR is asynchronous, supports string
and FormData multipart bodies, and rejects `withCredentials = true`. Its
`responseType` only parses JSON for `"json"`; every other value returns a string.
This is an intentionally small Fetch/XHR subset, not a full browser API.

The runtime always starts Node with `--permission` and verifies that its
permission API reports `process.permission.has("net") === false` before reading
the script. This requires Node 25+; older or incompatible executables fail
closed rather than falling back to an experimental permission flag. A Bun host
delegates to Node; configure `BrowserMock.layer({ executable: "..." })` when
`node` is not on `PATH`.

Script cookie reads and writes use the `cookies.script` Bridge operation. Go
filters `HttpOnly` cookies using the page URL and applies raw script writes
under the authoritative Jar lock, ignoring `HttpOnly` writes and exact
name/domain/path overwrites of existing `HttpOnly` cookies. Response
`Set-Cookie` headers are not exposed to scripts. `document.cookie` writes cross
the asynchronous Bridge, so a synchronous read immediately after assignment
can still show the previous value. Pending writes are committed before a
network request or evaluation completes, and the authoritative Jar value then
replaces the script view; rejected `HttpOnly`, domain, path, or secure writes
never become visible after synchronization. This is not a malicious-code
sandbox: Node's permission model has documented limitations, and `node:vm` is
only the evaluator context, never the security boundary. Run reviewed vendor
scripts only; do not pass arbitrary attacker-controlled source. There is no
guaranteed child memory cap; size limits and the deadline do not bound
allocations. The opt-in AWS WAF adapter below is not a general solver and must
not claim success without verifying the follow-up response.

### AWS WAF (experimental)

The optional `effect-tls-client/challenges/aws-waf` entry is separate from the
core and browser barrels; importing it does not change default behavior. Its
`bootstrap` callback is the trust decision: return only scripts you have
reviewed for your deployment, or `Option.none()` to decline. It never executes
scripts just because discovery found them.

This Node example uses the documented SDK mode. Set `TLS_CLIENT_EXAMPLE_URL`
to the protected HTTPS page, `AWS_WAF_INTEGRATION_URL` to the application
integration URL from your AWS WAF setup (without `/challenge.js`), and
`AWS_WAF_ENDPOINT_ORIGINS` to a comma-separated list of the exact origins used
by its AWS requests. There can be multiple AWS request origins; these are
separate from the script-asset `scriptOrigins` allowlist. No discovered endpoint
is automatically allowed.

```ts
import { Effect, Layer, Option } from "effect";
import { NodeServices } from "@effect/platform-node";
import { TlsClient } from "effect-tls-client";
import * as Browser from "effect-tls-client/browser";
import {
  awsWafChallengeHandler,
  type AwsWafBootstrap,
} from "effect-tls-client/challenges/aws-waf";

const targetUrl = process.env.TLS_CLIENT_EXAMPLE_URL;
const integrationUrl = process.env.AWS_WAF_INTEGRATION_URL;
const awsEndpointOrigins = (process.env.AWS_WAF_ENDPOINT_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "");
if (!targetUrl || !integrationUrl || awsEndpointOrigins.length === 0) {
  throw new Error(
    "Set TLS_CLIENT_EXAMPLE_URL, AWS_WAF_INTEGRATION_URL, and AWS_WAF_ENDPOINT_ORIGINS",
  );
}

const targetOrigin = new URL(targetUrl).origin;
const challengeScriptUrl = new URL(
  "challenge.js",
  `${integrationUrl.replace(/\/+$/, "")}/`,
).href;
const scriptOrigins: readonly [string, ...Array<string>] = [
  new URL(challengeScriptUrl).origin,
];
const reviewedBootstrap: AwsWafBootstrap = {
  scripts: [{ _tag: "External", url: challengeScriptUrl }],
  acquisition: "getToken",
};
const challengeHandler = awsWafChallengeHandler({
  scriptOrigins,
  bootstrap: (page) =>
    Effect.succeed(
      new URL(page.url).origin === targetOrigin
        ? Option.some(reviewedBootstrap)
        : Option.none(),
    ),
});

const services = NodeServices.layer;
const browserServices = Layer.mergeAll(
  TlsClient.layer.pipe(Layer.provide(services)),
  Browser.BrowserMock.layer({
    allowedOrigins: [targetOrigin, ...scriptOrigins, ...awsEndpointOrigins],
  }).pipe(Layer.provide(services)),
);
const program = Effect.scoped(
  Effect.gen(function* () {
    const scriptRuntime = yield* Browser.BrowserMock;
    const browser = yield* Browser.open(
      { transport: { profile: "chrome_152_PSK" } },
      { scriptRuntime, challengeHandler },
    );
    const page = yield* browser.navigate(targetUrl);
    console.log(`${page.status} ${page.url}`);
    if (page.challenge !== undefined) {
      console.warn(`still challenged: ${page.challenge.kind}`);
    }
  }),
);

await Effect.runPromise(program.pipe(Effect.provide(browserServices)));
```

`scriptOrigins` permits loading the explicitly selected `challenge.js` asset;
`BrowserMock.allowedOrigins` separately permits script network requests. Supply
only exact HTTPS origins needed by your integration, including every AWS origin
it calls. Configure them from the reviewed deployment rather than copying page
script URLs into either allowlist.

`acquisition: "getToken"` explicitly invokes the public
`AwsWafIntegration.getToken()` SDK method after loading the reviewed asset,
awaits it, and requires a nonempty string. It installs no observer hooks, so a
frozen SDK can work; private refresh methods are not instrumented in this mode. AWS
documents `getToken`, `hasToken`, and `fetch`; `getToken()` may return an
existing unexpired token, otherwise it obtains and stores `aws-waf-token`, and
acquisition can time out after two seconds. This does not prove the protected
page is clear. The handler requests a retry only when the cookie is nonempty
and newly created or changed; inspect the actual follow-up status, challenge,
and content. A token already present and unchanged may leave the challenge
visible.

The default `acquisition: "page"` mode instead runs only the callback-selected
scripts, in the order returned, and observes acquisition initiated by that
reviewed page flow. Observers are installed before and after selected scripts;
SDK creation or method replacement and acquisition in the same script is
unsupported. Read-only methods that cannot be observed fail evaluation, as does
completing without an observed acquisition (`BrowserScriptError`), even if a
cookie is present. It does not call `getToken()` automatically. Names such as
`checkForceRefresh` and `forceRefreshToken` are undocumented, unstable
compatibility details—not public adapter options or a universal resolution
contract. `forceRefreshToken` is observed only when the reviewed page calls it. The existing BrowserMock 2-second VM deadline and 5-second whole
handler deadline are unchanged.

This is not a complete HTML/JavaScript engine or browser. The AWS adapter's
static HTML script discovery is bounded and recognizes only a subset of classic
`<script>` elements; ambiguous markup and unsupported attributes/types (including
`async`/`defer`) are not reproduced. This is separate from the limited dynamic
VM script-element support described above. Active `<base>` elements make
static discovery unsupported rather than resolving relative URLs against the
wrong base. Attribute separators use HTML
ASCII whitespace; NBSP in an unquoted value is preserved, not treated as a separator. Inline code runs in a function scope, so lexical declarations are
not shared globals; explicitly assign shared entry points to `window`. Work
that is not awaited ends when evaluation completes, and script/acquisition
failures remain failures rather than clearance. There is no general DOM,
CAPTCHA support, other-provider integration, or native-browser fallback. See
[the AWS WAF source notes](research/aws-waf-integration.md) for the public
AWS documentation links.

The layer preserves raw transport behavior: callers that do not use the
browser subpath continue to control redirects, headers, cookies, and response
handling directly through `TlsSession`.
