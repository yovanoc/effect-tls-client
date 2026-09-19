---
status: accepted
---

# The Bridge is a sidecar process, not an in-process shared library

The project was framed as "consume tls-client's shared-library (CFFI) interface from TypeScript", and a prior iteration (`effect-ffi`) did exactly that via `node:ffi`/`bun:ffi` plus worker threads. We instead compile our own Go bridge as a static executable (`CGO_ENABLED=0`) and spawn it as a child process speaking a framed protocol over stdio. Reasons: `node:ffi` and `bun:ffi` are synchronous-only and experimental (Bun: "do not rely on it in production"), so non-blocking calls required a worker/fork anyway; Go `c-shared` libraries cannot be `dlclose`d and a Go panic kills the host; upstream's CFFI exposes 6 blocking functions with no WebSocket, streaming or bandwidth; static Go binaries remove the cgo cross-compiler and musl/glibc matrix. Per-call IPC cost (µs) is negligible against network RTT. Precedent: esbuild.

## Considered options

- In-process `c-shared` + `node:ffi`/`bun:ffi` + workers (previous design).
- FFI submit + pipe completion hybrid.
- N-API addon (napi-rs/C glue) around the Go library — second native toolchain, still no crash isolation.
- Sidecar process over stdio — chosen.

## Consequences

No `effect-ffi` abstraction exists. Anything that needs "no child process" (sandboxed hosts forbidding spawn) is out of scope. Crash isolation and Go-side cancellation come for free.
