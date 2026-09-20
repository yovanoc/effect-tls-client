import { Effect, Layer } from "effect";
import { TlsClient } from "../packages/effect-tls-client/dist/index.mjs";
import { platformLayer } from "./runtime.mjs";

const url = process.env.TLS_CLIENT_EXAMPLE_URL ?? "https://example.com/";
const profile = process.env.TLS_CLIENT_EXAMPLE_PROFILE ?? "chrome_146";
const services = await platformLayer();

const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* TlsClient;
    const version = yield* client.version;
    const session = yield* client.session({ profile });
    const response = yield* session.request(url);

    console.log(`${response.status} ${response.url} (${response.protocol})`);
    console.log(`Bridge: ${version.bridgeVersion}; tls-client: ${version.tlsClientVersion}`);
    console.log((yield* response.text).slice(0, 240));
  }),
);

await Effect.runPromise(
  program.pipe(Effect.provide(TlsClient.layer.pipe(Layer.provide(services)))),
);
