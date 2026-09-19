import { Schema } from "effect";
import { RequestErrorKind } from "./Protocol.js";

export class BridgeSpawnError extends Schema.TaggedError<BridgeSpawnError>()(
  "BridgeSpawnError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class BridgeVersionMismatch extends Schema.TaggedError<BridgeVersionMismatch>()(
  "BridgeVersionMismatch",
  {
    message: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
  },
) {}

export class BridgeProtocolError extends Schema.TaggedError<BridgeProtocolError>()(
  "BridgeProtocolError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class BridgeExited extends Schema.TaggedError<BridgeExited>()(
  "BridgeExited",
  {
    exitCode: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.String),
    stderrTail: Schema.String,
  },
) {}

export class SessionConfigError extends Schema.TaggedError<SessionConfigError>()(
  "SessionConfigError",
  {
    message: Schema.String,
  },
) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  {
    sessionId: Schema.String,
    message: Schema.String,
  },
) {}

export class TlsRequestError extends Schema.TaggedError<TlsRequestError>()(
  "TlsRequestError",
  {
    kind: RequestErrorKind,
    message: Schema.String,
    isTransient: Schema.Boolean,
    detail: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const TlsWebSocketErrorKind = Schema.Literals([
  "Handshake",
  "Read",
  "Write",
  "Closed",
]);
export type TlsWebSocketErrorKind = Schema.Schema.Type<
  typeof TlsWebSocketErrorKind
>;

export class TlsWebSocketError extends Schema.TaggedError<TlsWebSocketError>()(
  "TlsWebSocketError",
  {
    kind: TlsWebSocketErrorKind,
    message: Schema.String,
    code: Schema.optionalKey(Schema.Int),
    reason: Schema.optionalKey(Schema.String),
    initiator: Schema.optionalKey(Schema.Literals(["local", "remote"])),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export type BridgeError =
  | BridgeSpawnError
  | BridgeVersionMismatch
  | BridgeProtocolError
  | BridgeExited
  | SessionConfigError
  | SessionNotFound
  | TlsRequestError
  | TlsWebSocketError;

export const isTransientRequestKind = (kind: RequestErrorKind): boolean =>
  kind === "Dns" ||
  kind === "Connect" ||
  kind === "Timeout" ||
  kind === "Proxy";

export type { RequestErrorKind };
