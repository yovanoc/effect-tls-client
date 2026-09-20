import { Effect, Layer } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { TlsClient } from "../packages/effect-tls-client/dist/index.mjs";
import { platformLayer } from "./runtime.mjs";

const url = process.env.TLS_CLIENT_EXAMPLE_WS_URL ?? "wss://ws.postman-echo.com/raw";
const profile = process.env.TLS_CLIENT_EXAMPLE_PROFILE ?? "chrome_146";
const services = await platformLayer();

const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* TlsClient;
    const session = yield* client.session({ profile });
    const socket = yield* session.webSocket(url);
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;

    yield* writer.write("hello from effect-tls-client");
    const [reply] = yield* reader.pull;
    console.log(typeof reply === "string" ? reply : new TextDecoder().decode(reply));
    yield* writer.write(new Socket.CloseEvent(1000, "done"));
  }),
);

await Effect.runPromise(
  program.pipe(Effect.provide(TlsClient.layer.pipe(Layer.provide(services)))),
);
