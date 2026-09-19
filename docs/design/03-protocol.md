# Bridge protocol v1

Contract between the TS library and the Go Bridge executable. Both sides implement exactly this; changes bump `protocolVersion`. Binary, framed, multiplexed on one stdio pair (JS→Go on Bridge stdin, Go→JS on Bridge stdout). stderr is free-form logs; JS keeps the last 4 KiB for `BridgeExited.stderrTail`.

## 1. Frame

```text
┌─────────┬──────┬────────┬──────────┬──────────────┬──────────────┐
│ u32 len │ u8   │ u32 id │ u32 mlen │ meta (mlen)  │ body (rest)  │
│         │ kind │        │          │ UTF-8 JSON   │ raw bytes    │
└─────────┴──────┴────────┴──────────┴──────────────┴──────────────┘
```

- Big-endian. `len` = bytes after the length field (kind + id + mlen + meta + body). Max `len` = 16 MiB; larger → receiver fails the connection with `Protocol`.
- `meta` may be empty (`mlen = 0`). `body` present only for kinds marked *body* below.
- `id`: **allocated by JS** (u32, monotonic, skips 0; wraps). One id = one *op*. Long-lived ops (request, ws) keep their id for their whole life. `id = 0` is reserved for `hello`/`shutdown`.
- Go writes frames from a single writer goroutine; JS writes through one `Sink`. Frame boundaries are the only atomicity guarantee.

## 2. Kinds

JS → Go

| kind | name | meta | body | terminal reply |
|---|---|---|---|---|
| 0x01 | `hello` | `{ protocolVersion: 1, clientVersion, window, chunkSize }` | – | `helloAck` |
| 0x02 | `shutdown` | `{}` | – | `ok`, then process exit 0 |
| 0x10 | `session.create` | `SessionConfig` (§5) | – | `ok {}` |
| 0x11 | `session.destroy` | `{ sessionId }` | – | `ok {}` |
| 0x12 | `session.proxy` | `{ sessionId, proxyUrl: string \| null }` | – | `ok {}` |
| 0x13 | `cookies.get` | `{ sessionId, url }` | – | `ok { cookies: Cookie[] }` |
| 0x14 | `cookies.set` | `{ sessionId, url, cookies: Cookie[] }` | – | `ok {}` |
| 0x15 | `cookies.export` | `{ sessionId }` | – | `ok { cookies: Cookie[] }` (all, with domain/path) |
| 0x16 | `cookies.import` | `{ sessionId, cookies: Cookie[] }` | – | `ok {}` |
| 0x17 | `bandwidth.get` | `{ sessionId? }` (absent = process total) | – | `ok { read, written }` |
| 0x18 | `bandwidth.reset` | `{ sessionId? }` | – | `ok {}` |
| 0x20 | `request` | `RequestMeta` (§6) | – | `end` \| `error` |
| 0x21 | `body.chunk` | `{}` | ✔ | – (part of the `request` op) |
| 0x22 | `body.end` | `{}` | – | – |
| 0x30 | `ws.connect` | `WsConnectMeta` (§7) | – | `ws.closed` \| `error` |
| 0x31 | `ws.write` | `{ opcode: 1 \| 2 }` | ✔ | – |
| 0x32 | `ws.close` | `{ code?, reason? }` | – | – (→ `ws.closed`) |
| 0x40 | `cancel` | `{}` | – | – (target op emits `error{Cancelled}`) |
| 0x41 | `ack` | `{ bytes }` | – | – |
| 0xF0 | `debug.ping` | `{}` | – | `ok {}` |
| 0xF1 | `debug.sleep` | `{ ms }` | – | `ok {}` (cancellable) |
| 0xF2 | `debug.stream` | `{ chunks, size }` | – | `chunk`×n, `end` (honours credits) |

`debug.stream` is the protocol-only credit test: it requests `chunks` logical chunks of
`size` bytes. A logical chunk larger than `chunkSize` is split into multiple raw
`chunk` frames. The emitted bytes are the increasing byte sequence starting at `0`
(modulo 256), so order and total length are observable. Its `end` has
`bytesRead = chunks * size` and `bytesWritten = 0`.

Go → JS

| kind | name | meta | body | role |
|---|---|---|---|---|
| 0x80 | `helloAck` | `{ protocolVersion, bridgeVersion, tlsClientVersion, goVersion, window?, chunkSize? }` | – | terminal for `hello` |
| 0x81 | `ok` | result JSON | – | terminal |
| 0x82 | `error` | `ErrorMeta` (§8) | – | terminal |
| 0x90 | `headers` | `ResponseHeadersMeta` (§6) | – | – |
| 0x91 | `chunk` | `{}` | ✔ | credited |
| 0x92 | `end` | `{ bytesRead, bytesWritten }` | – | terminal for `request` / `debug.stream` |
| 0xA0 | `ws.open` | `{ status, headers: Pair[] }` | – | – |
| 0xA1 | `ws.frame` | `{ opcode: 1 \| 2 }` | ✔ | credited |
| 0xA2 | `ws.closed` | `{ code, reason, initiator: "local" \| "remote" }` | – | terminal for `ws.connect` |
| 0xC1 | `body.ack` | `{ bytes }` | – | credits for JS→Go body chunks |

