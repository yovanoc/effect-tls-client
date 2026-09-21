import { basename, dirname, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  type Server as HttpsServer,
  createServer as createHttpsServer,
} from "node:https";
import {
  type Server as NetServer,
  type Socket as NetSocket,
  createConnection,
} from "node:net";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

interface ProcessMemory {
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly rss: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly bridgeRss: number | null;
}

interface Counters {
  httpStarted: number;
  httpCompleted: number;
  httpFailed: number;
  httpStatusFailures: number;
  wsWriteAttempts: number;
  wsSent: number;
  wsReceived: number;
  wsWriteFailures: number;
  wsReadFailures: number;
}

interface ServerCounters {
  httpRequests: number;
  httpRejected: number;
  wsReceived: number;
  wsSent: number;
  wsRejected: number;
}

interface WebSocketPeer {
  readonly socket: Duplex;
  input: Buffer;
}

interface ProxyEndpoint {
  readonly url: string;
  readonly close: () => Promise<void>;
}

interface LatencySamples {
  readonly values: Array<number>;
  cursor: number;
  total: number;
}

const repositoryRoot = resolve(process.env["TLS_CLIENT_LOAD_ROOT"] ?? ".");
const packagePath = join(
  repositoryRoot,
  "packages/effect-tls-client/dist/index.mjs",
);
const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const sessionCount = positiveInteger("TLS_CLIENT_LOAD_SESSIONS", 1000);
const durationSeconds = positiveNumber("TLS_CLIENT_LOAD_DURATION_SECONDS", 30);
const webSocketMessagesPerSecond = positiveNumber(
  "TLS_CLIENT_LOAD_WS_MESSAGES_PER_SECOND",
  10,
);
const httpRequestsPerSecond = positiveNumber(
  "TLS_CLIENT_LOAD_HTTP_REQUESTS_PER_SECOND",
  1,
);
const setupConcurrency = positiveInteger(
  "TLS_CLIENT_LOAD_SETUP_CONCURRENCY",
  50,
);
const latencySampleLimit = positiveInteger(
  "TLS_CLIENT_LOAD_LATENCY_SAMPLES",
  500_000,
);
const operationTimeoutMs = positiveInteger(
  "TLS_CLIENT_LOAD_OPERATION_TIMEOUT_MS",
  5_000,
);
const reportPath = process.env["TLS_CLIENT_LOAD_REPORT"];
const stopping = { value: false };
const httpUrlTemplate = process.env["TLS_CLIENT_LOAD_HTTP_URL"];
const webSocketUrlTemplate = process.env["TLS_CLIENT_LOAD_WS_URL"];
const proxyUrlInput = process.env["TLS_CLIENT_LOAD_PROXY_URLS"];
const proxyUrlTemplates =
  proxyUrlInput === undefined
    ? undefined
    : proxyUrlInput
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
const localFixture =
  httpUrlTemplate === undefined && webSocketUrlTemplate === undefined;

