import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Result, Stream } from "effect";
import type { Scope } from "effect";
import { NodeServices } from "@effect/platform-node";
import { createServer, type Server } from "node:http";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Bridge } from "../src/internal/Bridge.js";
import { FrameKind } from "../src/internal/Frame.js";
import { TlsClient } from "../src/index.js";

const configuredBridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const realBridgePath = configuredBridgePath ?? "";
const describeRealIntegration =
  configuredBridgePath === undefined ||
  process.env["TLS_CLIENT_INTEGRATION"] !== "1"
    ? describe.skip
    : describe;

const withClientAt = <A, E>(
  path: string,
  effect: Effect.Effect<A, E, TlsClient | Scope.Scope>,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(
        TlsClient.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: path }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

const withBridgeAt = <A, E>(
  path: string,
  effect: Effect.Effect<A, E, Bridge>,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(
        Bridge.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: path }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

const key = readFileSync(
  fileURLToPath(new URL("./fixtures/localhost-key.pem", import.meta.url)),
  "utf8",
);
const cert = readFileSync(
  fileURLToPath(new URL("./fixtures/localhost-cert.pem", import.meta.url)),
  "utf8",
);

type RunningServer = Server | Http2SecureServer;

const listen = (server: RunningServer): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("local test server did not expose an address"));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: RunningServer): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const tryPromise = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);

interface LocalHttp1Server {
  readonly url: string;
  readonly requestHeaders: Promise<ReadonlyArray<readonly [string, string]>>;
  readonly firstChunk: Promise<void>;
  readonly disconnected: Promise<void>;
  readonly close: () => Promise<void>;
}

const startHttp1Server = async (): Promise<LocalHttp1Server> => {
  let resolveRequestHeaders: (
    value: ReadonlyArray<readonly [string, string]>,
  ) => void = () => {};
  let resolveFirstChunk: () => void = () => {};
  let resolveDisconnected: () => void = () => {};
  const requestHeaders = new Promise<ReadonlyArray<readonly [string, string]>>(
    (resolve) => {
      resolveRequestHeaders = resolve;
    },
  );
  const firstChunk = new Promise<void>((resolve) => {
    resolveFirstChunk = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    resolveDisconnected = resolve;
  });
  let disconnectReported = false;
  let cancelTimer: ReturnType<typeof setInterval> | undefined;
  const reportDisconnect = () => {
    if (disconnectReported) return;
    disconnectReported = true;
    if (cancelTimer !== undefined) clearInterval(cancelTimer);
    resolveDisconnected();
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://local").pathname;
    if (path === "/headers") {
      const names = new Set(["x-first", "x-second", "x-identity", "x-replace"]);
      const pairs: Array<readonly [string, string]> = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index];
        const value = request.rawHeaders[index + 1];
        if (
          name !== undefined &&
          value !== undefined &&
          names.has(name.toLowerCase())
        ) {
          pairs.push([name, value]);
        }
      }
      resolveRequestHeaders(pairs);
      response.setHeader("Content-Type", "text/plain");
      response.setHeader("X-Transport", "http1");
      response.end("http/1.1");
      return;
    }
    if (path === "/slow") {
      setTimeout(() => response.end("slow"), 50);
      return;
    }
    if (path === "/large") {
      const total = 50 * 1024 * 1024;
      let offset = 0;
      response.writeHead(200, {
        "Content-Length": total,
        "Content-Type": "application/octet-stream",
      });
      const write = () => {
        if (response.destroyed) return;
        const size = Math.min(64 * 1024, total - offset);
        const body = Buffer.allocUnsafe(size);
        for (let index = 0; index < size; index += 1) {
          body[index] = (offset + index) % 256;
        }
        offset += size;
        if (offset === total) {
          response.end(body);
          return;
        }
        if (!response.write(body)) {
          response.once("drain", write);
        } else {
          setImmediate(write);
        }
      };
      write();
      return;
    }
    if (path === "/cancel") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.alloc(64 * 1024, 7));
      resolveFirstChunk();
      cancelTimer = setInterval(() => {
        if (!response.destroyed) response.write(Buffer.alloc(64 * 1024, 8));
      }, 5);
      request.once("aborted", reportDisconnect);
      response.once("close", reportDisconnect);
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    requestHeaders,
    firstChunk,
    disconnected,
    close: () => close(server),
  };
};

const startHttp2Server = async (): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> => {
  const server = createSecureServer({ key, cert, allowHTTP1: false });
  server.on("request", (request, response) => {
    if (request.url !== "/h2") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "text/plain");
    response.setHeader("x-transport", "http2");
    response.end("https/2");
  });
  const port = await listen(server);
  return {
    url: `https://127.0.0.1:${port}`,
    close: () => close(server),
  };
};

const decodeChunks = (chunks: ReadonlyArray<Uint8Array>): string => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

