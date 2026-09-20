import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderReport, validateReport } from "./performance-report.mjs";

const REGRESSION_THRESHOLD_PERCENT = 10;
const args = process.argv.slice(2);
const baseRef =
  args[0]?.startsWith("-") === true ? "main" : (args[0] ?? "main");

const argument = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const repositoryRoot = resolve(process.cwd());
const benchmarkScript = join(repositoryRoot, "scripts/benchmark.ts");
const packageSizeScript = join(repositoryRoot, "scripts/package-size.ts");
const releasePackScript = join(repositoryRoot, "scripts/release-pack.ts");
const markdownOutput = argument("--markdown");
const jsonOutput = argument("--json");
const temporaryDirectory =
  process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? "/tmp";
const temporaryRoot = mkdtempSync(
  join(temporaryDirectory, "effect-tls-client-performance-"),
);
const baseRoot = join(temporaryRoot, "base");
let worktreeAdded = false;

const run = (
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): void => {
  try {
    const result = spawnSync(command[0] ?? "", command.slice(1), {
      cwd,
      env: { ...process.env, ...environment },
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(
        `${command.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
      );
    }
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message.includes("failed with exit code")
    ) {
      throw cause;
    }
    throw new Error(`${command.join(" ")} could not start`, { cause });
  }
};

const readJson = <T>(path: string): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (cause) {
    throw new Error(`cannot parse ${path}`, { cause });
  }
};

const writeOutput = (path: string, content: string): void => {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
};

type BenchmarkReport = {
  readonly schemaVersion: 1;
  readonly benchmark: {
    readonly name: "fake-bridge-request";
    readonly operationsPerSample: number;
    readonly warmupOperations: number;
    readonly samples: number;
    readonly sampleElapsedMs: ReadonlyArray<number>;
    readonly medianElapsedMs: number;
    readonly millisecondsPerOperation: number;
    readonly operationsPerSecond: number;
  };
};

type PackageSizeReport = {
  readonly schemaVersion: 1;
  readonly packages: ReadonlyArray<{
    readonly name: string;
    readonly filename: string;
    readonly bytes: number;
  }>;
};

type ComparisonReport = {
  readonly schemaVersion: 1;
  readonly thresholdPercent: number;
  readonly benchmark: {
    readonly name: "fake-bridge-request";
    readonly base: BenchmarkReport["benchmark"];
    readonly pr: BenchmarkReport["benchmark"];
    readonly differencePercent: number | null;
    readonly regression: boolean;
  };
  readonly packages: ReadonlyArray<{
    readonly name: string;
    readonly baseBytes: number;
    readonly prBytes: number;
    readonly differenceBytes: number;
    readonly differencePercent: number | null;
    readonly regression: boolean;
  }>;
};

const differencePercent = (base: number, current: number): number | null =>
  base === 0 ? null : ((current - base) / base) * 100;

const measure = (root: string, outputRoot: string): void => {
  const benchmarkJson = join(outputRoot, "benchmark.json");
  const packageSizeJson = join(outputRoot, "package-size.json");
  const packageDirectory = join(outputRoot, "packages");
  run(
    ["bun", benchmarkScript, "--root", root, "--json", benchmarkJson],
    repositoryRoot,
  );
  run(["bun", releasePackScript], repositoryRoot, {
    RELEASE_PACK_ROOT: root,
    RELEASE_PACK_DIR: packageDirectory,
  });
  run(
    [
      "bun",
      packageSizeScript,
      "--pack-dir",
      packageDirectory,
      "--json",
      packageSizeJson,
    ],
    repositoryRoot,
  );
};

const runComparison = (): void => {
  run(
    ["git", "worktree", "add", "--detach", baseRoot, baseRef],
    repositoryRoot,
  );
  worktreeAdded = true;

  const currentOutput = join(temporaryRoot, "current");
  const baseOutput = join(temporaryRoot, "base-results");
  run(["bun", "run", "build"], repositoryRoot);
  measure(repositoryRoot, currentOutput);

  run(["bun", "install", "--frozen-lockfile"], baseRoot);
  run(["bun", "run", "build"], baseRoot);
  measure(baseRoot, baseOutput);

  const currentBenchmark = readJson<BenchmarkReport>(
    join(currentOutput, "benchmark.json"),
  );
  const baseBenchmark = readJson<BenchmarkReport>(
    join(baseOutput, "benchmark.json"),
  );
  const currentSizes = readJson<PackageSizeReport>(
    join(currentOutput, "package-size.json"),
  );
  const baseSizes = readJson<PackageSizeReport>(
    join(baseOutput, "package-size.json"),
  );
  const baseByPackage = new Map(
    baseSizes.packages.map((entry) => [entry.name, entry]),
  );

  const benchmarkDifference = differencePercent(
    baseBenchmark.benchmark.medianElapsedMs,
    currentBenchmark.benchmark.medianElapsedMs,
  );
  const report: ComparisonReport = {
    schemaVersion: 1,
    thresholdPercent: REGRESSION_THRESHOLD_PERCENT,
    benchmark: {
      name: "fake-bridge-request",
      base: baseBenchmark.benchmark,
      pr: currentBenchmark.benchmark,
      differencePercent: benchmarkDifference,
      regression:
        benchmarkDifference !== null &&
        benchmarkDifference > REGRESSION_THRESHOLD_PERCENT,
    },
    packages: currentSizes.packages.map((entry) => {
      const base = baseByPackage.get(entry.name);
      if (base === undefined)
        throw new Error(`base size is missing for ${entry.name}`);
      const packageDifference = differencePercent(base.bytes, entry.bytes);
      return {
        name: entry.name,
        baseBytes: base.bytes,
        prBytes: entry.bytes,
        differenceBytes: entry.bytes - base.bytes,
        differencePercent: packageDifference,
        regression:
          packageDifference !== null &&
          packageDifference > REGRESSION_THRESHOLD_PERCENT,
      };
    }),
  };
  validateReport(report);
  const markdown = renderReport(report);
  if (jsonOutput !== undefined) {
    writeOutput(jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (markdownOutput !== undefined) writeOutput(markdownOutput, markdown);
  if (markdownOutput === undefined) process.stdout.write(`${markdown}\n`);
};

let failure: unknown;
try {
  runComparison();
} catch (error) {
  failure = error;
}

let cleanupFailure: Error | undefined;
try {
  if (worktreeAdded) {
    const result = spawnSync(
      "git",
      ["worktree", "remove", "--force", baseRoot],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    if (result.status !== 0) {
      cleanupFailure = new Error("could not remove benchmark base worktree");
    }
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (existsSync(temporaryRoot)) {
    cleanupFailure = new Error(
      `temporary benchmark directory still exists: ${temporaryRoot}`,
    );
  }
} catch (error) {
  cleanupFailure = error instanceof Error ? error : new Error(String(error));
}

if (failure !== undefined) throw failure;
if (cleanupFailure !== undefined) throw cleanupFailure;