if (!bridgePath) {
  throw new Error("TLS_CLIENT_BRIDGE_PATH is required");
}
if (!existsSync(packagePath)) {
  throw new Error(
    `built package not found at ${packagePath}; run bun run build first`,
  );
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = positiveNumber(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (["1", "true", "yes"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

const insecureSkipVerify = booleanValue(
  "TLS_CLIENT_LOAD_INSECURE_SKIP_VERIFY",
  localFixture,
);

const expandEndpoint = (template: string, id: number): string =>
  template.replaceAll("{id}", String(id));

const configuredProxyUrls =
  proxyUrlTemplates === undefined
    ? undefined
    : proxyUrlTemplates.length === 1 && proxyUrlTemplates[0]?.includes("{id}")
      ? Array.from({ length: sessionCount }, (_, id) =>
          expandEndpoint(proxyUrlTemplates[0]!, id),
        )
      : proxyUrlTemplates.length === sessionCount
        ? proxyUrlTemplates.map((value, id) => expandEndpoint(value, id))
        : (() => {
            throw new Error(
              "TLS_CLIENT_LOAD_PROXY_URLS must contain one {id} template or one URL per session",
            );
          })();

if (configuredProxyUrls !== undefined) {
  if (configuredProxyUrls.some((value) => value.length === 0)) {
    throw new Error("TLS_CLIENT_LOAD_PROXY_URLS contains an empty URL");
  }
  if (new Set(configuredProxyUrls).size !== sessionCount) {
    throw new Error(
      "TLS_CLIENT_LOAD_PROXY_URLS must provide a unique URL per session",
    );
  }
}

const packageRequire = createRequire(join(repositoryRoot, "package.json"));
const importPackage = async (name: string): Promise<unknown> =>
  import(pathToFileURL(packageRequire.resolve(name)).href);

const [effectModule, platformModule, clientModule, httpModule, socketModule] =
  await Promise.all([
    importPackage("effect"),
    importPackage("@effect/platform-node"),
    import(pathToFileURL(packagePath).href),
    importPackage("effect/unstable/http"),
    importPackage("effect/unstable/socket/Socket"),
  ]);

const { ConfigProvider, Duration, Effect, Layer } =
  effectModule as typeof import("effect");
const { NodeServices } =
  platformModule as typeof import("@effect/platform-node");
const { TlsClient } =
  clientModule as typeof import("../packages/effect-tls-client/src/index.js");
const { Cookies } = httpModule as typeof import("effect/unstable/http");
const { CloseEvent } =
  socketModule as typeof import("effect/unstable/socket/Socket");

const stopController = new AbortController();
let interrupted = false;
const onSignal = (): void => {
  interrupted = true;
  stopping.value = true;
  stopController.abort();
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
const waitForDurationOrSignal = Effect.race(
  Effect.sleep(Duration.millis(durationSeconds * 1000)),
  Effect.callback<void>((resume) => {
    const onAbort = (): void => resume(Effect.void);
    if (stopController.signal.aborted) {
      onAbort();
      return;
    }
    stopController.signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() =>
      stopController.signal.removeEventListener("abort", onAbort),
    );
  }),
);

const listen = (server: NetServer | HttpsServer): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("load benchmark server did not expose a port"));
        return;
      }
      resolve(address.port);
    });
  });

const closeServer = (server: NetServer | HttpsServer): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      const code = "code" in error ? error.code : undefined;
      if (code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    });
  });

const cookieValue = (id: number): string => `account-${id}=token-${id}`;
const requestPath = (id: number): string => `/request/${id}`;
const webSocketPath = (id: number): string => `/socket/${id}`;

const hasAccountCookie = (
  headers: Record<string, string | string[] | undefined>,
  id: number,
): boolean =>
  (headers.cookie ?? "")
    .toString()
    .split(";")
    .some((value) => value.trim() === cookieValue(id));

const writeWebSocketFrame = (
  socket: Duplex,
  opcode: number,
  body: Uint8Array,
): void => {
  if (socket.destroyed) return;
  const length = body.byteLength;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, Buffer.from(body)]));
};

const handleWebSocketData = (
  peer: WebSocketPeer,
  counters: ServerCounters,
): void => {
  while (peer.input.byteLength >= 2) {
    const first = peer.input[0]!;
    const second = peer.input[1]!;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (peer.input.byteLength < 4) return;
      length = peer.input.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (peer.input.byteLength < 10) return;
      const largeLength = Number(peer.input.readBigUInt64BE(2));
      if (!Number.isSafeInteger(largeLength)) {
        peer.socket.destroy();
        return;
      }
      length = largeLength;
      offset = 10;
    }
    if ((second & 0x80) === 0) {
      peer.socket.destroy();
      return;
    }
    if (peer.input.byteLength < offset + 4 + length) return;

    const mask = peer.input.subarray(offset, offset + 4);
    const body = peer.input.subarray(offset + 4, offset + 4 + length);
    const decoded = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      decoded[index] = body[index]! ^ mask[index % 4]!;
    }
    peer.input = peer.input.subarray(offset + 4 + length);

    const opcode = first & 0x0f;
    if (opcode === 8) {
      writeWebSocketFrame(peer.socket, 8, decoded);
      peer.socket.end();
      return;
    }
    if (opcode === 9) {
      writeWebSocketFrame(peer.socket, 10, decoded);
      continue;
    }
    if (opcode === 1 || opcode === 2) {
      counters.wsReceived += 1;
      counters.wsSent += 1;
      writeWebSocketFrame(peer.socket, opcode, decoded);
    }
  }
};