describeRealIntegration("real Bridge session requests", () => {
  it.live("runs the public request path over local HTTP/1.1", () =>
    Effect.gen(function* () {
      const server = yield* tryPromise(startHttp1Server);
      return yield* withClientAt(
        realBridgePath,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const session = yield* client.session({
            profile: "chrome_146",
            forceHttp1: true,
            identity: {
              headers: [
                ["X-Identity", "identity"],
                ["X-Replace", "identity"],
              ],
            },
          });
          const response = yield* session.request(`${server.url}/headers`, {
            headers: [
              ["X-First", "one"],
              ["X-Second", "two"],
              ["X-Replace", "request"],
            ],
            headerOrder: ["x-second", "x-first", "x-replace", "x-identity"],
          });
          expect(response.status).toBe(200);
          expect(response.protocol).toBe("HTTP/1.1");
          expect(response.headers).toContainEqual(["X-Transport", "http1"]);
          expect(yield* response.text).toBe("http/1.1");
          const headers = yield* Effect.promise(() => server.requestHeaders);
          expect(
            headers.map(([name, value]) => [name.toLowerCase(), value]),
          ).toEqual([
            ["x-second", "two"],
            ["x-first", "one"],
            ["x-replace", "request"],
            ["x-identity", "identity"],
          ]);
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("treats request timeoutMs 0 as an unlimited override", () =>
    Effect.gen(function* () {
      const server = yield* tryPromise(startHttp1Server);
      return yield* withClientAt(
        realBridgePath,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const session = yield* client.session({
            profile: "chrome_146",
            forceHttp1: true,
            timeoutMs: 5,
          });
          const response = yield* session.request(`${server.url}/slow`, {
            timeoutMs: 0,
          });
          expect(yield* response.text).toBe("slow");
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("runs the public request path over local TLS HTTP/2", () =>
    Effect.gen(function* () {
      const server = yield* tryPromise(startHttp2Server);
      return yield* withClientAt(
        realBridgePath,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const session = yield* client.session({
            profile: "chrome_146",
            insecureSkipVerify: true,
            disableHttp3: true,
          });
          const response = yield* session.request(`${server.url}/h2`);
          expect(response.status).toBe(200);
          expect(response.protocol).toBe("HTTP/2.0");
          expect(
            response.headers.some(
              ([name, value]) =>
                name.toLowerCase() === "x-transport" && value === "http2",
            ),
          ).toBe(true);
          expect(yield* response.text).toBe("https/2");
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("streams 50 MiB incrementally with bounded chunks", () =>
    Effect.gen(function* () {
      const server = yield* tryPromise(startHttp1Server);
      return yield* withClientAt(
        realBridgePath,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const session = yield* client.session({
            profile: "chrome_146",
            forceHttp1: true,
          });
          const response = yield* session.request(`${server.url}/large`);
          let total = 0;
          let chunks = 0;
          let largestChunk = 0;
          yield* response.stream.pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                largestChunk = Math.max(largestChunk, chunk.byteLength);
                for (let index = 0; index < chunk.byteLength; index += 1) {
                  if (chunk[index] !== (total + index) % 256) {
                    throw new Error(
                      `stream byte order broke at ${total + index}`,
                    );
                  }
                }
                total += chunk.byteLength;
                chunks += 1;
              }),
            ),
          );
          expect(total).toBe(50 * 1024 * 1024);
          expect(chunks).toBeGreaterThan(100);
          expect(largestChunk).toBeLessThanOrEqual(64 * 1024);
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("cancels an abandoned response stream and observes disconnect", () =>
    Effect.gen(function* () {
      const server = yield* tryPromise(startHttp1Server);
      return yield* withClientAt(
        realBridgePath,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const session = yield* client.session({
            profile: "chrome_146",
            forceHttp1: true,
          });
          const response = yield* session.request(`${server.url}/cancel`);
          const consumer = yield* response.stream.pipe(
            Stream.runDrain,
            Effect.forkChild,
          );
          yield* Effect.promise(() => server.firstChunk);
          yield* response.close;
          const result = yield* Fiber.join(consumer).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("TlsRequestError");
            if (result.failure._tag === "TlsRequestError") {
              expect(result.failure.kind).toBe("Cancelled");
            }
          }
          yield* Effect.promise(() => server.disconnected);
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("closes a response abandoned by a nested scope", () =>
    Effect.gen(function* () {
      const server = yield* tryPromise(startHttp1Server);
      return yield* withClientAt(
        realBridgePath,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const session = yield* client.session({
            profile: "chrome_146",
            forceHttp1: true,
          });
          yield* Effect.scoped(session.request(`${server.url}/cancel`));
          yield* Effect.promise(() => server.disconnected);
          const followUp = yield* session.request(`${server.url}/headers`);
          expect(yield* followUp.text).toBe("http/1.1");
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("reports TLS tracker deltas on the real end frame", () =>
    Effect.gen(function* () {
      const server = yield* tryPromise(startHttp2Server);
      return yield* withBridgeAt(
        realBridgePath,
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          const sessionId = "wire-bandwidth";
          yield* bridge.call(FrameKind.sessionCreate, {
            sessionId,
            profile: "chrome_146",
            insecureSkipVerify: true,
            disableHttp3: true,
          });
          const response = yield* bridge.request({
            sessionId,
            url: `${server.url}/h2`,
            method: "GET",
            headers: [],
            hasBody: false,
          });
          const chunks = yield* response.stream.pipe(Stream.runCollect);
          const end = yield* response.end;
          expect(decodeChunks(chunks)).toBe("https/2");
          expect(end.protocol).toBe("HTTP/2.0");
          expect(end.bytesRead).toBeGreaterThan(chunks[0]?.byteLength ?? 0);
          expect(end.bytesWritten).toBeGreaterThan(0);
          yield* bridge
            .call(FrameKind.sessionDestroy, { sessionId })
            .pipe(Effect.ignore);
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );
});
