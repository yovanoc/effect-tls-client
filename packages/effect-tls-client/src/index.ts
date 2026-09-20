export { TlsClient, SessionConfig } from "./TlsClient.js";
export { CustomProfile } from "./generated/CustomProfile.js";
export { Profile } from "./generated/Profile.js";
export * as TlsHttpClient from "./TlsHttpClient.js";
export * as TlsClientMetrics from "./Telemetry.js";
export type {
  RequestBody,
  RequestCookieInput,
  RequestInput,
  RequestOptions,
  WebSocketOptions,
  ProxyInput,
  TlsClientService,
  TlsResponse,
  Bandwidth,
  TlsSession,
} from "./TlsClient.js";
export {
  BridgeExited,
  BridgeProtocolError,
  BridgeSpawnError,
  BridgeVersionMismatch,
  SessionConfigError,
  SessionNotFound,
  TlsRequestError,
  TlsWebSocketError,
  isTransientRequestKind,
} from "./internal/Errors.js";
export type { BridgeError, RequestErrorKind } from "./internal/Errors.js";
export type { BridgeVersion } from "./internal/Bridge.js";

/** The library's own release version, used in the Bridge handshake. */
export { PACKAGE_VERSION as version } from "./internal/Bridge.js";
