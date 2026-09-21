import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TlsSession } from "../packages/effect-tls-client/src/TlsClient.js";

const OPERATIONS_PER_SAMPLE = 500;
const WARMUP_OPERATIONS = 100;
const SAMPLES = 9;
const BENCHMARK_NAME = "fake-bridge-request";
const BENCHMARK_URL = "https://benchmark.invalid/request";

const argument = (
  args: ReadonlyArray<string>,
  name: string,
): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const writeOutput = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const round = (value: number, digits: number): number =>
  Number(value.toFixed(digits));

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const packageRoot = resolve(argument(process.argv.slice(2), "--root") ?? ".");
const jsonPath = argument(process.argv.slice(2), "--json");
const markdownPath = argument(process.argv.slice(2), "--markdown");
const packagePath = join(
  packageRoot,
  "packages/effect-tls-client/dist/index.mjs",
);
const fixturePath = join(
  packageRoot,
  "packages/effect-tls-client/tests/fixtures/bridge-fixture.mjs",
);

if (!existsSync(packagePath)) {
  throw new Error(
    `built package not found at ${packagePath}; run bun run build first`,
  );
}
if (!existsSync(fixturePath)) {
  throw new Error(`fake Bridge fixture not found at ${fixturePath}`);
}

const packageRequire = createRequire(join(packageRoot, "package.json"));
const importPackage = async (name: string): Promise<unknown> =>
  import(pathToFileURL(packageRequire.resolve(name)).href);
const [effectModule, platformModule, clientModule] = await Promise.all([
  importPackage("effect"),
  importPackage("@effect/platform-node"),
  import(pathToFileURL(packagePath).href),
]);

const { ConfigProvider, Effect, Layer } =
  effectModule as typeof import("effect");
const { NodeServices } =
  platformModule as typeof import("@effect/platform-node");
const { TlsClient } =
  clientModule as typeof import("../packages/effect-tls-client/src/index.js");

const runOperations = (session: TlsSession, count: number) =>
  Effect.gen(function* () {
    for (let index = 0; index < count; index += 1) {
      const response = yield* session.request(BENCHMARK_URL);
      yield* response.bytes;
    }
  });

const layer = TlsClient.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: fixturePath }),
      ),
    ),
  ),
);

const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* TlsClient;
      const session = yield* client.session({ profile: "chrome_146" });
      yield* runOperations(session, WARMUP_OPERATIONS);

      const samples: Array<number> = [];
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const started = performance.now();
        yield* runOperations(session, OPERATIONS_PER_SAMPLE);
        samples.push(performance.now() - started);
      }

      const medianElapsedMs = median(samples);
      const millisecondsPerOperation = medianElapsedMs / OPERATIONS_PER_SAMPLE;
      return {
        schemaVersion: 1,
        benchmark: {
          name: BENCHMARK_NAME,
          operationsPerSample: OPERATIONS_PER_SAMPLE,
          warmupOperations: WARMUP_OPERATIONS,
          samples: SAMPLES,
          sampleElapsedMs: samples.map((value) => round(value, 3)),
          medianElapsedMs: round(medianElapsedMs, 3),
          millisecondsPerOperation: round(millisecondsPerOperation, 6),
          operationsPerSecond: round(1000 / millisecondsPerOperation, 2),
        },
      };
    }),
  ).pipe(Effect.provide(layer)),
);

const markdown = [
  "## Performance benchmark",
  "",
  "| Case | Median | Throughput |",
  "| --- | ---: | ---: |",
  `| Fake Bridge request | ${result.benchmark.millisecondsPerOperation.toFixed(3)} ms/op | ${Math.round(result.benchmark.operationsPerSecond).toLocaleString("en-US")} ops/s |`,
  "",
  `Fixed workload: ${result.benchmark.operationsPerSample} operations × ${result.benchmark.samples} samples after ${result.benchmark.warmupOperations} warm-up operations.`,
  "",
].join("\n");

if (jsonPath !== undefined)
  writeOutput(resolve(jsonPath), `${JSON.stringify(result, null, 2)}\n`);
if (markdownPath !== undefined) writeOutput(resolve(markdownPath), markdown);
if (markdownPath === undefined) process.stdout.write(markdown);
