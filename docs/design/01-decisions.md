# Design decisions

Running record from the architecture grilling. Facts backing these are in `00-research-facts.md`.

## D1 — Native boundary: sidecar process, not in-process FFI

**Decision:** The Go bridge (derived from `slicethepie/native/bridge`) is compiled as a plain executable (`CGO_ENABLED=0`) and spawned as a child process. JS talks to it over stdio with length-prefixed frames. No `node:ffi`, no `bun:ffi`, no koffi, no N-API, no `effect-ffi` abstraction.

**Why:** `node:ffi`/`bun:ffi` are sync-only and experimental; the Node worker path already forked a process; upstream CFFI lacks WS/bandwidth/streaming; Go c-shared cannot be unloaded; static Go binaries remove the musl/glibc and cross-C-compiler matrix. Precedent: esbuild (Go) uses the same model.

**Rejected:** A in-process c-shared + workers; C FFI submit + pipe completion; D N-API addon around the Go lib (needs a second native toolchain; Go panics still kill the host).

**Consequences:** framing protocol is ours to design (D2+); crash isolation comes free; per-call cost is an IPC hop (~µs–tens of µs), negligible against network RTT.

## D2 — Wire protocol: binary-framed messages over stdio

**Decision:** Each frame = fixed header (`u32 length, u8 kind, u32 requestId`) + JSON metadata + optional raw body bytes. Request/response metadata is JSON; bodies, response chunks and WebSocket frames are raw bytes (no base64). Multiple frames may share a `requestId` (streaming).

**Why:** streaming and WS become first-class without a second protocol; Go side stays `binary.Read` + `encoding/json`; avoids base64 tax. Rejected: JSON-only envelope (base64 + later chunking protocol), `@effect/rpc` wire format (no Go implementation, unstable across betas).

**Fact used:** Effect 4 ships `effect/unstable/process` (`ChildProcess.make`, `ChildProcessSpawner` service; handle exposes `stdin: Sink`, `stdout: Stream`, `kill`, `exitCode`, extra `fd3+`), implemented by `NodeChildProcessSpawner`/`BunChildProcessSpawner` (shared code). Spawning through it makes the library runtime-agnostic without dynamic platform imports.

## D3 — Bridge lifecycle: scoped resource, fail-fast on crash, no respawn

**Decision:** `Bridge` is acquired in a `Layer.effect` via `ChildProcess` (scope close → graceful shutdown frame, then `kill`). Unexpected exit fails every in-flight and future call with `BridgeExited { exitCode, signal, stderrTail }`; the service is permanently dead. No transparent respawn, no session replay. Resilience is composed by the caller.

**Why:** a crash destroys native cookie jars/connections; respawning hides that as a later `SessionNotFound`. The old recovering backend existed only to SIGKILL hung sync FFI calls; cancel frames + Go contexts remove that failure mode.

## D4 — Public nouns: `TlsClient` Service, `TlsSession` scoped value, Bridge internal

**Decision:**
- `TlsClient` (Service, one per Bridge): `session(config): Effect<TlsSession, _, Scope>`, sessionless `request`, bandwidth ops.
- `TlsSession` (scoped value, not a Service by default): `request`, `cookies`/`addCookies`, `setProxy`, `webSocket`, `id`. Released → `destroySession`.
- Helpers: `TlsSession.layer(config)`, `TlsHttpClient.layer(config)`, `TlsHttpClient.fromSession(session)`.
- `Bridge` is internal.

**Config tiers:** session-fixed = profile/custom TLS spec, default timeout, TLS flags, H1/H3 flags, transport options, local address, SNI override, cert pinning, cookie-jar mode, redirect + header-order defaults. Session-mutable = proxy only. Per-request = URL, method, headers, header order, body, timeout, redirect override, response mode, request cookies, host override.

**Why:** mirrors what the Go client actually honours (fixed at construction; proxy swappable); scope = lifetime makes leaks impossible; multi-identity apps stay trivial. Rejected: session-as-Layer-only (N layers for N identities); everything-per-request (lies about first-write-wins).

## D5 — Response bodies: streamed on the wire, buffered conveniences on top

