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

An explicit `x-amzn-waf-action: challenge` response is surfaced as
`page.challenge`. An optional `challengeHandler` can inspect the page body and
return a retry request, or `None` to leave the challenge visible. A
CloudFront `403` is exposed through `page.cloudFrontForbidden`; it is not
reported as a solved challenge.

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
`performance` with only
monotonic `now()` and numeric `timeOrigin` backed by the runner's real monotonic
clock. It exposes context-local `URL` and `URLSearchParams` backed by a private,
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

If reviewed source uses `document.loadScript`, await the actual acquisition
operation too, not just asset loading. Assign shared entry points to `window`
globals: evaluated source runs inside an async wrapper, so local declarations
are not shared globals. Unawaited work ends when evaluation completes. The
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

This is not a complete HTML/JavaScript engine or browser. Script discovery is
bounded and recognizes only a subset of classic `<script>` elements; ambiguous
markup and unsupported attributes/types (including `async`/`defer`) are not
reproduced. Active `<base>` elements make discovery unsupported rather than
resolving relative URLs against the wrong base. Attribute separators use HTML
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
