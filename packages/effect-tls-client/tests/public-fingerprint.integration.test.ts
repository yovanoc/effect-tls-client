import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { TlsClient } from "../src/index.js";

const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const enabled = process.env["TLS_CLIENT_PUBLIC_ECHO"] === "1";
const profile = process.env["TLS_CLIENT_PUBLIC_PROFILE"] ?? "chrome_146";
const url =
  process.env["TLS_CLIENT_PUBLIC_ECHO_URL"] ?? "https://tls.peet.ws/api/all";
const expectedJa3Hash =
  process.env["TLS_CLIENT_PUBLIC_JA3_HASH"] ??
  "2d25c56381929cc91bc97631a0a46f58";
const expectedH2Hash =
  process.env["TLS_CLIENT_PUBLIC_H2_HASH"] ??
  "52d84b11737d980aef856699f885ca86";
const describePublic =
  enabled && bridgePath !== undefined ? describe : describe.skip;

const PublicEchoResponse = Schema.Struct({
  http_version: Schema.String,
  tls: Schema.Struct({
    ja3_hash: Schema.String,
  }),
  http2: Schema.Struct({
    akamai_fingerprint_hash: Schema.String,
  }),
});

describePublic("public fingerprint echo", () => {
  it.live("matches the configured TLS and HTTP/2 fingerprints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const session = yield* client.session({ profile });
        const response = yield* session.request(url);
        const body = yield* Schema.decodeUnknownEffect(PublicEchoResponse)(
          yield* response.json,
        );

        expect(response.protocol).toBe("HTTP/2.0");
        expect(body.http_version).toBe("h2");
        expect(body.tls.ja3_hash).toBe(expectedJa3Hash);
        expect(body.http2.akamai_fingerprint_hash).toBe(expectedH2Hash);
      }),
    ).pipe(
      Effect.provide(TlsClient.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  );
});
