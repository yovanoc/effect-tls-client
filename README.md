# effect-tls-client

Effect-native HTTP, HTTP/2/3, and WebSocket access to
[`bogdanfinn/tls-client`](https://github.com/bogdanfinn/tls-client), backed by a
versioned Go Bridge process. It is for applications that need a pinned TLS
identity without loading native code into Node or Bun.

The package supports **Node 22+** and **Bun 1.4+**. The optional browser layer
adds browser-shaped headers, bounded navigation, and an application-owned
challenge seam on top of the same scoped transport session.

## Install

```sh
npm install effect effect-tls-client @effect/platform-node
# or
bun add effect effect-tls-client @effect/platform-bun
```

`effect-tls-client` declares `effect` as a peer dependency and installs the
matching optional Bridge package for the host OS/architecture. Releases publish
these packages together:

| Runtime target | Optional package                         |
| -------------- | ---------------------------------------- |
| macOS arm64    | `@effect-tls-client/bridge-darwin-arm64` |
| macOS x64      | `@effect-tls-client/bridge-darwin-x64`   |
| Linux arm64    | `@effect-tls-client/bridge-linux-arm64`  |
| Linux x64      | `@effect-tls-client/bridge-linux-x64`    |
| Windows x64    | `@effect-tls-client/bridge-win32-x64`    |

There is no `postinstall`, runtime download, FFI, or in-process native load.

## First request

A platform service layer supplies the child-process implementation. The rest of
the program is runtime-neutral:

```ts
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { TlsClient } from "effect-tls-client";

const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* TlsClient;
    const session = yield* client.session({ profile: "chrome_146" });
    const response = yield* session.request("https://example.com/");

    console.log(response.status, response.protocol);
    console.log(yield* response.text);
  }),
);

await Effect.runPromise(
  program.pipe(Effect.provide(TlsClient.layer.pipe(Layer.provide(NodeServices.layer)))),
);
```

For Bun, replace the platform import and layer with
`@effect/platform-bun` and `BunServices.layer`. Keep the outer scope: sessions,
responses, and WebSockets are scoped resources.

`TlsClient.version` exposes the package, Bridge, protocol, Go, and pinned
`tls-client` versions for diagnostics.

## Effect `HttpClient`

Use `TlsHttpClient.layer` when the application already consumes Effect's
`HttpClient` service. It preserves the standard request/response model while
using the same fingerprinted session underneath:

```ts
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { NodeServices } from "@effect/platform-node";
import { TlsHttpClient } from "effect-tls-client";

const app = Effect.scoped(
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get("https://example.com/");
    console.log(response.status, yield* response.text);
  }),
);

await Effect.runPromise(
  app.pipe(
    Effect.provide(
      TlsHttpClient.layer({ profile: "chrome_146" }).pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);
```

The projection follows Effect redirect semantics: requests do not silently
follow redirects. Compose `HttpClient.followRedirects(n)` when that behavior is
wanted. Transport-only controls such as `timeoutMs`, `headerOrder`,
`hostOverride`, and response buffering are available through
`TlsHttpClient.RequestOptions`.

## Sessions and configuration

`TlsClient` owns one Bridge. Each `TlsSession` owns one identity, connection
pool, and Go-side RFC cookie Jar. `profile` and `customProfile` are mutually
exclusive and exactly one is required.

| Tier            | Examples                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session-fixed   | `profile`/`customProfile`, `identity`, default timeout, redirect default, TLS flags, HTTP/3 flags, local address, SNI, certificate pins, cookie-jar mode, transport limits |
| Session-mutable | Proxy via `proxyUrl` at creation or `session.setProxy(...)` later                                                                                                          |
| Per request     | URL, method, headers, header order, body, timeout, redirect override, `hostOverride`, request cookies                                                                      |

A session can serve concurrent requests and long-lived WebSockets. Its scope is
the lifetime boundary; closing the scope closes the Bridge operations it owns.

### Cookies and proxies

The Go Jar is the source of truth, including redirects and WebSocket
handshakes:

```ts
const cookies = yield * session.cookies(url);
yield * session.setCookies(url, cookies);
const snapshot = yield * session.exportCookies;
yield * session.importCookies(snapshot);
yield * session.setProxy("socks5://127.0.0.1:1080");
yield * session.setProxy(null); // direct routing
```

Use `setCookies` rather than manually adding a `Cookie` header so domain, path,
expiry, security, and redirect rules remain correct. `cookieJar: "strict"`
rejects invalid/empty values; `cookieJar: "none"` disables the Jar. Proxy
failures are typed `TlsRequestError` values with `kind: "Proxy"`.

## Browser layer

Import the optional facade from `effect-tls-client/browser`. It wraps one
`TlsSession`, stamps navigation or XHR-style headers from a fixed identity, and
follows bounded `Location` and HTML redirects. The Go-side cookie jar remains
authoritative; browser requests reject manually supplied `Cookie` headers.

```ts
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { TlsClient } from "effect-tls-client";
import * as Browser from "effect-tls-client/browser";

const program = Effect.scoped(
  Effect.gen(function* () {
    const browser = yield* Browser.open({
      transport: { profile: "chrome_152_PSK" },
      identity: Browser.Chrome152Identity,
    });
    const page = yield* browser.navigate("https://example.com/");
    console.log(page.status, page.url, page.body.slice(0, 240));
  }),
);

await Effect.runPromise(
  program.pipe(Effect.provide(TlsClient.layer.pipe(Layer.provide(NodeServices.layer)))),
);
```

See [docs/browser.md](docs/browser.md) for the runnable Node/Bun example,
cookie ownership, and challenge limitations.

### WebSockets

`session.webSocket(url)` returns an Effect `Socket.Socket`; text and binary
frames remain distinct, and the socket participates in scope cleanup and credit
flow control:

```ts
import * as Socket from "effect/unstable/socket/Socket";

const socket = yield * session.webSocket("wss://example.test/echo");
const reader = yield * socket.reader;
const writer = yield * socket.writer;
yield * writer.write("hello");
const [reply] = yield * reader.pull;
yield * writer.write(new Socket.CloseEvent(1000, "done"));
```

Use `Effect.retry` around a complete handshake/session operation when a
reconnect policy is needed. Do not keep a reader or writer after its scope has
closed.

## Opt-in load benchmark

The repository includes a local, opt-in 1,000-account workload. It starts one
HTTPS target, one CONNECT proxy listener per account, and exercises one unique
cookie, durable WebSocket, and HTTP request loop per session:

```sh
bun run build # also builds bridge/bridge for the host
TLS_CLIENT_BRIDGE_PATH="$PWD/bridge/bridge" bun run benchmark:load
```

Set `TLS_CLIENT_LOAD_SESSIONS`, `TLS_CLIENT_LOAD_DURATION_SECONDS`,
`TLS_CLIENT_LOAD_WS_MESSAGES_PER_SECOND`,
`TLS_CLIENT_LOAD_HTTP_REQUESTS_PER_SECOND`,
`TLS_CLIENT_LOAD_OPERATION_TIMEOUT_MS`, and `TLS_CLIENT_LOAD_REPORT` to scale or
save the JSON report. The defaults are 1,000 sessions, 30 seconds, 10
WebSocket messages per second, and one HTTP request per second. Results are
synthetic local-fixture measurements, not a proxy-fleet or production-capacity
guarantee. Set `TLS_CLIENT_LOAD_HTTP_URL` and `TLS_CLIENT_LOAD_WS_URL` with an
`{id}` placeholder, plus `TLS_CLIENT_LOAD_PROXY_URLS`, to target externally
reachable endpoints and provide one unique proxy URL per session.
`TLS_CLIENT_LOAD_INSECURE_SKIP_VERIFY` defaults to true only for the local
fixture and must be explicitly enabled for custom self-signed endpoints.
Reports include latency percentiles, Node CPU/file-descriptor usage, parent
heap/RSS, and sampled Bridge RSS; Bridge CPU is not included.

## Errors and retry

Failures are typed rather than inferred from message strings:

- `BridgeSpawnError`, `BridgeExited`, `BridgeProtocolError`, and
  `BridgeVersionMismatch` describe the process boundary.
- `SessionConfigError` and `SessionNotFound` describe session lifecycle/config.
- `TlsRequestError` has a closed `kind` such as `Dns`, `Connect`, `Tls`,
  `Proxy`, `Timeout`, `Http`, `Body`, `Pinning`, or `Cancelled`.
- `TlsWebSocketError` distinguishes handshake, read, write, and remote-close
  failures. The `HttpClient` projection wraps transport failures in
  `HttpClientError.TransportError`.

No operation is retried implicitly. The exported
`isTransientRequestKind` predicate identifies the conservative retry set
(`Dns`, `Connect`, `Timeout`, and `Proxy`):

```ts
import { Effect, Schedule } from "effect";
import { isTransientRequestKind, TlsRequestError } from "effect-tls-client";

const response =
  yield *
  session.request(url).pipe(
    Effect.retry({
      schedule: Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 3 })),
      while: (error) => error instanceof TlsRequestError && isTransientRequestKind(error.kind),
    }),
  );
```

Choose idempotency, backoff, and reconnect scope in the application. Do not
retry cancellation, certificate pinning, invalid configuration, or an
application-level HTTP response by default.

## Telemetry

Bandwidth is measured as TLS-level byte deltas without extra wire requests:

```ts
const before = yield * session.bandwidth;
const response = yield * session.request(url);
console.log(yield * response.bytesRead, yield * response.bytesWritten);
const total = yield * session.bandwidth;
yield * session.resetBandwidth;
```

The package exports `TlsClientMetrics.bytesRead`, `bytesWritten`, `requests`,
`sessionsActive`, and `webSocketConnectionsActive`. Request metrics use only
low-cardinality profile/protocol/error labels; session IDs are not labels.
`TlsHttpClient` annotates its existing Effect span with the selected profile and
protocol.

## Profiles and custom profiles

`Profile.Known` and `CustomProfile` are generated from the pinned Bridge
`dump` output. The TypeScript union is advisory for autocomplete; the Bridge is
the authority and rejects unknown profile names with `SessionConfigError`.
Custom profiles validate enum keys and numeric bounds at the Schema boundary;
partial known-key maps are valid, while unknown H2/H3, curve, signature, or
compression names fail before a session is created.

## Custom Bridge paths and versioning

Set `TLS_CLIENT_BRIDGE_PATH` when using a locally built or wrapped Bridge:

```sh
TLS_CLIENT_BRIDGE_PATH=/opt/effect-tls-client/bridge node app.mjs
```

Resolution checks this override first, then the optional platform package. A
custom executable must speak protocol v1 and report the same package version;
mismatches fail fast as `BridgeVersionMismatch`. The six published packages
use a Changesets fixed group and are released in lockstep. The upstream
automation version (`tls-client`) is reported for diagnostics and does not
become the npm package version.

## Runnable examples

The repository examples run unchanged under Node or Bun after building the
package:

```sh
bun install
bun run build

node examples/basic-request.mjs
bun examples/basic-request.mjs
node examples/browser.mjs
bun examples/browser.mjs
node examples/http-client.mjs
bun examples/http-client.mjs
node examples/websocket.mjs
bun examples/websocket.mjs
```

Set `TLS_CLIENT_EXAMPLE_URL`, `TLS_CLIENT_EXAMPLE_WS_URL`, or
`TLS_CLIENT_EXAMPLE_PROFILE` to use another endpoint/profile. The WebSocket
example defaults to `wss://ws.postman-echo.com/raw`.

## Development and integration checks

```sh
bun install
bunx turbo run build test lint format
bun run check:bun # package checks in parallel with Bun
bun run scripts/release-pack.ts
bun run package:size

# The benchmark uses the deterministic fake Bridge fixture.
bun run benchmark
bun run benchmark:compare -- main
```

`benchmark:compare` builds the current checkout and a temporary worktree at the
base ref, then compares the fake-Bridge median and compressed npm tarball sizes.
It reports regressions above 10%; it does not fail on benchmark noise.

Oxlint enables all rule categories plus type-aware Effect diagnostics through the
shared workspace config. Existing findings are warnings while the baseline is
migrated incrementally.

Go checks run from the module directory:

```sh
go -C bridge test -race ./...
```

The integration suite is opt-in because it starts real Bridge processes and
local TLS/HTTP/WebSocket servers:

```sh
TLS_CLIENT_INTEGRATION=1 \
TLS_CLIENT_BRIDGE_PATH="$PWD/bridge/bridge" \
  bun run --cwd packages/effect-tls-client test
```

CI runs this suite on native macOS arm64, Linux x64, and Windows x64 runners,
with optional macOS x64 and Linux arm64 jobs when hosted runner labels are
available. The release workflow cross-builds and packs all five platform
binaries. An external fingerprint echo is deliberately opt-in:

```sh
TLS_CLIENT_PUBLIC_ECHO=1 \
TLS_CLIENT_INTEGRATION=1 \
TLS_CLIENT_BRIDGE_PATH="$PWD/bridge/bridge" \
  bun run --cwd packages/effect-tls-client test -- \
  tests/public-fingerprint.integration.test.ts
```

Override `TLS_CLIENT_PUBLIC_ECHO_URL`, `TLS_CLIENT_PUBLIC_PROFILE`,
`TLS_CLIENT_PUBLIC_JA3_HASH`, or `TLS_CLIENT_PUBLIC_H2_HASH` when the endpoint
or profile changes.
