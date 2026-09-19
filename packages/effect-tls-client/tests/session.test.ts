import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Stream } from "effect";
import type { Scope } from "effect";
import { NodeServices } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { SessionConfig, SessionConfigError, TlsClient } from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/bridge-fixture.mjs", import.meta.url),
);

const withClient = <A, E>(
  effect: Effect.Effect<A, E, TlsClient | Scope.Scope>,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(
        TlsClient.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  TLS_CLIENT_BRIDGE_PATH: fixturePath,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

describe("TlsClient sessions", () => {
  it.effect("creates a session and exposes a streamed cached response", () =>
    withClient(
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const session = yield* client.session({ profile: "chrome_146" });
        const response = yield* session.request("https://fixture.test/data");

        expect(response.status).toBe(200);
        expect(response.url).toBe("https://fixture.test/data");
        expect(response.protocol).toBe("HTTP/1.1");
        expect(response.headers).toEqual([
          ["Content-Type", "application/json"],
          ["Set-Cookie", "fixture=1; Path=/"],
        ]);
        expect(response.cookies.cookies["fixture"]?.value).toBe("1");

        const bytes = yield* response.bytes;
        const text = yield* response.text;
        const json = yield* response.json;
        expect(new TextDecoder().decode(bytes)).toBe('{"ok":true}');
        expect(text).toBe('{"ok":true}');
        expect(json).toEqual({ ok: true });
        const streamed = yield* session.request("https://fixture.test/stream");
        const chunks = yield* streamed.stream.pipe(Stream.runCollect);
        expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(
          '{"ok":true}',
        );
      }),
    ),
  );

  it.effect("rejects mutually exclusive profile configuration", () =>
    Effect.flip(
      withClient(
        Effect.gen(function* () {
          const client = yield* TlsClient;
          return yield* client.session({
            profile: "chrome_146",
            customProfile: { ja3String: "771,4865-4866-4867,0-11,23-24,0" },
          });
        }),
      ),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(SessionConfigError);
        }),
      ),
    ),
  );

  it("exports a schema that rejects a missing identity profile", () => {
    expect(() => SessionConfig.make({})).toThrow();
  });

  it.effect("destroys a session when its nested scope closes", () =>
    withClient(
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const session = yield* Effect.scoped(
          client.session({ profile: "chrome_146" }),
        );
        const error = yield* Effect.flip(
          session.request("https://fixture.test/after-close"),
        );
        expect(error._tag).toBe("SessionNotFound");
      }),
    ),
  );
});
