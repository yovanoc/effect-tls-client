# Research facts (pre-design), 2026-09-18

Source-derived constraints. No decisions here; see `01-decisions.md`.

## Upstream tls-client (master 34718e1, latest tag v1.16.0)

- CFFI = 6 exports in `cffi_dist/main.go`: `request`, `getCookiesFromSession`, `addCookiesToSession`, `destroySession`, `destroyAll`, `freeMemory(id)`.
  All `char* f(char* json)`; fully blocking (body fully read before return). `freeMemory` takes the response `id` field (pointer registry), not the pointer.
- Sessions: global map; omitted `sessionId` → ephemeral client. Only `proxyUrl`/`followRedirects` mutable after creation; everything else first-write-wins silently.
- Errors: normal response with `status: 0`, `body` = message string. Unknown profile id silently → default (`Chrome_150`).
- Timeout 0 → 30s (no unlimited). Streaming = write-to-file only. Binary = base64 / data-URI.
- Concurrency: exports thread-safe; one session may run concurrent requests; proxy swap races in-flight requests.
- NOT exposed via CFFI: WebSocket (Go API exists since v1.14, `NewWebsocket`, needs `ForceHttp1`), bandwidth tracker, explicit createSession, hooks, unlimited timeout, consumer-side streaming, RootCAs/certs, CloseIdleConnections.
- HTTP/3: profile-ALPN driven + `disableHttp3` / `withProtocolRacing` flags; no `forceHttp3`.
- Prebuilt artifacts: manual `build.sh` (darwin arm64/amd64, linux arm64/armv7, linux-alpine-amd64 musl, linux-ubuntu-amd64 glibc, windows 386/amd64 + xgo matrix). No CI in upstream repo.
- WS CFFI: issue #240 closed, PR #251 (Kiritsu, `6102352`) closed unmerged by author 2026-08-27; owner asked why (receptive). Design = blocking `wsRead` per message, JSON+base64, `freeMemory` per frame, connections not tied to sessions.

## FFI runtimes

- `node:ffi`: Node ≥26.1, default-on ≥26.9, still experimental. Sync only. Callbacks same-thread only. Pointers = bigint.
- `bun:ffi`: "do not rely on it in production". Sync only (oven-sh/bun#5490 open). Pointers = number. Threadsafe JSCallback experimental/void-only.
- koffi 3.3: `fn.async` thread pool (≤4096 in flight). Bun support unofficial (crashed on GC, fixed on Bun main).
- ffi-napi: dead.
- Go c-shared: **dlclose unsupported** (golang/go#11100); each blocking cgo call pins an OS thread; SIGURG preemption; runtime persists for process life.
- Workers are the only portable way to make sync FFI non-blocking on both runtimes (one engine instance per worker).

## Existing prior art (yovanoc)

- `/Users/yovanoc/projects/slicethepie/native/bridge`: custom Go cgo bridge (12 exports: request envelope, wsConnect/Read/Write/Close, destroySession/All, get/resetBandwidth, add/getCookies, freeMemory(ptr)); `{value}|{error}` envelope; explicit createSession; 8 targets; SHA-256 manifests; Go tests with real fhttp servers.
- `/Users/yovanoc/projects/effect-ffi` (npm name `effect-tls-client`, Effect 4.0.0-beta.99): `ffi` (ABI-as-data `FfiLibrarySpec`, Bun/Node direct + worker layers, recovering worker backend), `tls-client` (Schema protocol, lazy session lifecycle, `HttpClient.make` transport via `HttpClientResponse.fromWeb`, `Socket.make` WS), `browser` (BrowserSession). Node worker = `child_process.fork` + IPC + SIGKILL (a sidecar in disguise). Tests use fake `FfiLibrary`, never the real binary.
- slicethepie `src/browser`: BrowserNavigation (HTML-embedded redirects, sec-fetch header forging), DataDome/Verisoul solvers in ShadowRealm/Worker sandboxes, hard-coded Chrome146 fr-FR profile. Legacy NativeRuntime stack now dead code.

## Effect 4 (beta/rc) APIs

- Service idiom: `Context.Service<Self, Shape>()("id", { make? })`; `Context.Reference` for defaults. `Layer.effect` (no `Layer.scoped`), `Effect.acquireRelease`, `Effect.callback`, `Effect.fn`.
- `HttpClient.make((request, url, signal, fiber) => Effect<HttpClientResponse, HttpClientError>)` gives URL build, spans, abort-on-interrupt, GC abort. Layer via `HttpClient.layerMergedContext`.
- `HttpClientResponse`: only constructor is `fromWeb(request, Response)`; otherwise implement interface (2 TypeIds + accessors). Body variants: Empty/Raw/Uint8Array/FormData/Stream.
- `followRedirects`, `withCookiesRef` (flat Ref, no domain matching) are client-level wrappers.
- Socket v4: `{ reader: Effect<Reader, SocketError, Scope>, writer }`, `Reader.pull` batches; custom WS via `WebSocketConstructor` service or `Socket.make`.
- Errors: `Schema.TaggedError` / `Data.TaggedError`; HttpClientError reasons TransportError/EncodeError/InvalidUrlError/StatusCodeError/DecodeError/EmptyBodyError.

## Tooling baseline

- effect-cdp: tsdown ESM multi-entry, changesets + OIDC provenance, oxlint/oxfmt, tsgo, vitest + @effect/vitest, testcontainers integration, dynamic `import()` of platform packages as optional peers.
- jev-pm adds: `@effect/tsgo/oxlint-presets/*`, `Config.schema` + `Redacted`, tsgo VS Code settings. No CI.
- tls-client-node: koffi async, GitHub-releases download w/o checksum, "latest" default, no musl detection, `stop()`→`destroyAll` footgun.

## Effect 4 process API (added after D1)

- `effect/unstable/process/ChildProcess`: `Command` is itself an `Effect<ChildProcessHandle, PlatformError, ChildProcessSpawner | Scope>`; options for stdin/stdout/stderr config and extra fds (`fd3: { type: "output" }`).
- `ChildProcessHandle`: `pid`, `exitCode`, `isRunning`, `kill(options)`, `stdin: Sink<void, Uint8Array>`, `stdout: Stream<Uint8Array>`.
- `ChildProcessSpawner` provided by `@effect/platform-node` `NodeChildProcessSpawner` and `@effect/platform-bun` `BunChildProcessSpawner` (re-export of node-shared impl); included in `NodeServices`/`BunServices`.
