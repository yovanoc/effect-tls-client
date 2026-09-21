import { fileURLToPath } from "node:url";

export const REPORT_MARKER =
  "<!-- effect-tls-client performance and size report -->";

const PACKAGE_NAMES = new Set([
  "effect-tls-client",
  "@effect-tls-client/bridge-darwin-arm64",
  "@effect-tls-client/bridge-darwin-x64",
  "@effect-tls-client/bridge-linux-arm64",
  "@effect-tls-client/bridge-linux-x64",
  "@effect-tls-client/bridge-win32-x64",
]);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const finite = (value, name) => {
  assert(
    typeof value === "number" && Number.isFinite(value),
    `${name} must be finite`,
  );
  return value;
};

const positive = (value, name) => {
  finite(value, name);
  assert(value > 0, `${name} must be positive`);
  return value;
};

const integer = (value, name) => {
  finite(value, name);
  assert(Number.isInteger(value), `${name} must be an integer`);
  return value;
};

const percentDifference = (base, current) =>
  base === 0 ? null : ((current - base) / base) * 100;

const sameNumber = (left, right) =>
  (left === null && right === null) ||
  (typeof left === "number" &&
    typeof right === "number" &&
    Math.abs(left - right) < 0.000001);

const validateBenchmark = (benchmark, name) => {
  assert(
    benchmark && typeof benchmark === "object",
    `${name} must be an object`,
  );
  assert(benchmark.name === "fake-bridge-request", `${name}.name is invalid`);
  positive(benchmark.medianElapsedMs, `${name}.medianElapsedMs`);
  positive(
    benchmark.millisecondsPerOperation,
    `${name}.millisecondsPerOperation`,
  );
  positive(benchmark.operationsPerSecond, `${name}.operationsPerSecond`);
  integer(benchmark.operationsPerSample, `${name}.operationsPerSample`);
  integer(benchmark.warmupOperations, `${name}.warmupOperations`);
  integer(benchmark.samples, `${name}.samples`);
  assert(
    benchmark.operationsPerSample > 0,
    `${name}.operationsPerSample must be positive`,
  );
  assert(benchmark.samples > 0, `${name}.samples must be positive`);
  assert(
    Array.isArray(benchmark.sampleElapsedMs) &&
      benchmark.sampleElapsedMs.length === benchmark.samples,
    `${name}.sampleElapsedMs must contain one value per sample`,
  );
  benchmark.sampleElapsedMs.forEach((value, index) =>
    positive(value, `${name}.sampleElapsedMs[${index}]`),
  );
};

export const validateReport = (report) => {
  assert(report && typeof report === "object", "report must be an object");
  assert(report.schemaVersion === 1, "unsupported report schema");
  const threshold = positive(report.thresholdPercent, "thresholdPercent");
  assert(threshold <= 100, "thresholdPercent is too large");

  const benchmark = report.benchmark;
  assert(
    benchmark && typeof benchmark === "object",
    "benchmark must be an object",
  );
  validateBenchmark(benchmark.base, "benchmark.base");
  validateBenchmark(benchmark.pr, "benchmark.pr");
  const expectedBenchmarkDifference = percentDifference(
    benchmark.base.medianElapsedMs,
    benchmark.pr.medianElapsedMs,
  );
  assert(
    sameNumber(benchmark.differencePercent, expectedBenchmarkDifference),
    "benchmark.differencePercent is incorrect",
  );
  assert(
    benchmark.regression ===
      (expectedBenchmarkDifference !== null &&
        expectedBenchmarkDifference > threshold),
    "benchmark.regression is incorrect",
  );

  assert(Array.isArray(report.packages), "packages must be an array");
  assert(
    report.packages.length === PACKAGE_NAMES.size,
    "report must contain all packages",
  );
  const seenPackages = new Set();
  for (const [index, entry] of report.packages.entries()) {
    assert(
      entry && typeof entry === "object",
      `packages[${index}] must be an object`,
    );
    assert(PACKAGE_NAMES.has(entry.name), `unknown package: ${entry.name}`);
    assert(!seenPackages.has(entry.name), `duplicate package: ${entry.name}`);
    seenPackages.add(entry.name);
    integer(entry.baseBytes, `packages[${index}].baseBytes`);
    integer(entry.prBytes, `packages[${index}].prBytes`);
    assert(
      entry.baseBytes > 0,
      `packages[${index}].baseBytes must be positive`,
    );
    assert(entry.prBytes > 0, `packages[${index}].prBytes must be positive`);
    const expectedDifference = percentDifference(
      entry.baseBytes,
      entry.prBytes,
    );
    assert(
      sameNumber(entry.differencePercent, expectedDifference),
      `packages[${index}].differencePercent is incorrect`,
    );
    assert(
      entry.differenceBytes === entry.prBytes - entry.baseBytes,
      `packages[${index}].differenceBytes is incorrect`,
    );
    assert(
      entry.regression ===
        (expectedDifference !== null && expectedDifference > threshold),
      `packages[${index}].regression is incorrect`,
    );
  }
  assert(
    seenPackages.size === PACKAGE_NAMES.size,
    "report contains an incomplete package set",
  );
  return report;
};

const signed = (value, digits = 2) => {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
};

const bytes = (value) => `${value.toLocaleString("en-US")} B`;
const milliseconds = (value) => `${value.toFixed(3)} ms/op`;
const operations = (value) =>
  `${Math.round(value).toLocaleString("en-US")} ops/s`;

export const renderReport = (report) => {
  validateReport(report);
  const lines = [
    REPORT_MARKER,
    "## Performance",
    "",
    "| Case | Base | PR | Difference |",
    "| --- | ---: | ---: | ---: |",
    `| Fake Bridge request | ${milliseconds(report.benchmark.base.millisecondsPerOperation)} (${operations(report.benchmark.base.operationsPerSecond)}) | ${milliseconds(report.benchmark.pr.millisecondsPerOperation)} (${operations(report.benchmark.pr.operationsPerSecond)}) | ${signed(report.benchmark.differencePercent)} |`,
    "",
    "## Package Size",
    "",
    "| Package | Base | PR | Difference |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const entry of report.packages) {
    lines.push(
      `| ${entry.name} | ${bytes(entry.baseBytes)} | ${bytes(entry.prBytes)} | ${signed(entry.differencePercent)} (${entry.differenceBytes >= 0 ? "+" : ""}${entry.differenceBytes.toLocaleString("en-US")} B) |`,
    );
  }
  lines.push(
    "",
    `Regression threshold: ${report.thresholdPercent.toFixed(2)}%. Regressions are reported only; this check does not fail on the threshold.`,
    "",
  );
  return lines.join("\n");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] !== "--validate" || args.length !== 3) {
    console.error(
      "usage: node scripts/performance-report.mjs --validate REPORT.json REPORT.md",
    );
    process.exitCode = 2;
  } else {
    try {
      const { readFileSync } = await import("node:fs");
      const report = JSON.parse(readFileSync(args[1], "utf8"));
      const markdown = readFileSync(args[2], "utf8");
      assert(markdown.length <= 16_384, "report Markdown is too large");
      assert(
        markdown === renderReport(report),
        "report Markdown does not match report JSON",
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
