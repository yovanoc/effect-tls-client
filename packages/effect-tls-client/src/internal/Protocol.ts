import { Schema } from "effect";
import {
  CandidateCipherSuite,
  CustomProfile,
  PriorityFrame,
  PriorityParam,
} from "../generated/CustomProfile.js";
import { ErrorKind, Profile } from "../generated/Profile.js";
import { decodeUtf8 } from "./Frame.js";

export { CandidateCipherSuite, CustomProfile, PriorityFrame, PriorityParam };
export { ErrorKind, Profile };

export const PROTOCOL_VERSION = 1;
export const DEFAULT_WINDOW = 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const HeaderPair = Schema.Tuple([Schema.String, Schema.String]);
const StringArray = Schema.Array(Schema.String);

export const Pair = HeaderPair;
export interface Pair extends Schema.Schema.Type<typeof Pair> {}

export const Cookie = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  domain: Schema.String,
  path: Schema.String,
  origin: Schema.optionalKey(Schema.String),
  expires: Schema.NullOr(Schema.Int),
  secure: Schema.Boolean,
  httpOnly: Schema.Boolean,
  sameSite: Schema.optionalKey(Schema.Literals(["Strict", "Lax", "None"])),
});
export interface Cookie extends Schema.Schema.Type<typeof Cookie> {}

/** JSON representation used for cross-process Jar persistence. */
export const CookiesJson = Schema.fromJsonString(Schema.Array(Cookie));
export type CookiesJson = Schema.Schema.Type<typeof CookiesJson>;

export const Identity = Schema.Struct({
  headers: Schema.Array(Pair),
  headerOrder: Schema.optionalKey(StringArray),
});
export interface Identity extends Schema.Schema.Type<typeof Identity> {}

export const TransportOptions = Schema.Struct({
  idleConnTimeoutMs: Schema.optionalKey(NonNegativeInt),
  maxIdleConns: Schema.optionalKey(NonNegativeInt),
  maxIdleConnsPerHost: Schema.optionalKey(NonNegativeInt),
  maxConnsPerHost: Schema.optionalKey(NonNegativeInt),
  maxResponseHeaderBytes: Schema.optionalKey(NonNegativeInt),
  writeBufferSize: Schema.optionalKey(NonNegativeInt),
  readBufferSize: Schema.optionalKey(NonNegativeInt),
  disableKeepAlives: Schema.optionalKey(Schema.Boolean),
  disableCompression: Schema.optionalKey(Schema.Boolean),
});
export interface TransportOptions extends Schema.Schema.Type<
  typeof TransportOptions
> {}

const SessionConfigBase = Schema.Struct({
  profile: Schema.optionalKey(Profile),
  customProfile: Schema.optionalKey(CustomProfile),
  identity: Schema.optionalKey(Identity),
  timeoutMs: Schema.optionalKey(NonNegativeInt),
  followRedirects: Schema.optionalKey(Schema.Boolean),
  proxyUrl: Schema.optionalKey(Schema.String),
  insecureSkipVerify: Schema.optionalKey(Schema.Boolean),
  randomTlsExtensionOrder: Schema.optionalKey(Schema.Boolean),
  disableSessionTickets: Schema.optionalKey(Schema.Boolean),
  forceHttp1: Schema.optionalKey(Schema.Boolean),
  disableHttp3: Schema.optionalKey(Schema.Boolean),
  protocolRacing: Schema.optionalKey(Schema.Boolean),
  disableIpv4: Schema.optionalKey(Schema.Boolean),
  disableIpv6: Schema.optionalKey(Schema.Boolean),
  localAddress: Schema.optionalKey(Schema.String),
  serverName: Schema.optionalKey(Schema.String),
  certificatePins: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Array(Schema.String)),
  ),
  cookieJar: Schema.optionalKey(Schema.Literals(["default", "strict", "none"])),
  transport: Schema.optionalKey(TransportOptions),
});

/** Public session configuration. Exactly one of profile/customProfile is required. */
export const SessionConfig = SessionConfigBase.check(
  Schema.makeFilter(
    (value) => {
      const hasProfile = value.profile !== undefined;
      const hasCustomProfile = value.customProfile !== undefined;
      return hasProfile !== hasCustomProfile
        ? undefined
        : {
            path: [],
            issue: "exactly one of profile or customProfile is required",
          };
    },
    { expected: "exactly one of profile or customProfile" },
  ),
);
export interface SessionConfig extends Schema.Schema.Type<
  typeof SessionConfig
