import { Context, Effect, Layer } from "effect";
import { Bridge } from "./internal/Bridge.js";
import type { BridgeError } from "./internal/Errors.js";
import type { BridgeVersion } from "./internal/Bridge.js";

export interface TlsClientService {
  readonly version: Effect.Effect<BridgeVersion, BridgeError>;
}

export class TlsClient extends Context.Service<TlsClient, TlsClientService>()(
  "effect-tls-client/TlsClient",
) {
  static readonly layer = Layer.effect(
    TlsClient,
    Effect.gen(function* () {
      const bridge = yield* Bridge;
      return TlsClient.of({ version: bridge.version });
    }),
  ).pipe(Layer.provide(Bridge.layer));
}
