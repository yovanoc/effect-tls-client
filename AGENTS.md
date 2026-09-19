# effect-tls-client

Effect-native access to bogdanfinn/tls-client via a Go Bridge sidecar (see `docs/adr/0001`). No FFI, no
in-process shared library. One repo: TS package, per-platform Bridge stub packages, `bridge/` Go module.

## Before working

Read `CONTEXT.md` (glossary), `docs/adr/`, `docs/design/01-decisions.md` (D1–D18) and
`docs/design/03-protocol.md` (the Go/TS wire contract) for the area you touch.

## Effect

Effect v4 pre-release, tracking the newest channel (`rc` dist-tag). Read `node_modules/effect/AGENTS.md`
and verify APIs against `node_modules/effect/src`. Services via `Context.Service`, `Layer.effect`,
`Effect.acquireRelease`, `Schema.TaggedError`, `Schema` at every boundary (frames, config).

## Verification

`turbo run build test lint format` for TS; `go test -race ./...` in `bridge/`. Integration tests spawn the
real Bridge against local servers and are opt-in (`TLS_CLIENT_INTEGRATION=1`).

## Agent skills

### Issue tracker

GitHub Issues for `yovanoc/effect-tls-client`, using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