> {}

export const SessionConfigWire = Schema.Struct({
  sessionId: Schema.String,
  ...SessionConfigBase.fields,
}).check(
  Schema.makeFilter(
    (value) => {
      const hasProfile = value.profile !== undefined;
      const hasCustomProfile = value.customProfile !== undefined;
      return hasProfile !== hasCustomProfile
        ? undefined
        : {
            path: [],
            issue: "exactly one of profile or customProfile is required",
          };
    },
    { expected: "exactly one of profile or customProfile" },
  ),
);
export interface SessionConfigWire extends Schema.Schema.Type<
  typeof SessionConfigWire
> {}

export const SessionIdMeta = Schema.Struct({
  sessionId: Schema.String,
});
export interface SessionIdMeta extends Schema.Schema.Type<
  typeof SessionIdMeta
> {}

export const SessionProxyMeta = Schema.Struct({
  sessionId: Schema.String,
  proxyUrl: Schema.NullOr(Schema.String),
});
export interface SessionProxyMeta extends Schema.Schema.Type<
  typeof SessionProxyMeta
> {}

export const CookiesGetMeta = Schema.Struct({
  sessionId: Schema.String,
  url: Schema.String,
});
export interface CookiesGetMeta extends Schema.Schema.Type<
  typeof CookiesGetMeta
> {}

export const CookiesSetMeta = Schema.Struct({
  sessionId: Schema.String,
  url: Schema.String,
  cookies: Schema.Array(Cookie),
});
export interface CookiesSetMeta extends Schema.Schema.Type<
  typeof CookiesSetMeta
> {}

export const CookiesExportMeta = Schema.Struct({
  sessionId: Schema.String,
});
export interface CookiesExportMeta extends Schema.Schema.Type<
  typeof CookiesExportMeta
> {}

export const CookiesImportMeta = Schema.Struct({
  sessionId: Schema.String,
  cookies: Schema.Array(Cookie),
});
export interface CookiesImportMeta extends Schema.Schema.Type<
  typeof CookiesImportMeta
> {}

export const CookiesResultMeta = Schema.Struct({
  cookies: Schema.Array(Cookie),
});
export interface CookiesResultMeta extends Schema.Schema.Type<
  typeof CookiesResultMeta
> {}

export const BandwidthMeta = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
});
export interface BandwidthMeta extends Schema.Schema.Type<
  typeof BandwidthMeta
> {}

export const BandwidthResultMeta = Schema.Struct({
  read: NonNegativeInt,
  written: NonNegativeInt,
});
export interface BandwidthResultMeta extends Schema.Schema.Type<
  typeof BandwidthResultMeta
> {}

export const RequestMeta = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(SessionConfig),
  url: Schema.String,
  method: Schema.String,
  headers: Schema.Array(Pair),
  headerOrder: Schema.optionalKey(StringArray),
  hasBody: Schema.Boolean,
  contentLength: Schema.optionalKey(NonNegativeInt),
  timeoutMs: Schema.optionalKey(NonNegativeInt),
  followRedirects: Schema.optionalKey(Schema.Boolean),
  hostOverride: Schema.optionalKey(Schema.String),
  cookies: Schema.optionalKey(Schema.Array(Cookie)),
}).check(
  Schema.makeFilter(
    (value) => {
      const hasSession = value.sessionId !== undefined;
      const hasConfig = value.config !== undefined;
      return hasSession !== hasConfig
        ? undefined
        : {
            path: [],
            issue: "exactly one of sessionId or config is required",
          };
    },
    { expected: "exactly one of sessionId or config" },
  ),
);
export interface RequestMeta extends Schema.Schema.Type<typeof RequestMeta> {}

export const BodyChunkMeta = Schema.Struct({});
export interface BodyChunkMeta extends Schema.Schema.Type<
  typeof BodyChunkMeta
> {}

export const BodyEndMeta = Schema.Struct({});
export interface BodyEndMeta extends Schema.Schema.Type<typeof BodyEndMeta> {}

