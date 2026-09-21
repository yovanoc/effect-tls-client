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
  "https://example.com/",
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
import { Effect } from "effect";

const browser = yield* Browser.open(config, {
  challengeHandler: (challenge, context) => {
    // Solve only with an application-owned, externally reviewed integration.
    return Effect.succeedNone;
  },
});
```

`BrowserScriptRuntime` is an optional application-owned seam. `runBoundedScript`
accepts only string source and limits source and result to 64 KiB. Its two-second
script timeout and the five-second challenge-handler timeout request cooperative
Effect interruption; they cannot preempt synchronous code and are not security
or CPU bounds. The package intentionally does not provide a BrowserMock
executor, AWS WAF solver, DataDome implementation, browser engine, or `node:vm`
security sandbox. A challenge handler must not claim success unless its
integration has actually verified the resulting response.

The layer preserves raw transport behavior: callers that do not use the
browser subpath continue to control redirects, headers, cookies, and response
handling directly through `TlsSession`.
