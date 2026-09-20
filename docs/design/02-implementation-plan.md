# Implementation plan — transport (D1–D12, D15–D17)

Staged so every stage leaves a runnable check behind. Browser module (D13/D14) is a later round.
Shared contract for parallel Go/TS work: the protocol spec (Stage 1 artifact `03-protocol.md`).

## Stage 0 — Scaffold

- Bun workspace + Turborepo 2.11 (`go.work`, Go future flag). `packages/effect-tls-client`, `packages/bridge-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}` stubs (`os`/`cpu`, empty `bin/`), `bridge/` Go module (go 1.24, tls-client pin), `examples/`.
- Tooling copied from effect-cdp: tsgo + `effect-tsgo patch`, nodenext tsconfig, tsdown ESM multi-entry, oxlint (`@effect/tsgo/oxlint-presets/*`, type-aware), oxfmt, vitest + `@effect/vitest`, changesets (`fixed` group over all six packages), `.github/workflows/ci.yml` (lint/fmt/typecheck/test + `go vet`/`go test -race`), `release.yml` (changesets/action, OIDC provenance).
- Effect peer: `>=4.0.0-rc.116 || >=4.0.0`; `@effect/platform-node`/`-bun` devDeps only.
- **Check:** `turbo run build test lint format` green with placeholder packages; `go test ./...` runs.

## Stage 1 — Protocol + Bridge transport (no tls-client calls yet)

- `docs/design/03-protocol.md`: frame header `[u32 len][u8 kind][u32 id]`, kinds, JSON meta schemas per kind, terminal-frame rule, cancel/ack semantics, version handshake (`hello{protocolVersion, bridgeVersion, tlsClientVersion}`), shutdown.
- Go `bridge/protocol`: frame reader/writer, single-writer goroutine; `bridge/main.go` loop: read → dispatch (goroutine per op, `context` per id, cancel map) → write. Test-only ops `ping`, `sleep`, `stream-n` (emit n chunks honouring credits).
- TS `internal/Frame.ts` (encode; `Stream<Uint8Array> → Stream<Frame>`), `internal/BridgeBinary.ts` (optionalDependency resolve, `TLS_CLIENT_BRIDGE_PATH` Config, version match), `internal/Bridge.ts` (Service; `Layer.effect` acquiring `ChildProcess`; handshake; pending map; `call`/`stream`; `Effect.onInterrupt → cancel`; credit `ack`s; stderr ring buffer; `BridgeExited` fan-out; graceful `shutdown` then `kill` on scope close).
- `test/FakeBridge.ts`: in-memory Sink/Stream pair speaking the protocol, scriptable replies.
- **Check:** Go codec round-trip + fuzz; TS codec round-trip (fast-check via `effect/FastCheck`); against real binary: `ping` ok, interrupt of `sleep` yields Go-sent `error{Cancelled}`, `stream-n` with tiny window stalls until acks, `kill -9` → every pending call fails `BridgeExited` and the layer is dead.

## Stage 2 — Sessions and requests (streaming from day one)

- Go: session store (port from slicethepie bridge: per-session client + Jar + bandwidth tracker), `session.create` with strict validation (profile ∈ `MappedTLSClients`, H2/H3 setting names, upstream config errors → `SessionConfigError`), `session.destroy`, `request`: `io.Pipe` upload from `body-chunk`s, `headers` frame, chunked body out (64 KiB default, credits), `end{protocol, bytesRead, bytesWritten}`, error classification (`errors.As` → kind).
- TS: `TlsClient` (Service: `session`, sessionless `request`, `version`), `TlsSession` (scoped value), `TlsResponse` (stream + cached bytes/text/json, `cookies` from Set-Cookie, `protocol`, `url`), schemas `SessionConfig` (tiers per D4, `Identity` embedded), `RequestOptions`, errors (D9), `TlsRequestError.isTransient`.
- **Check:** Go tests vs `httptest` h1/h2 TLS servers (bodies, upload, cancel mid-body, config errors). TS unit vs FakeBridge (decode, caching, interruption → cancel). TS integration vs local Effect `HttpServer`: GET/POST/stream/upload/cancel; unknown profile → `SessionConfigError`; session scope close → `destroySession` observed.

## Stage 3 — Cookies, proxy, bandwidth, metrics