## 3. Invariants

1. **Every op ends with exactly one terminal frame, always sent by Go** (`ok`, `error`, `end`, `ws.closed`, `helloAck`). JS never closes a pending op itself except when the process exits (`BridgeExited`).
2. After the terminal frame Go sends nothing more for that id; frames for unknown/finished ids are dropped by both sides (late `cancel`/`ack` are no-ops).
3. `cancel` on a live op → Go cancels its `context`, cleans up, sends `error{kind:"Cancelled"}`. If the op already completed, nothing happens.
4. A malformed `cancel` or `ack` for a live id is a connection-level protocol failure: Go emits no error frame for that id and exits with status 2 after cleanup, so the live operation can still emit only its own terminal frame. Unknown or finished `cancel`/`ack` frames are no-ops, including malformed metadata. A start frame that reuses an active id is handled the same way; it never emits a second terminal frame for the owned operation.
5. Frame order within an id is significant; across ids there is no ordering guarantee.
6. **Credits.** `window` (from `hello`, default 1 MiB) is the per-id budget for credited kinds (`chunk`, `ws.frame` Go→JS; `body.chunk` JS→Go). `helloAck` repeats the negotiated positive `window` and `chunkSize`; older peers may omit those additive fields, in which case the hello values (or defaults) remain in force. The producer stops when `sent − acked ≥ window` and resumes on `ack{bytes}`. A consumer acks bytes it has handed to its consumer, not bytes received. Credit is per id, never shared; an acknowledgement cannot create more credit than the id has sent.
7. All body chunks are ≤ `chunkSize` (from `hello`, default 64 KiB); the last chunk may be smaller; zero-length chunks are not sent.
8. Bodies are raw bytes end to end. No base64 anywhere.
9. Go exits when stdin reaches EOF (after best-effort session/socket cleanup). JS scope close = `shutdown` → wait ≤ 2 s for `ok`/exit → `kill`.
10. JS fails the handshake with `BridgeVersionMismatch` unless `bridgeVersion === clientVersion` and `protocolVersion === 1`.

## 4. Common types

```ts
type Pair = [name: string, value: string]          // ordered; repeated names allowed
type Cookie = {
  name: string; value: string; domain: string; path: string
  expires: number | null   // unix seconds; null = session cookie
  secure: boolean; httpOnly: boolean
  sameSite?: "Strict" | "Lax" | "None"
}
```

## 5. `SessionConfig` (meta of `session.create`)

Exactly one of `profile` or `customProfile` is required; omitting both is a `SessionConfig` error.

```ts
{
  sessionId: string                       // chosen by JS (uuid)
  profile?: string                        // must exist in MappedTLSClients → else SessionConfig error
  customProfile?: CustomProfile           // generated schema; mutually exclusive with profile
  identity?: { headers: Pair[]; headerOrder?: string[] }   // defaults merged under request headers, used by ws handshakes
  timeoutMs?: number                      // default 30000; 0 = no timeout
  followRedirects?: boolean               // default false
  proxyUrl?: string
  insecureSkipVerify?, randomTlsExtensionOrder?, disableSessionTickets?,
  forceHttp1?, disableHttp3?, protocolRacing?, disableIpv4?, disableIpv6?: boolean
  localAddress?: string; serverName?: string
  certificatePins?: Record<string, string[]>
  cookieJar?: "default" | "strict" | "none"   // strict = tls_client.NewCookieJar semantics
  transport?: { idleConnTimeoutMs?, maxIdleConns?, maxIdleConnsPerHost?, maxConnsPerHost?,
                maxResponseHeaderBytes?, writeBufferSize?, readBufferSize?, disableKeepAlives?, disableCompression? }
}
```
Go validates strictly: exactly one of `profile`/`customProfile`, unknown profile, unknown H2/H3 setting names, ipv4+ipv6 both disabled, pins+skipVerify, racing+forceHttp1/disableHttp3 → `error{kind:"SessionConfig"}`. Sessions are immutable except `session.proxy`.

## 6. Request / response

`RequestMeta`:
```ts
{
  sessionId?: string                      // absent → ephemeral client built from `config`
  config?: SessionConfig                  // only when sessionId is absent
  url: string; method: string
  headers: Pair[]                         // merged over identity.headers; order = array order
  headerOrder?: string[]                  // overrides identity.headerOrder
  hasBody: boolean                        // true → Go waits for body.chunk* + body.end (io.Pipe into Do)
  contentLength?: number                  // known body length; omitted for an unknown stream
  timeoutMs?: number                      // per-request override; 0 = no timeout
  followRedirects?: boolean               // per-request override
  hostOverride?: string
  cookies?: Cookie[]                      // added to the Jar for this URL before sending
}
```
Sequence: `request` → (`body.chunk`* → `body.end` if `hasBody`) … Go: `headers` → `chunk`* → `end`. `body.end` is sent only after the body producer completes; it is never inferred from response completion. If Go receives response headers before `body.end`, it closes the upload pipe with an explicit `request upload aborted after response headers` error, and the TS pump stops without sending `body.end`. The accepted response is still delivered and may finish with `end`; that response terminal frame does not claim that the upload completed. An upload producer failure before response headers sends `cancel` for Go cleanup, but the pending request reports the original `error{kind:"Body"}`.

