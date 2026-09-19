import { Schema } from "effect";
import { decodeUtf8 } from "./Frame.js";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_WINDOW = 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const HelloMeta = Schema.Struct({
  protocolVersion: Schema.Int,
  clientVersion: Schema.String,
  window: Schema.optionalKey(NonNegativeInt),
  chunkSize: Schema.optionalKey(NonNegativeInt),
});
export interface HelloMeta extends Schema.Schema.Type<typeof HelloMeta> {}

export const HelloAckMeta = Schema.Struct({
  protocolVersion: Schema.Int,
  bridgeVersion: Schema.String,
  tlsClientVersion: Schema.String,
  goVersion: Schema.String,
  window: Schema.optionalKey(NonNegativeInt),
  chunkSize: Schema.optionalKey(NonNegativeInt),
});
export interface HelloAckMeta extends Schema.Schema.Type<typeof HelloAckMeta> {}

export const EmptyMeta = Schema.Struct({});
export interface EmptyMeta extends Schema.Schema.Type<typeof EmptyMeta> {}

export const CancelMeta = Schema.Struct({});
export interface CancelMeta extends Schema.Schema.Type<typeof CancelMeta> {}

export const AckMeta = Schema.Struct({
  bytes: NonNegativeInt,
});
export interface AckMeta extends Schema.Schema.Type<typeof AckMeta> {}

export const DebugSleepMeta = Schema.Struct({
  ms: NonNegativeInt,
});
export interface DebugSleepMeta extends Schema.Schema.Type<
  typeof DebugSleepMeta
> {}

export const DebugStreamMeta = Schema.Struct({
  chunks: NonNegativeInt,
  size: NonNegativeInt,
});
export interface DebugStreamMeta extends Schema.Schema.Type<
  typeof DebugStreamMeta
> {}

export const ChunkMeta = Schema.Struct({});
export interface ChunkMeta extends Schema.Schema.Type<typeof ChunkMeta> {}

export const EndMeta = Schema.Struct({
  bytesRead: NonNegativeInt,
  bytesWritten: NonNegativeInt,
});
export interface EndMeta extends Schema.Schema.Type<typeof EndMeta> {}

export const ErrorKind = Schema.Literals([
  "InvalidConfig",
  "InvalidUrl",
  "Dns",
  "Connect",
  "Tls",
  "Proxy",
  "Timeout",
  "Cancelled",
  "Http",
  "Body",
  "Pinning",
  "SessionNotFound",
  "SessionConfig",
  "WsHandshake",
  "WsRead",
  "WsWrite",
  "Protocol",
  "Internal",
]);

export const ErrorMeta = Schema.Struct({
  kind: ErrorKind,
  message: Schema.String,
  detail: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export interface ErrorMeta extends Schema.Schema.Type<typeof ErrorMeta> {}

type JsonSchema = Schema.Codec<unknown, unknown, never, never>;
const json = <S extends JsonSchema>(schema: S) => Schema.fromJsonString(schema);

export const decodeMeta = <S extends JsonSchema>(
  schema: S,
  bytes: Uint8Array,
): S["Type"] => Schema.decodeSync(json(schema))(decodeUtf8(bytes));

export const encodeMeta = <S extends JsonSchema>(
  schema: S,
  value: Schema.Schema.Type<S>,
): Uint8Array =>
  new TextEncoder().encode(Schema.encodeSync(json(schema))(value));

export const decodeEmptyMeta = (bytes: Uint8Array): EmptyMeta =>
  bytes.byteLength === 0 ? {} : decodeMeta(EmptyMeta, bytes);

export const encodeEmptyMeta = (value: unknown = {}): Uint8Array =>
  encodeMeta(EmptyMeta, Schema.decodeUnknownSync(EmptyMeta)(value));
