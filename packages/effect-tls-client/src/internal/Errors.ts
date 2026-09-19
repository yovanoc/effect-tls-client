import { Schema } from "effect";

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

export type BridgeError =
  | BridgeSpawnError
  | BridgeVersionMismatch
  | BridgeProtocolError
  | BridgeExited;
