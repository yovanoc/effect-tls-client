import { Effect, Layer } from "effect";
import { TlsClient } from "../packages/effect-tls-client/dist/index.mjs";
import * as Browser from "../packages/effect-tls-client/dist/browser/index.mjs";
import { platformLayer } from "./runtime.mjs";

const url = process.env.TLS_CLIENT_EXAMPLE_URL ?? "http://example.test/",
  profile = process.env.TLS_CLIENT_EXAMPLE_PROFILE ?? "chrome_152_PSK",
  identity =
    profile === "chrome_146"
      ? Browser.Chrome146Identity
      : profile === "chrome_152" || profile === "chrome_152_PSK"
        ? Browser.Chrome152Identity
        : (() => {
            throw new Error(
              "TLS_CLIENT_EXAMPLE_PROFILE must be chrome_146, chrome_152, or chrome_152_PSK",
            );
          })(),
  services = await platformLayer(),
  browserServices = Layer.mergeAll(
    TlsClient.layer.pipe(Layer.provide(services)),
    Browser.BrowserMock.layer().pipe(Layer.provide(services)),
  ),
  program = Effect.scoped(
    Effect.gen(function* program() {
      const scriptRuntime = yield* Browser.BrowserMock;
      const browser = yield* Browser.open(
        {
          transport: { profile },
          identity,
        },
        { scriptRuntime },
      );
      const page = yield* browser.navigate(url);

      console.log(`${page.status} ${page.url} (${page.protocol})`);
      if (page.challenge === undefined) {
        console.log(page.body.slice(0, 240));
      } else {
        console.log(`Challenge: ${page.challenge.kind}`);
      }
    }),
  );

await Effect.runPromise(program.pipe(Effect.provide(browserServices)));
