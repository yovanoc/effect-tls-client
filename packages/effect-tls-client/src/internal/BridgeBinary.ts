import { createRequire } from "node:module";
import { Config, Effect, Option } from "effect";
import { BridgeSpawnError } from "./Errors.js";

const packageForPlatform: Readonly<Record<string, string>> = {
  "darwin-arm64": "@effect-tls-client/bridge-darwin-arm64",
  "darwin-x64": "@effect-tls-client/bridge-darwin-x64",
  "linux-arm64": "@effect-tls-client/bridge-linux-arm64",
  "linux-x64": "@effect-tls-client/bridge-linux-x64",
  "win32-x64": "@effect-tls-client/bridge-win32-x64",
};

export const bridgePathConfig = Config.option(
  Config.NonEmptyString("TLS_CLIENT_BRIDGE_PATH"),
);

const platformKey = (): string =>
  `${globalThis.process.platform}-${globalThis.process.arch}`;

/** Resolves the override first, then the matching optionalDependency binary. */
export const resolveBridgeBinary = Effect.gen(function* () {
  const override = yield* bridgePathConfig.pipe(
    Effect.mapError(
      (cause) =>
        new BridgeSpawnError({
          message: "invalid TLS_CLIENT_BRIDGE_PATH",
          cause,
        }),
    ),
  );
  if (Option.isSome(override)) return override.value;

  const packageName = packageForPlatform[platformKey()];
  if (packageName === undefined) {
    return yield* new BridgeSpawnError({
      message: `unsupported Bridge platform: ${platformKey()}`,
    });
  }

  return yield* Effect.try({
    try: () =>
      createRequire(import.meta.url).resolve(
        `${packageName}/bin/bridge${globalThis.process.platform === "win32" ? ".exe" : ""}`,
      ),
    catch: (cause) =>
      new BridgeSpawnError({
        message: `Bridge binary is not installed for ${platformKey()}`,
        cause,
      }),
  });
});