**Decision:** Wire = `headers` frame → N `chunk` frames → `end` | `error` frame per requestId; a `cancel` frame from JS closes the Go body mid-stream. `TlsResponse` exposes `stream: Stream<Uint8Array>` plus cached `bytes`/`text`/`json` (Effect.cached). `HttpClientResponse.stream` maps 1:1; interrupting body consumption sends `cancel`. A response registers scoped cleanup and exposes `close` so an abandoned stream cannot leave a Go operation pending. Chunk size configurable, default 64 KiB.

**Why:** buffered-only would make `HttpClient.stream` a lie and keep upstream's read-everything-first behaviour; streamed-only taxes the 90 % text/json case. Cost of the conveniences ≈ 20 lines.

## D6 — Streamed uploads and Go-side cancellation

**Decision:** Request bodies stream: `request` frame (metadata + headers) → N `body-chunk` frames → `body-end`; Go feeds an `io.Pipe` into `Do`. `HttpBody.Stream` maps 1:1; bytes/FormData are a single chunk. Every in-flight op (connect, headers, body, upload, WS read) is cancellable by a `cancel` frame → Go `context.CancelFunc`. **Go always sends the terminal frame** (`end` | `error{kind:"cancelled"|...}`); JS only closes a pending entry itself on `BridgeExited`.

**Why:** target workloads are not only slicethepie — game clients with many requests and long-lived WS connections. Symmetric streaming keeps one wire model; JS-only cancel could not interrupt a hung WS read or slow server.

## D7 — WebSocket mapping and credit-based flow control

**Decision:** `session.webSocket(url, opts): Effect<Socket.Socket, SocketError, Scope>`. Go dials with the session's profile/proxy/jar (`tls_client.NewWebsocket`), owns ping/pong; frames are pushed as `ws-frame {connId, opcode}` + raw bytes; JS builds `Socket.make({ reader, writer })` over a per-connection Queue; text/binary preserved; close → `SocketCloseError{code, reason}`; scope close → `ws-close`. Flow control: per-connection (and per-response) credit window, default 1 MiB; JS sends `ack {id, bytes}` as it consumes; Go stops reading when unacked > window so TCP back-pressures the remote.

**Why:** one shared stdio pipe; without credits a chatty socket or a huge download starves everything and unbounded queues have no ceiling. Rejected: no flow control; one pipe per connection (fd management, Windows).
`ponytail:` single shared pipe — move hot connections to extra fds only if HOL blocking shows in profiling.

## D8 — Bridge distribution: per-platform npm packages as optionalDependencies

**Decision:** `@effect-tls-client/bridge-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}` (static Go executables, `CGO_ENABLED=0`, ~15 MB each) listed as `optionalDependencies` of the main package; resolved via `createRequire(import.meta.url).resolve(...)`; `TLS_CLIENT_BRIDGE_PATH` Config override for custom builds. All packages share the main package version exactly and are published together; mismatch → `BridgeVersionMismatch`. Upstream tls-client version is a Go module pin, exposed for diagnostics only (`TlsClient.version`), not part of our semver. No postinstall, no runtime download, no checksum code.

**Why:** npm's integrity + provenance cover supply chain; offline/CI/pnpm/monorepo work; zero networking code in the library. Rejected: download-on-first-use (network at runtime, cache/lock/retry code); both.

## D9 — Errors: small typed set, classified in Go

**Decision:** Bridge maps Go errors (`errors.As` on net/tls/proxy/context errors) to a closed `kind` on the `error` frame. JS decodes into `Schema.TaggedError` classes:
- `BridgeExited{exitCode, signal, stderrTail}`, `BridgeVersionMismatch`, `BridgeProtocolError`, `BridgeSpawnError`
- `TlsRequestError{ kind: InvalidConfig|InvalidUrl|Dns|Connect|Tls|Proxy|Timeout|Cancelled|Http|Body|Pinning|Unknown, message, cause? }` + `isTransient` predicate for `Effect.retry`
- `SessionNotFound{sessionId}`, `SessionConfigError{message}`
- `TlsWebSocketError{ kind: Handshake|Read|Write|Closed{code,reason} }` → mapped onto `SocketError` reasons
`HttpClientError.TransportError{cause: TlsRequestError}` wraps for the HttpClient projection.

