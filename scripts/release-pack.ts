import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackageJson = {
  readonly name: string;
  readonly version: string;
};

type PackedFile = {
  readonly path: string;
};

type PackResult = {
  readonly filename: string;
  readonly files?: ReadonlyArray<PackedFile>;
};

const repositoryRoot = resolve(import.meta.dir, "..");
const packageDirectories = [
  "packages/effect-tls-client",
  "packages/bridge-darwin-arm64",
  "packages/bridge-darwin-x64",
  "packages/bridge-linux-arm64",
  "packages/bridge-linux-x64",
  "packages/bridge-win32-x64",
] as const;
const outputDirectory = resolve(repositoryRoot, process.env.RELEASE_PACK_DIR ?? "release-packages");

const packageJsonPath = (directory: string): string => join(directory, "package.json");

const parseJson = <T>(text: string, description: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`invalid JSON from ${description}`, { cause });
  }
};

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const manifest: Array<{ readonly name: string; readonly filename: string }> = [];
const versions = new Set<string>();

for (const relativeDirectory of packageDirectories) {
  const directory = join(repositoryRoot, relativeDirectory);
  const packageJson = parseJson<PackageJson>(
    readFileSync(packageJsonPath(directory), "utf8"),
    `${packageJsonPath(directory)}`,
  );
  versions.add(packageJson.version);
  const result = Bun.spawnSync(
    ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`npm pack failed for ${packageJson.name}`);
  }

  const packed = parseJson<ReadonlyArray<PackResult>>(
    new TextDecoder().decode(result.stdout),
    `npm pack for ${packageJson.name}`,
  );
  const packResult = packed[0];
  if (packResult === undefined) {
    throw new Error(`npm pack returned no result for ${packageJson.name}`);
  }

  if (packageJson.name.startsWith("@effect-tls-client/bridge-")) {
    const expectedBinary = packageJson.name.endsWith("win32-x64") ? "bin/bridge.exe" : "bin/bridge";
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
  throw new Error(`release packages must share one version; got ${[...versions].join(", ")}`);
}

writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`packed ${manifest.length} packages in ${outputDirectory}`);