- Ops: `cookies.get/set` (↔ `Cookies.Cookies`), `cookies.export/import` (Schema JSON), `proxy.set`, `bandwidth.get/reset`.
- Metrics (`tls_client.bytes.read|written`, `tls_client.requests{profile,protocol,error_kind}`, gauges sessions/ws active) updated from frames; span attributes on the current span.
- **Check:** Go cookie path/domain tests (port existing); TS: set → request carries cookie → response Set-Cookie visible in `cookies(url)`; export/import round-trip; metrics snapshot assertions with `Metric` test helpers.

## Stage 4 — WebSocket + flow control

- Go: `ws.connect` (session dialer, `ForceHttp1`, Identity headers + order, Jar), read loop pushing `ws-frame{opcode}` under per-connection credit window, `ws.write`, `ws.close`, ping/pong internal; connection removed on error; `destroySession` closes its sockets.
- TS: `session.webSocket(url, opts): Effect<Socket, SocketError, Scope>` via `Socket.make({reader, writer})` over a per-connection `Queue`; `ack` on pull; close → `SocketCloseError`; `TlsWebSocketError` mapping.
- **Check:** Go echo/deadline/close tests (port existing); TS integration vs local `ws` echo server: text+binary round-trip, 10k-message burst with 64 KiB window stays bounded (queue size assertion), scope close sends `ws-close`, server close → `SocketCloseError{code}`.

## Stage 5 — `TlsHttpClient`

- `HttpClient.make` transport: body variants → D6 frames, `signal → cancel`, `followRedirects:false` always, `TlsHttpClient.RequestOptions` `Context.Reference`, hand-implemented `HttpClientResponse` (both TypeIds, stream/arrayBuffer/text/json/formData/urlParamsBody cached, `DecodeError` mapping, `remoteAddress: none`), `TlsHttpClient.layer(config)` / `fromSession(session)` via `HttpClient.layerMergedContext`.
- **Check:** run the same matrix Effect uses for Node transports (`HttpServer.layerTestClient`): redirects via `HttpClient.followRedirects`, `/hang` + `Effect.timeout` aborts (cancel frame observed), early stream close aborts, `EncodeError` from failing body stream; `client.get(url).pipe(HttpClientResponse.schemaBodyJson(...))` works unchanged.

## Stage 6 — Codegen, distribution, release

- Go subcommand `bridge dump` → JSON (profiles, `customTlsClient` field list, H2/H3 setting names, kinds) → `scripts/codegen.ts` writes `src/generated/Profile.ts` (`Known` union) and `CustomProfile.ts` schema; `codegen:check` fails on drift (turbo task dependsOn `bridge#build`).
- Turbo tasks: `bridge-*#build` cross-compiles (`GOOS/GOARCH`, `CGO_ENABLED=0`, `-trimpath -ldflags=-s -w -X main.version=...`) into each stub's `bin/`; version stamp = package version; TS handshake enforces equality.
- Release: changesets fixed group; `release.yml` builds 5 binaries, publishes six packages with provenance. Renovate for `bridge/go.mod` (+ codegen check catches new profiles).
- README (Node + Bun install, `HttpClient` swap-in, sessions, cookies/proxies,
  WebSockets, errors/retry, telemetry, Bridge paths, and versioning), runnable
  `examples/basic-request.mjs`, `examples/http-client.mjs`, and
  `examples/websocket.mjs`.
- **Check:** `npm pack` of each stub contains exactly one binary; fresh `bun add
  effect-tls-client` in a temp project on macOS runs the basic example; CI runs
  Stage 2/4/5 integration on the required native targets (darwin-arm64,
  linux-x64, win32-x64) and attempts darwin-x64/linux-arm64 when hosted runner
  labels are available, using the built binary.

## Stage 7 — Browser module (separate grilling round first)

Identity header stamping by request kind, navigation, sandbox, `ChallengeHandler` + `challenges/*` subpaths.

## Lanes (if delegated)

- **Go lane** (Stages 1–4 Go side) and **TS lane** (Stages 1–5 TS side) run in parallel after `03-protocol.md` is agreed; FakeBridge decouples TS from the binary until integration.
- **Tooling lane** (Stage 0 + 6) independent.
- Owned paths: `bridge/**` vs `packages/effect-tls-client/**` vs root/CI files; no cross-editing; the protocol doc is the only shared file and changes to it are reviewed by both lanes.