**Why:** typed errors exist only on the Go side; one request-error class with a closed union gives exhaustive `Match` without a class-per-error zoo. Rejected: single string error (regex classification); impit-style 30-class hierarchy.

## D10 — Cookies: Go jar is the single source of truth, exchanged as `Cookies.Cookies`

**Decision:** `TlsSession.cookies(url)` / `setCookies(url, Cookies.Cookies)` read/write the Go jar using Effect's `Cookies` type. `TlsResponse.cookies` = that response's `Set-Cookie` headers only (matches Effect responses). `exportCookies`/`importCookies` (Schema JSON) for cross-process persistence. No JS jar, no `withCookiesRef`. User-supplied `Cookie` headers pass through (upstream merges), documented as discouraged.

**Why:** requests, in-Go redirects and WS handshakes must share one jar; two jars fighting is a known DataDome failure mode. Rejected: mirrored JS jar (tough-cookie); JS-only jar without domain/path semantics.

## D11 — Profiles: open string validated in Go, generated advisory union and custom-profile schema

**Decision:** `profile: string` (`Profile.Known | (string & {})` for autocomplete). Bridge validates against the embedded `MappedTLSClients` and fails with `SessionConfigError` on unknown names — no silent fallback to Chrome_150. `Profile.Known` and the `CustomProfile` `Schema.Struct` (mirror of `customTlsClient`) are **generated** from the pinned Go module in CI (effect-cdp codegen pattern). Go rejects unknown H2/H3 setting names instead of skipping. UA / client-hints / header order are not part of Profile.

**Why:** upstream adds profiles every few weeks; a closed TS union makes each one a release. Two silent upstream fallbacks become typed errors.

## D12 — `TlsHttpClient`: behaves like other Effect HttpClients

**Decision:** Built with `HttpClient.make` + hand-implemented `HttpClientResponse` (D5 stream, cached bytes/text/json, `cookies` from Set-Cookie, `remoteAddress: none`). Projection requests always use `followRedirects: false`; users compose `HttpClient.followRedirects(n)` as with Node/Fetch clients (Jar still updates per hop in Go). Per-request tls-client knobs (timeout, header order, response mode, host override) come from a `TlsHttpClient.RequestOptions` `Context.Reference` read via `fiber.getRef`, like `FetchHttpClient.RequestInit`. Header order = insertion order of `request.headers` unless overridden. Body variants map to D6 (Stream → chunks; bytes/FormData → one chunk). `signal` → `cancel` frame.

**Why:** a drop-in `HttpClient` must not diverge on redirect semantics; Reference is the platform's own escape-hatch idiom. Go-side redirects remain available on `TlsSession.request`.

## D13 — Scope includes browser semantics (staged), Identity lives in the transport

**Decision:** Target clients (incl. mobile game clients) must behave like a real browser, so the repo ships, as a separate `browser` module built strictly on top of the transport: request-kind header stamping (navigation/xhr, `sec-fetch-*`, referer chain), navigation semantics (Location + HTML-embedded redirects, hop limits), and a script sandbox for vendor JS against a mocked environment. **Identity** (profile + fixed headers + header order) is transport-level session config because WS handshakes and raw requests need it too. Staging: transport first, browser module second; browser-module design is grilled separately after the transport architecture is fixed.

**Why:** all four capabilities are required by more than one consumer (slicethepie + game clients). Dependency direction is one-way: `browser → tls-client → bridge`; nothing in the transport knows about browsers. WS requires a session (no sessionless WS).

## D14 — Challenge handling: hook in the core, handlers as importable optional subpaths

**Decision:** `ChallengeHandler` service: `(response, ctx) => Effect<Option<Resolution>>` (Resolution = cookies/headers to plant + retry, or a final response). Navigation consults it before treating a response as terminal. Handlers compose in order (first `Some` wins), e.g. `[datadome, capsolver]` = own logic first, paid fallback second. All handlers live in the repo as **optional subpaths**, never in the core entrypoint:
- `effect-tls-client/challenges/datadome`, `/verisoul`, … — vendor-JS handlers, marked `@experimental`, **excluded from semver** (may break on any vendor deploy), tested against recorded fixtures only.
- `effect-tls-client/challenges/capsolver` (and similar) — API-backed handlers: a Layer configured via `Config` (`Redacted` API key), calling the solver through whatever `HttpClient` is provided.
`examples/` contains wiring only, no solver logic.

