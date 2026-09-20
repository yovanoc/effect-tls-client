import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

type Target = {
  readonly goos: string;
  readonly goarch: string;
  readonly executable: string;
};

type PackageJson = {
  readonly name: string;
  readonly version: string;
};

const targets: Readonly<Record<string, Target>> = {
  "@effect-tls-client/bridge-darwin-arm64": {
    goos: "darwin",
    goarch: "arm64",
    executable: "bridge",
  },
  "@effect-tls-client/bridge-darwin-x64": {
    goos: "darwin",
    goarch: "amd64",
    executable: "bridge",
  },
  "@effect-tls-client/bridge-linux-arm64": {
    goos: "linux",
    goarch: "arm64",
    executable: "bridge",
  },
  "@effect-tls-client/bridge-linux-x64": {
    goos: "linux",
    goarch: "amd64",
    executable: "bridge",
  },
  "@effect-tls-client/bridge-win32-x64": {
    goos: "windows",
    goarch: "amd64",
    executable: "bridge.exe",
  },
};

const hostTarget = (): Target => {
  const goos = process.platform === "win32" ? "windows" : process.platform;
  const goarch = process.arch === "x64" ? "amd64" : process.arch;
  const target = Object.values(targets).find(
    (candidate) => candidate.goos === goos && candidate.goarch === goarch,
  );
  if (target === undefined) {
    throw new Error(`unsupported Bridge host: ${goos}-${goarch}`);
  }
  return target;
};

const readPackage = (path: string): PackageJson => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch (cause) {
    throw new Error(`cannot read package metadata at ${path}`, { cause });
  }
};

const repositoryRoot = join(import.meta.dir, "..");
const bridgeRoot = join(repositoryRoot, "bridge");
const isHostBuild = Bun.argv.includes("--host");
const packageDirectory = process.cwd();
const packageJson = readPackage(
  join(
    isHostBuild
      ? join(repositoryRoot, "packages", "effect-tls-client")
      : packageDirectory,
    "package.json",
  ),
);
const target = isHostBuild ? hostTarget() : targets[packageJson.name];

if (target === undefined) {
  throw new Error(`unsupported Bridge package: ${packageJson.name}`);
}

const output = isHostBuild
  ? join(bridgeRoot, target.executable)
  : join(packageDirectory, "bin", target.executable);

if (!isHostBuild) {
  mkdirSync(join(packageDirectory, "bin"), { recursive: true });
}
rmSync(output, { force: true });
const result = Bun.spawnSync(
  [
    "go",
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X main.version=${packageJson.version}`,
    "-o",
    output,
    ".",
  ],
  {
    cwd: bridgeRoot,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: target.goos,
      GOARCH: target.goarch,
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);

if (result.exitCode !== 0) {
  process.exit(result.exitCode ?? 1);
}
