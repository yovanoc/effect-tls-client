import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Duration, Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { Bridge } from "../src/internal/Bridge.js";
import { FrameKind } from "../src/internal/Frame.js";
import { TlsClient } from "../src/TlsClient.js";
import { version } from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/bridge-fixture.mjs", import.meta.url),
);
const delayedStderrFixturePath = fileURLToPath(
  new URL("./fixtures/bridge-delayed-stderr-fixture.mjs", import.meta.url),
);

const withClientAt = <A, E>(
  path: string,
  effect: Effect.Effect<A, E, TlsClient>,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(
        TlsClient.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: path }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

const withBridgeAt = <A, E>(
  path: string,
  effect: Effect.Effect<A, E, Bridge>,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(
        Bridge.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: path }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

const withClient = <A, E>(effect: Effect.Effect<A, E, TlsClient>) =>
  withClientAt(fixturePath, effect);

const withBridge = <A, E>(effect: Effect.Effect<A, E, Bridge>) =>
  withBridgeAt(fixturePath, effect);

describe("Bridge lifecycle", () => {
  it.effect(
    "returns versions from a spawned Bridge and closes with shutdown",
    () =>
      withClient(
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const result = yield* client.version;
          expect(result).toEqual({
            packageVersion: version,
            bridgeVersion: version,
            protocolVersion: 1,
            tlsClientVersion: "fixture",
            goVersion: "fixture-go",
          });
        }),
      ),
  );

  it.effect("round-trips debug.ping through the pending operation map", () =>
    withBridge(
      Effect.gen(function* () {
        const bridge = yield* Bridge;
        const frame = yield* bridge.call(FrameKind.debugPing);
        expect(frame.kind).toBe(FrameKind.ok);
        expect(frame.id).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("classifies a missing binary as BridgeSpawnError", () =>
    Effect.flip(
      withClientAt(
        fileURLToPath(new URL("./fixtures/no-such-bridge", import.meta.url)),
        TlsClient,
      ),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error._tag).toBe("BridgeSpawnError");
        }),
      ),
    ),
  );

  it.effect("classifies a version mismatch during acquisition", () =>
    Effect.flip(
      withClientAt(
        fileURLToPath(
          new URL("./fixtures/bridge-mismatch-fixture.mjs", import.meta.url),
        ),
        TlsClient,
      ),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error._tag).toBe("BridgeVersionMismatch");
          if (error._tag === "BridgeVersionMismatch") {
            expect(error.expected).toBe(version);
            expect(error.actual).toBe(`${version}-mismatch`);
          }
        }),
      ),
    ),
  );

  it.effect("propagates a killed Bridge with its signal and stderr tail", () =>
    Effect.flip(
      withBridgeAt(
        fileURLToPath(
          new URL("./fixtures/bridge-exit-fixture.mjs", import.meta.url),
        ),
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          yield* bridge.call(FrameKind.debugPing);
        }),
      ),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error._tag).toBe("BridgeExited");
          if (error._tag === "BridgeExited") {
            expect(error.exitCode).toBeNull();
            expect(error.signal).toBe("SIGKILL");
            expect(error.stderrTail).toBe(
              `${"a".repeat(96)}${"b".repeat(2000)}${"c".repeat(2000)}`,
            );
          }
        }),
      ),
    ),
  );

  it.effect("fails pending calls before stderr closes after process exit", () =>
    Effect.flip(
      withBridgeAt(
        delayedStderrFixturePath,
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          yield* bridge.call(FrameKind.debugPing);
        }),
      ).pipe(Effect.timeout(Duration.millis(500))),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error._tag).toBe("BridgeExited");
          if (error._tag === "BridgeExited") {
            expect(error.signal).toBe("SIGKILL");
          }
        }),
      ),
    ),
  );
});