**Why:** importable beats copy-paste; the generic positioning is preserved by keeping handlers out of the core module and out of semver, not by hiding the code.

## D15 — Telemetry: per-request bandwidth on the wire, Effect Metrics, span attributes

**Decision:** `end` frame carries `{ protocol, bytesRead, bytesWritten }` (Go tracker delta per request). `TlsResponse.protocol`; `TlsSession.bandwidth`/`resetBandwidth` pull totals. Library publishes `Metric`s: counters `tls_client.bytes.read|written`, `tls_client.requests` (labels `profile`, `protocol`, `error_kind`), gauges `tls_client.sessions.active`, `tls_client.ws.connections.active`. Never label by sessionId. Transport annotates the existing `HttpClient.make` span with `tls_client.protocol|profile|session`.

**Why:** exact per-request bandwidth without polling; metrics derive from frames already observed; low-cardinality labels only.

## D16 — Runtimes, Effect version, test tiers

**Decision:** Node ≥ 22 and Bun current, both first-class; the package has no runtime-specific code (needs only `ChildProcessSpawner` from the user's `NodeServices`/`BunServices`). Effect: track the newest 4.0 pre-release channel — currently the `rc` dist-tag (`effect@4.0.0-rc.116`, `beta` tag is the older 107 line) — peer range `>=4.0.0-rc.116 || >=4.0.0`. Tests: (1) Go `go test -race` against local httptest servers (codec, dispatcher, streaming, cancel, WS, flow control); (2) TS `@effect/vitest` unit against an in-process fake Bridge (Sink/Stream pair speaking the protocol); (3) TS integration (opt-in, CI after Go build on 5 targets): real Bridge + local Effect HttpServer/TLS server, env-gated smoke against a public fingerprint echo.

**Why:** FFI removal leaves no reason for runtime asymmetry; fake-Bridge tier gives fast iteration, Go tier owns protocol correctness, network stays opt-in.

## D17 — Repo layout and release pipeline

**Decision:** Single repo, Bun workspace + **Turborepo 2.11** task graph (native Go workspace support via `go.work`, experimental future flag). Layout:
```text
packages/effect-tls-client/      TS library (entrypoints: ., ./browser, ./challenges/*)
packages/bridge-<platform>/      5 stub npm packages (package.json with os/cpu; binary dropped in by CI build task)
bridge/                          Go module (go.work member): frame loop, dispatcher, store, websocket, codegen dump
examples/
```
Turbo tasks: `bridge#build/test/vet` (Go), `bridge-*#build` dependsOn `bridge#build` (cross-compile per target), `effect-tls-client#codegen` dependsOn `bridge#build` (Profile.Known / CustomProfile schema), `effect-tls-client#build/test/check` dependsOn codegen; CI fails on stale generated files. Release: changesets + `changesets/action` on `main`, `fixed: [["effect-tls-client", "@effect-tls-client/*"]]`, OIDC provenance, publishes all six packages together. Go pin bumps via Renovate on `bridge/go.mod` → codegen PR check.

**Why:** effect-cdp's proven flow + one Go matrix job; turbo gives cross-language `dependsOn`, affectedness and remote caching for the Go builds. Rejected: esbuild-style `npm/` stub dir + custom version-sync script; tag-driven release.

## D18 — Protocol implementation: hand-rolled header, Effect Schema for meta, golden fixtures for conformance

**Decision:** Frame header encoded/decoded by hand (TS `DataView`, Go `encoding/binary`). Meta JSON validated on the TS side with Effect `Schema` (per-kind structs, `Schema.fromJsonString`, failure → `BridgeProtocolError`); the same schemas serve as public config types. Go uses plain structs with `json` tags, ignoring unknown fields. Conformance = golden frames in `bridge/testdata/protocol/` produced by Go tests and decoded/re-encoded byte-identically by TS tests (and vice versa). No meta codegen until drift is observed; `SchemaBinary`/`@effect/rpc` serialization rejected (no Go implementation).
