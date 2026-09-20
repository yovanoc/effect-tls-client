# effect-tls-client

Effect-native access to bogdanfinn/tls-client's fingerprinted HTTP(/2/3) and WebSocket capabilities, without a browser.

## Language

**Bridge**:
The Go executable we own that embeds tls-client and speaks our framed protocol over stdio. One Bridge process per JS process by default.
_Avoid_: sidecar, native library, shared library, CFFI, worker

**TlsClient**:
The process-wide service that owns the Bridge and creates sessions. One per Bridge.
_Avoid_: runtime, native runtime, client (unqualified)

**TlsSession**:
A scoped identity: one Go HTTP client with its fixed TLS profile, cookie jar, connection pool and swappable proxy. Lives exactly as long as its Scope.
_Avoid_: client, browser session, connection

**Profile**:
A named upstream TLS/HTTP2 fingerprint preset (e.g. `chrome_146`). A custom spec (JA3 + H2/H3 settings) is a **Custom Profile**.
_Avoid_: identifier, emulation, browser

**Target workloads** (scope note, not a term): survey/anti-bot flows *and* game-client style traffic — many concurrent requests and many long-lived WebSocket connections per process.

**Jar**:
The Go-side RFC 6265 cookie store owned by a TlsSession; the only cookie state that exists. Read/written as Effect `Cookies`.
_Avoid_: cookie store, cookie ref, JS jar

**Identity**:
The stable set of transport-visible traits a session presents on every request and WebSocket handshake: Profile, fixed headers (UA, client hints, device/app headers, accept-language), header order.
_Avoid_: browser profile, runtime profile, fingerprint (unqualified)

**Browser**:
The module that makes a TlsSession behave like a real browser: request-kind header stamping, navigation, and a script sandbox. Depends on the transport, never the reverse.
_Avoid_: headless browser, Chromium, CDP

**Challenge**:
A response that is an anti-bot interstitial rather than the requested resource. A **ChallengeHandler** recognises a Challenge and returns a **Resolution** (state to plant + retry, or a final response) or declines.
_Avoid_: captcha (only one kind of Challenge), block page, solver (that's an implementation of a handler)

**Platform package**:
An optional OS/architecture package that supplies the Bridge executable matching a
release. It is a distribution artifact, not a second transport or client.

**Public fingerprint echo**:
An opt-in external service check that observes the TLS and HTTP/2 traits presented
by a named Profile. It validates a release integration path; it is not a runtime
dependency or an authentication mechanism.