export const WsConnectMeta = Schema.Struct({
  sessionId: Schema.String,
  url: Schema.String,
  headers: Schema.Array(Pair),
  headerOrder: Schema.optionalKey(StringArray),
  subprotocols: Schema.optionalKey(StringArray),
  handshakeTimeoutMs: Schema.optionalKey(NonNegativeInt),
  readBufferSize: Schema.optionalKey(NonNegativeInt),
  writeBufferSize: Schema.optionalKey(NonNegativeInt),
});
export interface WsConnectMeta extends Schema.Schema.Type<
  typeof WsConnectMeta
> {}

export const WsWriteMeta = Schema.Struct({
  opcode: Schema.Literals([1, 2]),
});
export interface WsWriteMeta extends Schema.Schema.Type<typeof WsWriteMeta> {}

export const WsCloseMeta = Schema.Struct({
  code: Schema.optionalKey(Schema.Int),
  reason: Schema.optionalKey(Schema.String),
});
export interface WsCloseMeta extends Schema.Schema.Type<typeof WsCloseMeta> {}

export const WsOpenMeta = Schema.Struct({
  status: Schema.Int,
  headers: Schema.Array(Pair),
});
export interface WsOpenMeta extends Schema.Schema.Type<typeof WsOpenMeta> {}

export const WsFrameMeta = Schema.Struct({
  opcode: Schema.Literals([1, 2]),
});
export interface WsFrameMeta extends Schema.Schema.Type<typeof WsFrameMeta> {}

export const WsClosedMeta = Schema.Struct({
  code: Schema.Int,
  reason: Schema.String,
  initiator: Schema.Literals(["local", "remote"]),
});
export interface WsClosedMeta extends Schema.Schema.Type<typeof WsClosedMeta> {}

export const ResponseProtocol = Schema.Literals([
  "HTTP/1.1",
  "HTTP/2.0",
  "HTTP/3.0",
]);

export const ResponseHeadersMeta = Schema.Struct({
  status: Schema.Int,
  url: Schema.String,
  headers: Schema.Array(Pair),
  protocol: ResponseProtocol,
});
export interface ResponseHeadersMeta extends Schema.Schema.Type<
  typeof ResponseHeadersMeta
> {}

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
  protocol: Schema.optionalKey(ResponseProtocol),
  bytesRead: NonNegativeInt,
  bytesWritten: NonNegativeInt,
});
export interface EndMeta extends Schema.Schema.Type<typeof EndMeta> {}

export type ErrorKind = Schema.Schema.Type<typeof ErrorKind>;

/** Request error kinds produced by the current GET-only request path. */
export const RequestErrorKind = Schema.Literals([
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
  "Unknown",
]);
export type RequestErrorKind = Schema.Schema.Type<typeof RequestErrorKind>;

export const isRequestErrorKind = (kind: ErrorKind): kind is RequestErrorKind =>
  kind === "InvalidConfig" ||
  kind === "InvalidUrl" ||
  kind === "Dns" ||
  kind === "Connect" ||
  kind === "Tls" ||
  kind === "Proxy" ||
  kind === "Timeout" ||
  kind === "Cancelled" ||
  kind === "Http" ||
  kind === "Body" ||
  kind === "Pinning" ||
  kind === "Unknown";

export const ErrorMeta = Schema.Struct({
  kind: ErrorKind,
  message: Schema.String,
  detail: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export interface ErrorMeta extends Schema.Schema.Type<typeof ErrorMeta> {}

export type MetaSchema = Schema.Codec<unknown, unknown, never, never>;
const json = <S extends MetaSchema>(schema: S) => Schema.fromJsonString(schema);

export const decodeMeta = <S extends MetaSchema>(
  schema: S,
  bytes: Uint8Array,
): S["Type"] => Schema.decodeSync(json(schema))(decodeUtf8(bytes));

export const encodeMeta = <S extends MetaSchema>(
  schema: S,
  value: Schema.Schema.Type<S>,
): Uint8Array =>
  new TextEncoder().encode(Schema.encodeSync(json(schema))(value));

export const decodeEmptyMeta = (bytes: Uint8Array): EmptyMeta =>
  bytes.byteLength === 0 ? {} : decodeMeta(EmptyMeta, bytes);

export const encodeEmptyMeta = (value: unknown = {}): Uint8Array =>
  encodeMeta(EmptyMeta, Schema.decodeUnknownSync(EmptyMeta)(value));
