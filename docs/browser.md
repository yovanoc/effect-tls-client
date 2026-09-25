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
request. The example accepts `chrome_146`, `chrome_152`, and `chrome_152_PSK`
and maps each profile to its matching Chrome identity. It uses the
platform-neutral `examples/runtime.mjs` loader.

## Session and identity

Create a browser session with `Browser.open` and a `BrowserSessionConfig`:

```ts
import * as Browser from "effect-tls-client/browser";

const browser = yield* Browser.open({
  transport: { profile: "chrome_152_PSK" },
  identity: Browser.Chrome152Identity,
});
```

`Browser.fromSession` wraps an already-scoped `TlsSession` when the application
needs to compose transport setup itself. The existing transport identity is
fixed and cannot be inspected or rewritten here, so create it without a
`Cookie` header and keep it aligned with the supplied browser identity. Both
paths use the supplied identity for fixed headers and header order. Browser
requests also reject manually supplied `Cookie` headers. `browser.get` stamps
XHR/fetch-style headers; `browser.post` can use those headers or navigation-style
headers with `navigation: true`; `browser.navigate` uses document navigation
headers.

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
import { Cookies } from "effect/unstable/http";

yield* browser.transport.setCookies(
  "http://example.test/",
  Cookies.fromSetCookie("consent=yes; Path=/"),
);
```

## Challenge and script boundary

An explicit `x-amzn-waf-action: challenge` response is surfaced as
`page.challenge`. An optional `challengeHandler` can inspect the page body and
return a retry request, or `None` to leave the challenge visible. A
CloudFront `403` is exposed through `page.cloudFrontForbidden`; it is not
reported as a solved challenge.

```ts
import { Effect, Option } from "effect";

const browser = yield* Browser.open(config, {
  challengeHandler: (challenge, context) => {
    // Solve only with an application-owned, externally reviewed integration.
    return Effect.succeedNone;
  },
});
```

`BrowserMock` is an optional process-backed runtime for reviewed challenge
scripts. A fresh VM context exposes `document.cookie`, read-only location data,
a small `navigator` and `console`, and a context-local `performance` with only
monotonic `now()` and numeric `timeOrigin` backed by the runner's real monotonic
clock. It synthesizes no browser fingerprint metrics. The context also provides
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
`BrowserScriptError` and fail evaluation. It does not expose `process`,
filesystem, WebSocket, or general DOM APIs. Network operations
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

```ts
const scriptRuntime = yield* Browser.BrowserMock;
const browser = yield* Browser.open(config, {
  scriptRuntime,
  challengeHandler: (_challenge, context) =>
    Effect.gen(function* () {
      const result = yield* context.evaluate(
        'document.cookie = "clearance=ok; Path=/"; return "ready";',
      );
      return result === "ready"
        ? Option.some({ url: "http://example.test/" })
        : Option.none();
    }),
});
```

The bridge is intentionally small: up to 8 network requests (4 concurrent),
16 KiB per request body, 64 KiB per fetch/XHR response, 1 MiB per
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
timeout, or scope closure. Fetch supports string URLs and string bodies,
same-origin credentials, and normal follow redirects only. Credentials are
sent only when each request hop matches the page origin: cross-origin fetches
remain allowed, but session Authorization, Proxy-Authorization, Jar cookies,
and response Set-Cookie updates are omitted. Fetch modes other than
`same-origin` and XHR `withCredentials = true` reject. XHR is asynchronous and
supports string bodies. Unsupported browser options reject rather than
silently changing their meaning.

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
allocations. The package does not provide an AWS WAF solver or vendor-specific
handler, and a handler must not claim success without verifying the follow-up
response.

The layer preserves raw transport behavior: callers that do not use the
browser subpath continue to control redirects, headers, cookies, and response
handling directly through `TlsSession`.
