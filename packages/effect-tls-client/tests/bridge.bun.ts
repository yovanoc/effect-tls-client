import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { TlsClient } from "../src/index.js";

const version = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* TlsClient;
      return yield* client.version;
    }),
  ).pipe(
    Effect.provide(TlsClient.layer.pipe(Layer.provide(BunServices.layer))),
  ),
);

if (
  version.protocolVersion !== 1 ||
  version.bridgeVersion !== version.packageVersion ||
  version.tlsClientVersion === "unknown"
) {
  throw new Error(`unexpected Bridge version: ${JSON.stringify(version)}`);
}
