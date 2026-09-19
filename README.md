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
