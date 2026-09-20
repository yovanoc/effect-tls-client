import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { TlsHttpClient } from "../packages/effect-tls-client/dist/index.mjs";
import { platformLayer } from "./runtime.mjs";

const url = process.env.TLS_CLIENT_EXAMPLE_URL ?? "https://example.com/";
const profile = process.env.TLS_CLIENT_EXAMPLE_PROFILE ?? "chrome_146";
const services = await platformLayer();

const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);

    console.log(`${response.status} ${response.url}`);
    console.log((yield* response.text).slice(0, 240));
  }),
);

await Effect.runPromise(
  program.pipe(Effect.provide(TlsHttpClient.layer({ profile }).pipe(Layer.provide(services)))),
);