const startTargetServer = async (): Promise<{
  readonly httpUrl: (id: number) => string;
  readonly webSocketUrl: (id: number) => string;
  readonly counters: ServerCounters;
  readonly close: () => Promise<void>;
}> => {
  const counters: ServerCounters = {
    httpRequests: 0,
    httpRejected: 0,
    wsReceived: 0,
    wsSent: 0,
    wsRejected: 0,
  };
  const peers = new Set<WebSocketPeer>();
  const sockets = new Set<NetSocket>();
  const key = readFileSync(
    new URL(
      "../packages/effect-tls-client/tests/fixtures/localhost-key.pem",
      import.meta.url,
    ),
    "utf8",
  );
  const cert = readFileSync(
    new URL(
      "../packages/effect-tls-client/tests/fixtures/localhost-cert.pem",
      import.meta.url,
    ),
    "utf8",
  );
  const server = createHttpsServer({ key, cert }, (request, response) => {
    const path = new URL(
      request.url ?? "/",
      `https://${request.headers.host ?? "load.test"}`,
    ).pathname;
    const match = /^\/request\/(\d+)$/.exec(path);
    const id = match === null ? -1 : Number(match[1]);
    const valid = id >= 0 && hasAccountCookie(request.headers, id);
    counters.httpRequests += 1;
    if (!valid) counters.httpRejected += 1;
    response.writeHead(valid ? 200 : 401, { "content-type": "text/plain" });
    response.end(valid ? "ok" : "invalid");
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(
      request.url ?? "/",
      `https://${request.headers.host ?? "load.test"}`,
    ).pathname;
    const match = /^\/socket\/(\d+)$/.exec(path);
    const id = match === null ? -1 : Number(match[1]);
    const keyHeader = request.headers["sec-websocket-key"];
    if (
      id < 0 ||
      !hasAccountCookie(request.headers, id) ||
      typeof keyHeader !== "string"
    ) {
      counters.wsRejected += 1;
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${keyHeader}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const peer: WebSocketPeer = {
      socket,
      input: Buffer.from(head),
    };
    peers.add(peer);
    socket.on("data", (chunk) => {
      peer.input = Buffer.concat([peer.input, Buffer.from(chunk)]);
      handleWebSocketData(peer, counters);
    });
    const remove = () => peers.delete(peer);
    socket.once("close", remove);
    socket.once("error", remove);
    handleWebSocketData(peer, counters);
  });

  const port = await listen(server);
  return {
    httpUrl: (id) => `https://127.0.0.1:${port}${requestPath(id)}`,
    webSocketUrl: (id) => `wss://127.0.0.1:${port}${webSocketPath(id)}`,
    counters,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      peers.clear();
      await closeServer(server);
    },
  };
};

