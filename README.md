# effect-tls-client

Effect-native access to bogdanfinn/tls-client via a Go Bridge sidecar. See `AGENTS.md`, `CONTEXT.md`, and
`docs/` for architecture and terminology.

This is a Bun workspace with Turborepo wiring both the TS packages and the `bridge/` Go module (native
`go.work` support) into one task graph.

## Layout

- `packages/effect-tls-client/` — the published TS library.
- `packages/bridge-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}/` — per-platform stub npm
  packages; the Bridge binary is dropped into `bin/` by a release build task (not yet implemented).
- `bridge/` — the Go module (Bridge sidecar), a `go.work` member.

## Session cookies and proxies

A scoped `TlsSession` owns the Go RFC 6265 Jar:

```ts
const session = yield * client.session({ profile: "chrome_146" });
const cookies = yield * session.cookies(url);
yield * session.setCookies(url, cookies);
const exported = yield * session.exportCookies; // Schema-validated JSON
yield * session.setProxy("http://127.0.0.1:8080");
yield * session.setProxy(null); // direct routing again
```

`Cookie` request headers replace automatic Jar injection for that request and are passed through unchanged,
but are discouraged: use `setCookies` so domain, path, expiry, security, and redirect behavior stay in the
Go Jar. `exportCookies`/`importCookies` persist only cookies accepted by the RFC Jar; `cookieJar: "strict"`
also rejects empty values, while `cookieJar: "none"` has no Jar. Proxy URLs accept `http`, `https`, `socks4`,
and `socks5` through the pinned tls-client dialers; local integration covers HTTP CONNECT and SOCKS5, while
HTTPS/SOCKS4 require an environment-specific proxy fixture. Proxy failures are typed as `TlsRequestError`
with `kind: "Proxy"`.

## Running checks

```sh
bun install
bunx turbo run build test lint format
```

Go-only, from `bridge/`:

```sh
go vet ./...
go test -race ./...
```

## Versioning

Changesets manages releases with a `fixed` version group covering `effect-tls-client` and all
`@effect-tls-client/bridge-*` packages, so they always publish together.
