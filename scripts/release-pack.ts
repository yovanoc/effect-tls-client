import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

interface PackageJson {
  readonly name: string;
  readonly version: string;
}

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files?: readonly PackedFile[];
}

type JsonContainer = Record<string, unknown> | readonly unknown[];

const isArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !isArray(value);
const isPackageJson = (value: unknown): value is PackageJson =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.version === "string";
const isPackedFile = (value: unknown): value is PackedFile =>
  isRecord(value) && typeof value.path === "string";
const isPackResult = (value: unknown): value is PackResult =>
  isRecord(value) &&
  typeof value.filename === "string" &&
  (value.files === undefined ||
    (Array.isArray(value.files) && value.files.every(isPackedFile)));
const isPackResults = (value: JsonContainer): value is readonly PackResult[] =>
  isArray(value) && value.every((entry) => isPackResult(entry));

const repositoryRoot = resolve(
  process.env.RELEASE_PACK_ROOT ?? resolve(import.meta.dir, ".."),
);
const packageDirectories = [
  "packages/effect-tls-client",
  "packages/bridge-darwin-arm64",
  "packages/bridge-darwin-x64",
  "packages/bridge-linux-arm64",
  "packages/bridge-linux-x64",
  "packages/bridge-win32-x64",
] as const;
const outputDirectory = resolve(
  repositoryRoot,
  process.env.RELEASE_PACK_DIR ?? "release-packages",
);

const packageJsonPath = (directory: string): string =>
  join(directory, "package.json");
const parseJson = (text: string, description: string): JsonContainer => {
  try {
    const value: unknown = JSON.parse(text);
    if (isArray(value)) return value;
    if (!isRecord(value)) {
      throw new Error("JSON value is not an object or array");
    }
    return value;
  } catch (error) {
    throw new Error(`invalid JSON from ${description}`, { cause: error });
  }
};

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const manifest: { readonly name: string; readonly filename: string }[] = [];
const versions = new Set<string>();

for (const relativeDirectory of packageDirectories) {
  const directory = join(repositoryRoot, relativeDirectory);
  const packageJsonValue = parseJson(
    readFileSync(packageJsonPath(directory), "utf8"),
    packageJsonPath(directory),
  );
  if (!isPackageJson(packageJsonValue)) {
    throw new Error(
      `invalid package metadata at ${packageJsonPath(directory)}`,
    );
  }
  const packageJson = packageJsonValue;
  versions.add(packageJson.version);
  const result = Bun.spawnSync(
    [
      "npm",
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      outputDirectory,
    ],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`npm pack failed for ${packageJson.name}`);
  }

  const packedValue = parseJson(
    new TextDecoder().decode(result.stdout),
    `npm pack for ${packageJson.name}`,
  );
  if (!isPackResults(packedValue)) {
    throw new Error(`npm pack returned invalid JSON for ${packageJson.name}`);
  }
  const packResult = packedValue.at(0);
  if (packResult === undefined) {
    throw new Error(`npm pack returned no result for ${packageJson.name}`);
  }

  if (packageJson.name.startsWith("@effect-tls-client/bridge-")) {
    const expectedBinary = packageJson.name.endsWith("win32-x64")
      ? "bin/bridge.exe"
      : "bin/bridge";
    const files = packResult.files ?? [];
    const binaryFiles = files.filter((file) => file.path.startsWith("bin/"));
    if (binaryFiles.length !== 1 || binaryFiles[0]?.path !== expectedBinary) {
      throw new Error(
        `${packageJson.name} must pack exactly ${expectedBinary}; got ${binaryFiles.map((file) => file.path).join(", ") || "nothing"}`,
      );
    }
  }

  const tarball = join(outputDirectory, packResult.filename);
  statSync(tarball);
  manifest.push({ name: packageJson.name, filename: packResult.filename });
}

if (versions.size !== 1) {
  throw new Error(
    `release packages must share one version; got ${[...versions].join(", ")}`,
  );
}

writeFileSync(
  join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`packed ${manifest.length} packages in ${outputDirectory}`);