`contentLength` is the normalized request length. TS derives it for bytes, strings, and `FormData`, and validates any explicit `Content-Length` header against it; Go validates the value, sets the request's `ContentLength`, and removes the header before handing the request to the transport. Unknown-length streams omit it unless the caller supplies a valid matching header. `cookies` are inserted into the target session's Go Jar for this URL immediately before the request; they therefore persist in a named session and are scoped to the one ephemeral client for sessionless requests. They are not a replacement for an explicit `Cookie` header.

`ResponseHeadersMeta`:
```ts
{ status: number; url: string /* final, hash stripped */; headers: Pair[]; protocol: "HTTP/1.1" | "HTTP/2.0" | "HTTP/3.0" }
```
The response `headers` pairs are emitted in deterministic order from the available fhttp response representation; this does not guarantee wire order.

`end` meta: `{ protocol?: ResponseProtocol, bytesRead, bytesWritten }` — the bandwidth-tracker delta for this request (TLS-level bytes); `protocol` repeats the response protocol and is omitted for protocol-only streams. The pinned tls-client tracker exposes session-client totals rather than per-request counters, so the Bridge serializes requests sharing a client from `Do` through body EOF while taking this delta. Connection pooling is retained; requests using the same client are consequently serialized for accounting.

## 7. WebSocket

`WsConnectMeta`:
```ts
{ sessionId: string; url: string; headers: Pair[]; headerOrder?: string[]
  subprotocols?: string[]; handshakeTimeoutMs?: number; readBufferSize?: number; writeBufferSize?: number }
```
Sequence: `ws.connect` → `ws.open` → `ws.frame`* (credited) interleaved with JS `ws.write`* → terminal `ws.closed` (after JS `ws.close`, remote close, or `session.destroy`) or `error{kind: WsHandshake | WsRead | WsWrite}`. `opcode` 1 = text (UTF-8 bytes), 2 = binary. Ping/pong handled inside Go. The session's dialer must be HTTP/1 for the upgrade; Go uses a dedicated `ForceHttp1` client sharing the session's profile, proxy and Jar.

## 8. `ErrorMeta`

```ts
{
  kind: "InvalidConfig" | "InvalidUrl" | "Dns" | "Connect" | "Tls" | "Proxy" | "Timeout" | "Cancelled"
      | "Http" | "Body" | "Pinning" | "SessionNotFound" | "SessionConfig"
      | "WsHandshake" | "WsRead" | "WsWrite" | "Protocol" | "Internal" | "Unknown"
  message: string                          // Go error text, for humans
  detail?: Record<string, unknown>         // kind-specific (e.g. Pinning: { host, pins })
}
```
Classification happens in Go via `errors.As`/`errors.Is` (`net.OpError`, `*net.DNSError`, `tls.RecordHeaderError`/`x509.*`, `context.DeadlineExceeded`, `context.Canceled`, proxy dialer errors, tls-client pin errors). JS derives `isTransient` (`Dns | Connect | Timeout | Proxy`).

## 9. Handshake and shutdown

1. JS spawns Bridge, sends `hello` (id 0). Go replies `helloAck` (id 0). Nothing else is accepted before `helloAck`; Go exits 2 on a bad first frame.
2. Normal end: JS sends `shutdown` (id 0); Go closes all sockets, destroys all sessions, replies `ok`, exits 0. JS waits ≤ 2 s, then `kill`.
3. Abnormal: stdout EOF or process exit → JS fails all pending ops with `BridgeExited{exitCode, signal, stderrTail}`; the Bridge service is dead.

## 10. Versioning

`protocolVersion` is an integer in `hello`/`helloAck`; any incompatible change bumps it. Package and Bridge versions are always equal (lockstep publish), so in practice compatibility = same version. Additive fields in meta are allowed without a bump; unknown meta fields are ignored by both sides. In particular, `helloAck.window` and `helloAck.chunkSize` are optional for compatibility with an earlier Bridge.

## 11. Real Bridge tests

Build a local Bridge and pass its path explicitly so the real cancellation, credit, and concurrency tests run:

```sh
go build -C bridge -ldflags "-X main.version=0.0.0" -o /tmp/effect-tls-client-bridge .
TLS_CLIENT_BRIDGE_PATH=/tmp/effect-tls-client-bridge \
  bun run --cwd packages/effect-tls-client test -- tests/bridge.test.ts
```

Without `TLS_CLIENT_BRIDGE_PATH`, those real-process tests are skipped; CI sets it before the Turbo test task, and a configured missing path fails the tests rather than skipping them.
