---
status: accepted
---

# The Bridge speaks our own binary-framed protocol, not JSON-only or `@effect/rpc`

Frames are `[u32 length][u8 kind][u32 requestId]` + JSON metadata + optional raw bytes, multiplexed on one stdio pipe, with `cancel` and credit-window `ack` frames. We rejected a JSON-only envelope (forces base64 on every body and a later chunking protocol) and reusing `@effect/rpc`'s wire format (no Go implementation; changes across Effect 4 pre-releases and would couple the Go binary to the JS library's internals). The invariants worth remembering: Go always emits the terminal frame for an op; JS never closes a pending op on its own except on `BridgeExited`; bodies and WebSocket frames are raw bytes, never base64.

## Consequences

Streaming in both directions and WebSocket push are first-class. Protocol changes require lockstep versioning of the npm package and Bridge binaries (enforced by `BridgeVersionMismatch`).
