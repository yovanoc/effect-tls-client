import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const argument = (
  args: ReadonlyArray<string>,
  name: string,
): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const parseJson = <T>(path: string): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (cause) {
    throw new Error(`cannot parse ${path}`, { cause });
  }
};

const writeOutput = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

type ManifestEntry = {
  readonly name: string;
  readonly filename: string;
};

type PackageSizeReport = {
  readonly schemaVersion: 1;
  readonly packages: ReadonlyArray<{
    readonly name: string;
    readonly filename: string;
    readonly bytes: number;
  }>;
};

const args = process.argv.slice(2);
const packDirectory = resolve(
  argument(args, "--pack-dir") ??
    process.env.RELEASE_PACK_DIR ??
    "release-packages",
);
const jsonPath = argument(args, "--json");
const markdownPath = argument(args, "--markdown");
const manifestPath = `${packDirectory}/manifest.json`;

if (!existsSync(manifestPath)) {
  throw new Error(
    `release package manifest not found at ${manifestPath}; run bun run release:pack first`,
  );
}

const manifest = parseJson<ReadonlyArray<ManifestEntry>>(manifestPath)
  .map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      typeof entry.filename !== "string"
    ) {
      throw new Error(`invalid package entry in ${manifestPath}`);
    }
    const tarball = resolve(packDirectory, entry.filename);
    const relativeTarball = relative(packDirectory, tarball);
    if (
      relativeTarball === "" ||
      relativeTarball.startsWith("..") ||
      isAbsolute(relativeTarball) ||
      !existsSync(tarball)
    ) {
      throw new Error(`missing package tarball for ${entry.name}`);
    }
    return {
      name: entry.name,
      filename: entry.filename,
      bytes: statSync(tarball).size,
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const report: PackageSizeReport = {
  schemaVersion: 1,
  packages: manifest,
};
const markdown = [
  "## Package size",
  "",
  "| Package | Compressed npm tarball |",
  "| --- | ---: |",
  ...manifest.map(
    (entry) => `| ${entry.name} | ${entry.bytes.toLocaleString("en-US")} B |`,
  ),
  "",
].join("\n");

if (jsonPath !== undefined)
  writeOutput(resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
if (markdownPath !== undefined) writeOutput(resolve(markdownPath), markdown);
if (markdownPath === undefined) process.stdout.write(markdown);
