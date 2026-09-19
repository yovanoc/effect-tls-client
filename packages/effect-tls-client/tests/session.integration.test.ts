import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Result, Stream } from "effect";
import { Cookies } from "effect/unstable/http";
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
  readonly upload: Promise<{
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  }>;
  readonly uploadEnded: Promise<boolean>;
  readonly firstChunk: Promise<void>;
  readonly disconnected: Promise<void>;
  readonly close: () => Promise<void>;
}

const startHttp1Server = async (): Promise<LocalHttp1Server> => {
  let resolveRequestHeaders: (
    value: ReadonlyArray<readonly [string, string]>,
  ) => void = () => {};
  let resolveFirstChunk: () => void = () => {};
  let resolveUpload: (value: {
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  }) => void = () => {};
  let resolveUploadEnded: (value: boolean) => void = () => {};
  let resolveDisconnected: () => void = () => {};
  const requestHeaders = new Promise<ReadonlyArray<readonly [string, string]>>(
    (resolve) => {
      resolveRequestHeaders = resolve;
    },
  );
  const firstChunk = new Promise<void>((resolve) => {
    resolveFirstChunk = resolve;
  });
  const upload = new Promise<{
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  }>((resolve) => {
    resolveUpload = resolve;
  });
  const uploadEnded = new Promise<boolean>((resolve) => {
    resolveUploadEnded = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    resolveDisconnected = resolve;
  });
  let disconnectReported = false;
  let uploadEndedReported = false;
  let cancelTimer: ReturnType<typeof setInterval> | undefined;
  const reportUploadEnded = (ended: boolean) => {
    if (uploadEndedReported) return;
    uploadEndedReported = true;
    resolveUploadEnded(ended);
  };
  const reportDisconnect = () => {
    if (disconnectReported) return;
    disconnectReported = true;
    if (cancelTimer !== undefined) clearInterval(cancelTimer);
    resolveDisconnected();
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://local").pathname;
    if (path === "/echo" || path === "/count") {
      const chunks: Array<Buffer> = [];
      let total = 0;
      request.on("data", (chunk: Buffer) => {
        if (path === "/echo") chunks.push(chunk);
        total += chunk.byteLength;
      });
      request.once("end", () => {
        const body = path === "/echo" ? Buffer.concat(chunks) : Buffer.alloc(0);
        if (path === "/echo") resolveUpload({ body, headers: request.headers });
        response.setHeader("Content-Type", "text/plain");
        response.end(path === "/count" ? String(total) : body);
      });
      return;
    }
    if (path === "/redirect-a") {
      response.writeHead(302, { Location: "/redirect-b" });
      response.end();
      return;
    }
    if (path === "/redirect-b") {
      response.writeHead(302, { Location: "/redirect-final" });
      response.end();
      return;
    }
    if (path === "/redirect-final") {
      response.end("redirect-final");
      return;
    }
    if (path === "/host") {
      response.end(request.headers.host ?? "");
      return;
    }
    if (path === "/cookie") {
      response.end(request.headers.cookie ?? "");
      return;
    }
    if (path === "/upload-early") {
      request.once("data", () => {
        resolveFirstChunk();
        response.end("early");
      });
      request.once("end", () => reportUploadEnded(true));
      request.once("aborted", () => {
        reportUploadEnded(false);
        reportDisconnect();
      });
      response.once("close", () => {
        reportUploadEnded(false);
        reportDisconnect();
      });
      return;
    }
    if (path === "/upload-wait") {
      request.once("data", resolveFirstChunk);
      request.once("aborted", reportDisconnect);
      response.once("close", reportDisconnect);
      return;
    }
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
    if (path === "/timeout") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.alloc(64 * 1024, 7));
      resolveFirstChunk();
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
    upload,
    uploadEnded,
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
  it.live("uploads a string with request metadata and cookies", () =>
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
          const response = yield* session.request(`${server.url}/echo`, {
            method: "POST",
            headers: [["Content-Length", "12"]],
            body: "hello upload",
          });
          const responseText = yield* response.text;
          const upload = yield* Effect.promise(() => server.upload);
          expect(responseText).toBe("hello upload");
          expect(new TextDecoder().decode(upload.body)).toBe("hello upload");
          expect(upload.headers["content-type"]).toBe(
            "text/plain;charset=UTF-8",
          );
          expect(upload.headers["content-length"]).toBe("12");

          const cookieResponse = yield* session.request(
            `${server.url}/cookie`,
            {
              cookies: Cookies.fromSetCookie("request-cookie=one; Path=/"),
            },
          );
          expect(yield* cookieResponse.text).toContain("request-cookie=one");
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("uploads bytes with an exact content length", () =>
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
          const response = yield* session.request(`${server.url}/echo`, {
            method: "POST",
            body: new Uint8Array([1, 2, 3, 4]),
          });
          expect((yield* response.bytes).length).toBe(4);
          const upload = yield* Effect.promise(() => server.upload);
          expect(Array.from(upload.body)).toEqual([1, 2, 3, 4]);
          expect(upload.headers["content-length"]).toBe("4");
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("interrupts an upload and observes the server disconnect", () =>
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
          const body = Stream.unfold(0, (index) =>
            Effect.succeed([new Uint8Array(64 * 1024), index + 1] as const),
          );
          const requestFiber = yield* session
            .request(`${server.url}/upload-wait`, {
              method: "POST",
              body,
            })
            .pipe(Effect.forkChild);
          yield* Effect.promise(() => server.firstChunk);
          yield* Fiber.interrupt(requestFiber);
          yield* Effect.promise(() => server.disconnected);
          const followUp = yield* session.request(`${server.url}/headers`);
          expect(yield* followUp.text).toBe("http/1.1");
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("stops a streamed producer after an early response", () =>
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
          let pulls = 0;
          const body = Stream.unfold(0, (index) =>
            Effect.sync(() => {
              pulls += 1;
              return [new Uint8Array(64 * 1024), index + 1] as const;
            }),
          );
          const response = yield* session.request(
            `${server.url}/upload-early`,
            {
              method: "POST",
              body,
            },
          );
          expect(yield* response.text).toBe("early");
          expect(yield* Effect.promise(() => server.uploadEnded)).toBe(false);
          expect(pulls).toBeLessThan(100);
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("encodes FormData with a matching content type and length", () =>
    Effect.gen(function* () {
      const server = yield* tryPromise(startHttp1Server);
      return yield* withClientAt(
        realBridgePath,
        Effect.gen(function* () {
          const form = new FormData();
          form.set("field", "value");
          const client = yield* TlsClient;
          const session = yield* client.session({
            profile: "chrome_146",
            forceHttp1: true,
          });
          const response = yield* session.request(`${server.url}/echo`, {
            method: "POST",
            body: form,
          });
          const responseText = yield* response.text;
          const upload = yield* Effect.promise(() => server.upload);
          expect(responseText).toContain('name="field"');
          expect(responseText).toContain("value");
          expect(new TextDecoder().decode(upload.body)).toContain(
            'name="field"',
          );
          expect(String(upload.headers["content-type"])).toMatch(
            /^multipart\/form-data; boundary=/,
          );
          expect(upload.headers["content-length"]).toBe(
            String(upload.body.byteLength),
          );
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("accepts many small upload chunks within the byte window", () =>
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
          const chunkCount = 100;
          const chunkSize = 1024;
          const body = Stream.unfold(0, (index) =>
            Effect.succeed(
              index >= chunkCount
                ? undefined
                : ([new Uint8Array(chunkSize), index + 1] as const),
            ),
          );
          const response = yield* session.request(`${server.url}/count`, {
            method: "POST",
            body,
          });
          expect(yield* response.text).toBe(String(chunkCount * chunkSize));
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live("streams a 100 MiB upload without collecting the source", () =>
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
          const chunkSize = 64 * 1024;
          const chunkCount = (100 * 1024 * 1024) / chunkSize;
          let pulls = 0;
          const body = Stream.unfold(0, (index) =>
            Effect.sync(() => {
              if (index >= chunkCount) return undefined;
              pulls += 1;
              return [new Uint8Array(chunkSize), index + 1] as const;
            }),
          );
          const response = yield* session.request(`${server.url}/count`, {
            method: "POST",
            timeoutMs: 0,
            body,
          });
          expect(yield* response.text).toBe(String(100 * 1024 * 1024));
          expect(pulls).toBe(chunkCount);
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

  it.live(
    "follows redirects or exposes the redirect response per request",
    () =>
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
            const followed = yield* session.request(
              `${server.url}/redirect-a`,
              {
                followRedirects: true,
              },
            );
            expect(followed.url).toBe(`${server.url}/redirect-final`);
            expect(yield* followed.text).toBe("redirect-final");
            const exposed = yield* session.request(`${server.url}/redirect-a`, {
              followRedirects: false,
            });
            expect(exposed.status).toBe(302);
            expect(exposed.url).toBe(`${server.url}/redirect-a`);
          }),
        ).pipe(Effect.ensuring(Effect.promise(server.close)));
      }),
  );

  it.live("applies host overrides and supports an ephemeral request", () =>
    Effect.gen(function* () {
      const server = yield* tryPromise(startHttp1Server);
      return yield* withClientAt(
        realBridgePath,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const response = yield* client.request(
            { profile: "chrome_146", forceHttp1: true },
            `${server.url}/host`,
            { hostOverride: "override.test" },
          );
          expect(yield* response.text).toBe("override.test");
        }),
      ).pipe(Effect.ensuring(Effect.promise(server.close)));
    }),
  );

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

  it.live("classifies a mid-body timeout as Timeout", () =>
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
          const response = yield* session.request(`${server.url}/timeout`, {
            timeoutMs: 100,
          });
          yield* Effect.promise(() => server.firstChunk);
          const result = yield* response.stream.pipe(
            Stream.runDrain,
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("TlsRequestError");
            if (result.failure._tag === "TlsRequestError") {
              expect(result.failure.kind).toBe("Timeout");
            }
          }
          yield* Effect.promise(() => server.disconnected);
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
