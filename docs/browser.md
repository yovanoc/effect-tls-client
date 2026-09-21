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
plus the small HTML redirect patterns used by the reference browser. Referrers
use strict-origin-when-cross-origin behavior: same-origin URLs keep their path
and query after credentials and fragments are removed, cross-origin requests
send only the origin, and HTTPS-to-HTTP downgrades send no referrer.
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
scripts. It adds only `document.cookie`, a read-only `location.href`, a small
`navigator`, `console`, and `Promise` to a fresh VM context. URL constructors,
encoding/timer primitives, `fetch`, XHR, WebSocket, DOM constructors,
filesystem, and process APIs are intentionally absent; network work stays in
the host `TlsSession`:

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

The runtime starts a fresh child process for each evaluation and kills it on the
bounded timeout. It always starts Node with `--permission` and verifies that
its permission API reports `process.permission.has("net") === false` before
reading the script. This requires a modern Node release with network permission
support (Node 25+ currently); Node 22's stable permission model does not deny
network access and is rejected. Older or incompatible executables fail closed
rather than falling back to the older experimental flag.
A Bun host delegates to an available Node executable; configure
`BrowserMock.layer({ executable: "..." })` when `node` is not on `PATH`.

Script cookie reads and writes cross the `cookies.script` Bridge operation. Go
filters `HttpOnly` cookies using the request URL and applies raw script writes
under the authoritative Jar lock, ignoring `HttpOnly` writes and exact
name/domain/path overwrites of existing `HttpOnly` cookies. The browser layer
therefore does not export, mirror, or re-import cookie state. This is not a
malicious-code sandbox: Node's permission model has documented limitations, and
`node:vm` is only the evaluator context, never the security boundary. Run
reviewed vendor scripts only; do not pass arbitrary attacker-controlled source.
There is no guaranteed child memory cap; source/output limits and the timeout do
not bound allocations. `runBoundedScript` still limits source/result to 64 KiB,
and the five-second challenge-handler timeout remains cooperative. The package
does not provide an AWS WAF solver or vendor-specific handler, and a handler
must not claim success without verifying the follow-up response.

The layer preserves raw transport behavior: callers that do not use the
browser subpath continue to control redirects, headers, cookies, and response
handling directly through `TlsSession`.