const startProxy = async (index: number): Promise<ProxyEndpoint> => {
  const sockets = new Set<Duplex>();
  const server = createHttpServer();
  const track = (socket: Duplex): void => {
    sockets.add(socket);
    const remove = () => sockets.delete(socket);
    socket.once("close", remove);
    socket.once("error", remove);
  };
  server.on("connect", (request, client, head) => {
    track(client);
    const targetUrl = `http://${request.url ?? ""}`;
    const target = URL.parse(targetUrl);
    if (target === null) {
      client.destroy();
      return;
    }
    const port = Number(target.port);
    if (!target.hostname || !Number.isInteger(port) || port <= 0) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: target.hostname, port });
    track(upstream);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
  });
  const port = await listen(server);
  return {
    url: `http://account-${index}:secret@127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
};

const startProxies = async (count: number): Promise<ProxyEndpoint[]> => {
  const proxies: ProxyEndpoint[] = [];
  try {
    for (let offset = 0; offset < count; offset += setupConcurrency) {
      const results = await Promise.allSettled(
        Array.from(
          { length: Math.min(setupConcurrency, count - offset) },
          (_, index) => startProxy(offset + index),
        ),
      );
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      const batch = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (failed !== undefined) {
        await Promise.all(batch.map((proxy) => proxy.close()));
        throw failed.reason;
      }
      proxies.push(...batch);
    }
    return proxies;
  } catch (error) {
    await Promise.all(proxies.map((proxy) => proxy.close()));
    throw error;
  }
};

const readBridgeRss = (): number | null => {
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-Ao", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const bridgeName = basename(resolve(bridgePath));
  let total = 0;
  for (const line of String(result.stdout).split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[1] !== String(process.pid)) continue;
    if (!parts.slice(3).join(" ").includes(bridgeName)) continue;
    const rssKb = Number(parts[2]);
    if (Number.isFinite(rssKb)) total += rssKb * 1024;
  }
  return total === 0 ? null : total;
};

const readMemory = (): ProcessMemory => {
  const memory = process.memoryUsage();
  return {
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    rss: memory.rss,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    bridgeRss: readBridgeRss(),
  };
};

const readOpenFileCount = (): number | null => {
  if (process.platform === "win32") return null;
  try {
    return readdirSync("/dev/fd").length;
  } catch {
    return null;
  }
};

const maxMemory = (
  left: ProcessMemory,
  right: ProcessMemory,
): ProcessMemory => ({
  heapUsed: Math.max(left.heapUsed, right.heapUsed),
  heapTotal: Math.max(left.heapTotal, right.heapTotal),
  rss: Math.max(left.rss, right.rss),
  external: Math.max(left.external, right.external),
  arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
  bridgeRss:
    left.bridgeRss === null || right.bridgeRss === null
      ? (right.bridgeRss ?? left.bridgeRss)
      : Math.max(left.bridgeRss, right.bridgeRss),
});

const recordLatency = (samples: LatencySamples, value: number): void => {
  samples.total += 1;
  if (samples.values.length < latencySampleLimit) {
    samples.values.push(value);
    return;
  }
  samples.values[samples.cursor] = value;
  samples.cursor = (samples.cursor + 1) % latencySampleLimit;
};

const summarizeLatency = (samples: LatencySamples) => {
  const sorted = [...samples.values].sort((left, right) => left - right);
  const quantile = (value: number): number | null =>
    sorted.length === 0
      ? null
      : (sorted[
          Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value))
        ] ?? null);
  return {
    maxMs: sorted.at(-1) ?? null,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    samples: sorted.length,
    total: samples.total,
  };
};

const counters: Counters = {
  httpStarted: 0,
  httpCompleted: 0,
  httpFailed: 0,
  httpStatusFailures: 0,
  wsWriteAttempts: 0,
  wsSent: 0,
  wsReceived: 0,
  wsWriteFailures: 0,
  wsReadFailures: 0,
};
const httpLatencies: LatencySamples = { cursor: 0, total: 0, values: [] };
const webSocketLatencies: LatencySamples = {
  cursor: 0,
  total: 0,
  values: [],
};
const target = await startTargetServer();
let proxies: ProxyEndpoint[] = [];
let baseline = readMemory();
let baselineOpenFiles = readOpenFileCount();
let setup: ProcessMemory | undefined;
let setupOpenFiles: number | null = null;
let peak = baseline;
let peakOpenFiles = baselineOpenFiles;
let workload:
  | {
      readonly elapsedSeconds: number;
    }
  | undefined;
let afterBridge: ProcessMemory | undefined;
let afterBridgeOpenFiles: number | null;
let workloadCpuStart: NodeJS.CpuUsage | undefined;
let workloadCpu: NodeJS.CpuUsage | undefined;
const sampleMemory = (): void => {
  peak = maxMemory(peak, readMemory());
  const openFiles = readOpenFileCount();
  if (openFiles !== null) {
    peakOpenFiles =
      peakOpenFiles === null ? openFiles : Math.max(peakOpenFiles, openFiles);
  }
};
const sampler = setInterval(sampleMemory, 1000);

try {
  if (configuredProxyUrls === undefined) {
    proxies = await startProxies(sessionCount);
  }
  baseline = readMemory();
  baselineOpenFiles = readOpenFileCount();
  peakOpenFiles = baselineOpenFiles;

  const specs = Array.from({ length: sessionCount }, (_, id) => ({
    id,
    httpUrl:
      httpUrlTemplate === undefined
        ? target.httpUrl(id)
        : expandEndpoint(httpUrlTemplate, id),
    proxyUrl:
      configuredProxyUrls === undefined
        ? proxies[id]!.url
        : configuredProxyUrls[id]!,
    webSocketUrl:
      webSocketUrlTemplate === undefined
        ? target.webSocketUrl(id)
        : expandEndpoint(webSocketUrlTemplate, id),
  }));
  const layer = TlsClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
        ),
      ),
    ),
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const accounts = yield* Effect.forEach(
          specs,
          (spec) =>
            Effect.gen(function* () {
              const session = yield* client.session({
                profile: "chrome_146",
                proxyUrl: spec.proxyUrl,
                insecureSkipVerify,
                timeoutMs: operationTimeoutMs,
              });
              yield* session.setCookies(
                spec.httpUrl,
                Cookies.fromSetCookie(cookieValue(spec.id)),
              );
              const socket = yield* session.webSocket(spec.webSocketUrl);
              const reader = yield* socket.reader;
              const writer = yield* socket.writer;
              const sentTimestamps: Array<number> = [];
              return {
                httpUrl: spec.httpUrl,
                payload: new Uint8Array([spec.id % 256]),
                reader,
                receivedCount: 0,
                sentTimestamps,
                session,
                writer,
              };
            }),
          { concurrency: setupConcurrency },
        );
        setup = readMemory();
        setupOpenFiles = readOpenFileCount();
        peak = maxMemory(peak, setup);
        if (setupOpenFiles !== null) {
          peakOpenFiles =
            peakOpenFiles === null
              ? setupOpenFiles
              : Math.max(peakOpenFiles, setupOpenFiles);
        }
        stopping.value = interrupted;
        workloadCpuStart = process.cpuUsage();
        const startedAt = performance.now();
        const wsIntervalMs = 1000 / webSocketMessagesPerSecond;
        const httpIntervalMs = 1000 / httpRequestsPerSecond;

        yield* Effect.forEach(
          accounts,
          (account) =>
            Effect.gen(function* () {
              let nextWebSocketAt = startedAt;
              let nextHttpAt = startedAt;
              yield* Effect.forever(
                account.reader.pull.pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (stopping.value) return;
                      counters.wsReceived += 1;
                      const sentAt =
                        account.sentTimestamps[account.receivedCount];
                      account.receivedCount += 1;
                      if (sentAt !== undefined) {
                        recordLatency(
                          webSocketLatencies,
                          performance.now() - sentAt,
                        );
                      }
                    }),
                  ),
                  Effect.catch(() =>
                    Effect.sync(() => {
                      if (!stopping.value) counters.wsReadFailures += 1;
                    }).pipe(Effect.andThen(Effect.never)),
                  ),
                ),
              ).pipe(Effect.forkScoped);
              yield* Effect.forever(
                Effect.gen(function* () {
                  if (stopping.value) yield* Effect.never;
                  const waitMs = nextWebSocketAt - performance.now();
                  if (waitMs > 0) {
                    yield* Effect.sleep(Duration.millis(waitMs));
                  }
                  nextWebSocketAt = Math.max(
                    nextWebSocketAt + wsIntervalMs,
                    performance.now(),
                  );
                  const sentAt = performance.now();
                  if (!stopping.value) counters.wsWriteAttempts += 1;
                  account.sentTimestamps.push(sentAt);
                  let sent = false;
                  yield* account.writer.write(account.payload).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        sent = true;
                        if (!stopping.value) counters.wsSent += 1;
                      }),
                    ),
                    Effect.catch(() => Effect.void),
                  );
                  if (!sent) account.sentTimestamps.pop();
                  if (!sent && !stopping.value) counters.wsWriteFailures += 1;
                }),
              ).pipe(Effect.forkScoped);
              yield* Effect.forever(
                Effect.gen(function* () {
                  if (stopping.value) yield* Effect.never;
                  const waitMs = nextHttpAt - performance.now();
                  if (waitMs > 0) {
                    yield* Effect.sleep(Duration.millis(waitMs));
                  }
                  nextHttpAt = Math.max(
                    nextHttpAt + httpIntervalMs,
                    performance.now(),
                  );
                  const started = performance.now();
                  let completed = false;
                  if (!stopping.value) counters.httpStarted += 1;
                  yield* account.session.request(account.httpUrl).pipe(
                    Effect.flatMap((response) =>
                      response.bytes.pipe(Effect.map(() => response.status)),
                    ),
                    Effect.tap((status) =>
                      Effect.sync(() => {
                        completed = true;
                        if (!stopping.value) {
                          if (status >= 400) {
                            counters.httpStatusFailures += 1;
                          } else {
                            counters.httpCompleted += 1;
                            recordLatency(
                              httpLatencies,
                              performance.now() - started,
                            );
                          }
                        }
                      }),
                    ),
                    Effect.catch(() => Effect.void),
                  );
                  if (!completed && !stopping.value) counters.httpFailed += 1;
                }),
              ).pipe(Effect.forkScoped);
            }),
          { concurrency: "unbounded", discard: true },
        );
        yield* waitForDurationOrSignal;
        stopping.value = true;
        yield* Effect.forEach(
          accounts,
          (account) =>
            account.writer
              .write(new CloseEvent(1000, "load complete"))
              .pipe(Effect.ignore),
          { concurrency: setupConcurrency, discard: true },
        );
        if (workloadCpuStart !== undefined) {
          workloadCpu = process.cpuUsage(workloadCpuStart);
        }
        workload = {
          elapsedSeconds: (performance.now() - startedAt) / 1000,
        };
      }).pipe(Effect.provide(layer)),
    ),
  );
} finally {
  clearInterval(sampler);
  sampleMemory();
  afterBridge = readMemory();
  afterBridgeOpenFiles = readOpenFileCount();
  try {
    await target.close();
  } finally {
    await Promise.all(proxies.map((proxy) => proxy.close()));
  }
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}

const afterCleanup = readMemory();

if (
  workload === undefined ||
  setup === undefined ||
  afterBridge === undefined ||
  workloadCpu === undefined
) {
  throw new Error("load benchmark did not complete");
}

const elapsedSeconds = workload.elapsedSeconds;
const report = {
  schemaVersion: 1,
  workload: {
    sessions: sessionCount,
    durationSeconds,
    webSocketMessagesPerSecond,
    httpRequestsPerSecond,
    setupConcurrency,
    latencySampleLimit,
    operationTimeoutMs,
    proxyMode: configuredProxyUrls === undefined ? "local" : "configured",
    targetMode:
      httpUrlTemplate === undefined && webSocketUrlTemplate === undefined
        ? "local"
        : "configured",
    interrupted,
    insecureSkipVerify,
  },
  elapsedSeconds,
  throughput: {
    httpRequestsPerSecond: counters.httpCompleted / elapsedSeconds,
    webSocketSentPerSecond: counters.wsSent / elapsedSeconds,
    webSocketReceivedPerSecond: counters.wsReceived / elapsedSeconds,
  },
  latencyMs: {
    http: summarizeLatency(httpLatencies),
    webSocket: summarizeLatency(webSocketLatencies),
  },
  counters,
  server: target.counters,
  nodeCpuMicros: workloadCpu,
  fileDescriptors: {
    baseline: baselineOpenFiles,
    setup: setupOpenFiles,
    peak: peakOpenFiles,
    afterBridge: afterBridgeOpenFiles,
  },
  memoryBytes: {
    baseline,
    setup,
    peak,
    afterBridge,
    afterCleanup,
    peakDeltaFromBaseline: {
      heapUsed: peak.heapUsed - baseline.heapUsed,
      rss: peak.rss - baseline.rss,
      bridgeRss: {
        baseline: baseline.bridgeRss,
        peak: peak.bridgeRss,
      },
    },
  },
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  const outputPath = resolve(reportPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output);
}
process.stdout.write(output);
if (interrupted) process.exitCode = 130;
