import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { TlsClient } from "../dist/index.mjs";

const version = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* TlsClient;
      return yield* client.version;
    }),
  ).pipe(
    Effect.provide(TlsClient.layer.pipe(Layer.provide(NodeServices.layer))),
  ),
);

if (
  version.protocolVersion !== 1 ||
  version.bridgeVersion !== version.packageVersion ||
  version.tlsClientVersion === "unknown"
) {
  throw new Error(`unexpected Bridge version: ${JSON.stringify(version)}`);
}
