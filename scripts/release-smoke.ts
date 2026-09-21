import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface ManifestEntry {
  readonly name: string;
  readonly filename: string;
}

interface PackageJson {
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringRecord = (
  value: unknown,
): value is Readonly<Record<string, string>> =>
  isRecord(value) &&
  Object.values(value).every((entry) => typeof entry === "string");
const isManifestEntry = (value: unknown): value is ManifestEntry =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.filename === "string";
const isManifest = (value: unknown): value is readonly ManifestEntry[] =>
  Array.isArray(value) && value.every(isManifestEntry);
const isPackageJson = (value: unknown): value is PackageJson =>
  isRecord(value) &&
  (!Object.hasOwn(value, "devDependencies") ||
    isStringRecord(value.devDependencies));

type JsonContainer = object;

const parseJson = (text: string, description: string): JsonContainer => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) {
      throw new Error("JSON value is not an object or array");
    }
    return value;
  } catch (error) {
    throw new Error(`invalid JSON from ${description}`, { cause: error });
  }
};

const run = (command: readonly string[], cwd: string): void => {
  const result = Bun.spawnSync([...command], {
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with ${result.exitCode}`);
  }
};

const repositoryRoot = resolve(import.meta.dir, "..");
const packageJsonValue = parseJson(
  readFileSync(
    join(repositoryRoot, "packages/effect-tls-client/package.json"),
    "utf8",
  ),
  "effect-tls-client package metadata",
);
if (!isPackageJson(packageJsonValue)) {
  throw new Error("invalid effect-tls-client package metadata");
}
const packageJson = packageJsonValue;
const dependencyVersion = (name: string): string => {
  const version = packageJson.devDependencies?.[name];
  if (typeof version !== "string") {
    throw new Error(`missing smoke dependency version: ${name}`);
  }
  return version;
};

const packageDirectory = resolve(process.argv[2] ?? "release-packages");
const manifestValue = parseJson(
  readFileSync(join(packageDirectory, "manifest.json"), "utf8"),
  "release package manifest",
);
if (!isManifest(manifestValue)) {
  throw new Error("invalid release package manifest");
}
const manifest = manifestValue;
const tarballFor = (name: string): string => {
  const entry = manifest.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`missing packed package: ${name}`);
  }
  return join(packageDirectory, entry.filename);
};

const platformPackages: Readonly<Partial<Record<string, string>>> = {
  "darwin-arm64": "@effect-tls-client/bridge-darwin-arm64",
  "darwin-x64": "@effect-tls-client/bridge-darwin-x64",
  "linux-arm64": "@effect-tls-client/bridge-linux-arm64",
  "linux-x64": "@effect-tls-client/bridge-linux-x64",
  "win32-x64": "@effect-tls-client/bridge-win32-x64",
};
const platformPackage = platformPackages[`${process.platform}-${process.arch}`];
if (!platformPackage) {
  throw new Error(
    `release smoke does not support ${process.platform}-${process.arch}`,
  );
}

const projectDirectory = mkdtempSync(
  join(tmpdir(), "effect-tls-client-smoke-"),
);
try {
  writeFileSync(
    join(projectDirectory, "package.json"),
    `${JSON.stringify({ name: "effect-tls-client-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  const mainTarball = tarballFor("effect-tls-client");
  const bridgeTarball = tarballFor(platformPackage);
  run(
    [
      "npm",
      "install",
      "--no-save",
      "--no-package-lock",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      mainTarball,
      bridgeTarball,
      `effect@${dependencyVersion("effect")}`,
      `@effect/platform-node@${dependencyVersion("@effect/platform-node")}`,
      `@effect/platform-bun@${dependencyVersion("@effect/platform-bun")}`,
    ],
    projectDirectory,
  );
  const smokeSource = [
    "const runtime = process.argv[2];",
    'const { Effect, Layer } = await import("effect");',
    'const { TlsClient } = await import("effect-tls-client");',
    'const services = runtime === "node"',
    '  ? (await import("@effect/platform-node")).NodeServices',
    '  : (await import("@effect/platform-bun")).BunServices;',
    "const version = await Effect.runPromise(",
    "  Effect.scoped(",
    "    Effect.gen(function* () {",
    "      const client = yield* TlsClient;",
    "      return yield* client.version;",
    "    }),",
    "  ).pipe(",
    "    Effect.provide(TlsClient.layer.pipe(Layer.provide(services.layer))),",
    "  ),",
    ");",
    "if (version.protocolVersion !== 1 ||",
    "    version.bridgeVersion !== version.packageVersion ||",
    '    version.tlsClientVersion === "unknown") {',
    '  throw new Error("unexpected Bridge version: " + JSON.stringify(version));',
    "}",
    'console.log(runtime + ": " + JSON.stringify(version));',
    "",
  ].join("\n");
  writeFileSync(join(projectDirectory, "smoke.mjs"), smokeSource);
  run(["node", "smoke.mjs", "node"], projectDirectory);
  run(["bun", "smoke.mjs", "bun"], projectDirectory);
} finally {
  rmSync(projectDirectory, { force: true, recursive: true });
}
