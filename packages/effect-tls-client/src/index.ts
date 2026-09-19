export { TlsClient } from "./TlsClient.js";
export type { TlsClientService } from "./TlsClient.js";
export {
  BridgeExited,
  BridgeProtocolError,
  BridgeSpawnError,
  BridgeVersionMismatch,
} from "./internal/Errors.js";
export type { BridgeError } from "./internal/Errors.js";
export type { BridgeVersion } from "./internal/Bridge.js";

/** The library's own release version, used in the Bridge handshake. */
export { PACKAGE_VERSION as version } from "./internal/Bridge.js";
