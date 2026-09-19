export { TlsClient, SessionConfig } from "./TlsClient.js";
export type {
  RequestInput,
  RequestOptions,
  TlsClientService,
  TlsResponse,
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
  isTransientRequestKind,
} from "./internal/Errors.js";
export type { BridgeError } from "./internal/Errors.js";
export type { BridgeVersion } from "./internal/Bridge.js";

/** The library's own release version, used in the Bridge handshake. */
export { PACKAGE_VERSION as version } from "./internal/Bridge.js";
