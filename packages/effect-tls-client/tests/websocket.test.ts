import { describe, expect, it } from "@effect/vitest";
import {
  Channel,
  ConfigProvider,
  Duration,
  Effect,
  Fiber,
  Layer,
  Metric,
  Option,
  Queue,
  Schedule,
  Stream,
} from "effect";
import type { Scope } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket as NetSocket } from "node:net";
import { NodeServices } from "@effect/platform-node";
import {
  Bridge,
  type BridgeWebSocket,
  type WebSocketFrame,
} from "../src/internal/Bridge.js";
import { FrameKind } from "../src/internal/Frame.js";
import { TlsClientMetrics, TlsWebSocketError } from "../src/index.js";
import { TlsClient } from "../src/TlsClient.js";
import { makeTlsClientLayer } from "../src/TlsClient.js";

const configuredBridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];

const okFrame = {
  kind: FrameKind.ok,
  id: 1,
  meta: new Uint8Array(0),
  body: new Uint8Array(0),
};

const fakeBridge = (
  webSocket: (
    meta: unknown,
  ) => Effect.Effect<BridgeWebSocket, TlsWebSocketError>,
) =>
  Bridge.of({
    call: () => Effect.succeed(okFrame),
    stream: () => Stream.empty,
    request: () => Effect.die("unused in WebSocket test"),
    webSocket,
    version: Effect.succeed({
      packageVersion: "fixture",
      bridgeVersion: "fixture",
      protocolVersion: 1,
      tlsClientVersion: "fixture",
      goVersion: "fixture",
    }),
  });

const fakeClient = <A, E>(
  bridge: Bridge["Service"],
  effect: Effect.Effect<A, E, TlsClient | Scope.Scope>,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(
        makeTlsClientLayer.pipe(Layer.provide(Layer.succeed(Bridge, bridge))),
      ),
    ),
  );

interface TestWebSocketServer {
  readonly url: string;
  readonly headers: Map<string, string>;
  readonly sendBurst: (count: number) => void;
  readonly sendClose: (code: number, reason: string) => void;
  readonly close: () => Promise<void>;
}

const frame = (opcode: number, body: Uint8Array): Buffer => {
  const length = body.byteLength;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >>> 8, length & 0xff])
        : Buffer.from([
            0x80 | opcode,
            127,
            0,
            0,
            0,
            0,
            (length >>> 24) & 0xff,
            (length >>> 16) & 0xff,
            (length >>> 8) & 0xff,
            length & 0xff,
          ]);
  return Buffer.concat([header, Buffer.from(body)]);
};

const startWebSocketServer = async (
  closeFirstConnectionAfterEcho = false,
): Promise<TestWebSocketServer> => {
  let firstConnection = true;
  const headers = new Map<string, string>();
  const clients = new Set<NetSocket>();
  const server: Server = createServer((socket) => {
    clients.add(socket);
    const closeAfterFirstEcho =
      closeFirstConnectionAfterEcho && firstConnection;
    firstConnection = false;
    let input = Buffer.alloc(0);
    let handshaken = false;
    let echoed = false;

    const send = (opcode: number, body: Uint8Array) => {
      if (!socket.destroyed) socket.write(frame(opcode, body));
    };
    const handleFrames = () => {
      while (handshaken && input.byteLength >= 2) {
        const first = input[0]!;
        const second = input[1]!;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (input.byteLength < 4) return;
          length = input.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (input.byteLength < 10) return;
          const largeLength = Number(input.readBigUInt64BE(2));
          if (!Number.isSafeInteger(largeLength)) {
            socket.destroy();
            return;
          }
          length = largeLength;
          offset = 10;
        }
        if ((second & 0x80) === 0 || input.byteLength < offset + 4 + length) {
          socket.destroy();
          return;
        }
        const mask = input.subarray(offset, offset + 4);
        const body = input.subarray(offset + 4, offset + 4 + length);
        const decoded = new Uint8Array(length);
        for (let index = 0; index < length; index++) {
          decoded[index] = body[index]! ^ mask[index % 4]!;
        }
        input = input.subarray(offset + 4 + length);
        const opcode = first & 0x0f;
        if (opcode === 8) {
          send(8, decoded);
          socket.end();
        } else if (opcode === 9) {
          send(10, decoded);
        } else if (opcode === 1 || opcode === 2) {
          send(opcode, decoded);
          if (closeAfterFirstEcho && !echoed) {
            echoed = true;
            const closeBody = Buffer.alloc(2);
            closeBody.writeUInt16BE(1000, 0);
            send(8, closeBody);
            socket.end();
          }
        }
      }
    };

    socket.on("data", (chunk) => {
      input = Buffer.concat([input, Buffer.from(chunk)]);
      if (!handshaken) {
        const end = input.indexOf("\r\n\r\n");
        if (end === -1) return;
        const request = input.subarray(0, end).toString("latin1");
        input = input.subarray(end + 4);
        const lines = request.split("\r\n");
        for (const line of lines.slice(1)) {
          const separator = line.indexOf(":");
          if (separator !== -1) {
            headers.set(
              line.slice(0, separator).toLowerCase(),
              line.slice(separator + 1).trim(),
            );
          }
        }
        const key = headers.get("sec-websocket-key");
        if (key === undefined) {
          socket.destroy();
          return;
        }
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        handshaken = true;
      }
      handleFrames();
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test WebSocket server did not expose a port");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/echo`,
    headers,
    sendBurst: (count) => {
      const body = new Uint8Array([1]);
      for (const client of clients) {
        for (let index = 0; index < count; index++) {
          client.write(frame(2, body));
        }
      }
    },
    sendClose: (code, reason) => {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      for (const client of clients) client.write(frame(8, body));
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.destroy();
        server.close(() => resolve());
      }),
  };
};

describe("TlsClient WebSockets", () => {
  it.effect("is lazy, preserves raw frames, and acknowledges writes", () =>
    Effect.gen(function* () {
      const frames = yield* Queue.unbounded<
        WebSocketFrame,
        TlsWebSocketError
      >();
      const writes: Array<{
        readonly opcode: 1 | 2;
        readonly body: Uint8Array;
      }> = [];
      let connectCalls = 0;
      let closeCalls = 0;
      const bridge = fakeBridge((meta) => {
        connectCalls += 1;
        expect(meta).toMatchObject({
          url: "ws://fixture.test/echo",
        });
        expect(typeof (meta as { readonly sessionId: unknown }).sessionId).toBe(
          "string",
        );
        return Effect.succeed({
          open: { status: 101, headers: [] },
          pull: Queue.take(frames),
          write: (opcode, body) =>
            Effect.sync(() => writes.push({ opcode, body })),
          close: () =>
            Effect.sync(() => {
              closeCalls += 1;
            }),
        });
      });
      yield* fakeClient(
        bridge,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const session = yield* client.session({ profile: "chrome_146" });
          const socket = yield* session.webSocket("ws://fixture.test/echo");
          expect(connectCalls).toBe(0);
          const reader = yield* socket.reader;
          expect(connectCalls).toBe(1);
          const writer = yield* socket.writer;
          yield* writer.write("hello");
          yield* Queue.offer(frames, {
            opcode: 1,
            body: new TextEncoder().encode("world"),
          });
          expect(yield* reader.pull).toEqual(["world"]);
          yield* writer.write(new Uint8Array([1, 2]));
          yield* writer.writeAll(["a", new Uint8Array([3])]);
          expect(writes).toHaveLength(4);
          expect(writes[0]?.opcode).toBe(1);
          expect(new TextDecoder().decode(writes[0]?.body)).toBe("hello");
          expect(writes[1]?.opcode).toBe(2);
          expect([...writes[1]!.body]).toEqual([1, 2]);
          expect(writes[2]?.opcode).toBe(1);
          expect(writes[3]?.opcode).toBe(2);
        }),
      );
      expect(closeCalls).toBeGreaterThan(0);
    }),
  );

  it.effect("tracks active WebSocket connections by scope", () => {
    const registry = new Map();
    const bridge = fakeBridge(() =>
      Effect.succeed({
        open: { status: 101, headers: [] },
        pull: Effect.never,
        write: () => Effect.void,
        close: () => Effect.void,
      }),
    );
    return Effect.gen(function* () {
      yield* fakeClient(
        bridge,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const session = yield* client.session({ profile: "chrome_146" });
          const socket = yield* session.webSocket("ws://fixture.test/echo");
          yield* socket.reader;
          expect(
            (yield* Metric.value(TlsClientMetrics.webSocketConnectionsActive))
              .value,
          ).toBe(1);
        }),
      );
      expect(
        (yield* Metric.value(TlsClientMetrics.webSocketConnectionsActive))
          .value,
      ).toBe(0);
    }).pipe(Effect.provideService(Metric.MetricRegistry, registry));
  });

  it.effect("maps a remote close to SocketCloseError", () => {
    const bridge = fakeBridge(() =>
      Effect.succeed({
        open: { status: 101, headers: [] },
        pull: Effect.fail(
          new TlsWebSocketError({
            kind: "Closed",
            message: "server stopped",
            code: 4001,
            reason: "server stopped",
            initiator: "remote",
          }),
        ),
        write: () => Effect.void,
        close: () => Effect.void,
      }),
    );
    return fakeClient(
      bridge,
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const session = yield* client.session({ profile: "chrome_146" });
        const socket = yield* session.webSocket("ws://fixture.test/close");
        const reader = yield* socket.reader;
        const error = yield* Effect.flip(reader.pull);
        expect(error).toBeInstanceOf(Socket.SocketError);
        if (error instanceof Socket.SocketError) {
          expect(error.reason).toBeInstanceOf(Socket.SocketCloseError);
          if (error.reason instanceof Socket.SocketCloseError) {
            expect(error.reason.code).toBe(4001);
          }
        }
      }),
    );
  });
});

const describeReal =
  configuredBridgePath === undefined ? describe.skip : describe;

describeReal("Real Bridge WebSockets", () => {
  it("echoes text and binary frames through the fingerprinted HTTP/1 dialer", async () => {
    const registry = new Map();
    const server = await startWebSocketServer();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* TlsClient;
            const session = yield* client.session({
              profile: "chrome_146",
              identity: { headers: [["X-Identity", "yes"]] },
            });
            const socket = yield* session.webSocket(server.url, {
              headers: [["X-Request", "yes"]],
            });
            const reader = yield* socket.reader;
            expect(
              (yield* Metric.value(TlsClientMetrics.webSocketConnectionsActive))
                .value,
            ).toBe(1);
            const writer = yield* socket.writer;
            yield* writer.write("hello");
            expect(yield* reader.pull).toEqual(["hello"]);
            yield* writer.write(new Uint8Array([1, 2, 3]));
            const binary = yield* reader.pull;
            expect(binary).toHaveLength(1);
            expect(binary[0]).toBeInstanceOf(Uint8Array);
            expect([...(binary[0] as Uint8Array)]).toEqual([1, 2, 3]);
            expect(server.headers.get("x-identity")).toBe("yes");
            expect(server.headers.get("x-request")).toBe("yes");
            yield* writer.write(new Socket.CloseEvent(1000, "done"));
          })
            .pipe(
              Effect.provide(
                TlsClient.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      NodeServices.layer,
                      ConfigProvider.layer(
                        ConfigProvider.fromUnknown({
                          TLS_CLIENT_BRIDGE_PATH: configuredBridgePath,
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            )
            .pipe(Effect.provideService(Metric.MetricRegistry, registry)),
        ),
      );
      const active = await Effect.runPromise(
        Effect.provideService(
          Metric.value(TlsClientMetrics.webSocketConnectionsActive),
          Metric.MetricRegistry,
          registry,
        ),
      );
      expect(active.value).toBe(0);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("supports Socket streams, channels, and retry reconnects", async () => {
    const server = await startWebSocketServer(true);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* TlsClient;
            const session = yield* client.session({ profile: "chrome_146" });
            let attempts = 0;

            const retried = yield* Effect.gen(function* () {
              attempts += 1;
              const socket = yield* session.webSocket(server.url);
              const reader = yield* socket.reader;
              const writer = yield* socket.writer;
              yield* writer.write("retry");
              const echoed = yield* reader.pull;
              expect(echoed).toEqual(["retry"]);
              if (attempts === 1) {
                yield* reader.pull;
              }
              return echoed;
            }).pipe(Effect.scoped, Effect.retry(Schedule.recurs(1)));
            expect(attempts).toBe(2);
            expect(retried).toEqual(["retry"]);

            const streamSocket = yield* session.webSocket(server.url);
            const streamFiber = yield* Stream.runCollect(
              Socket.toStream(streamSocket).pipe(Stream.take(1)),
            ).pipe(Effect.forkScoped);
            const streamWriter = yield* streamSocket.writer;
            yield* streamWriter.write("stream");
            const streamed = yield* Fiber.join(streamFiber);
            expect(streamed).toHaveLength(1);
            expect(new TextDecoder().decode(streamed[0])).toBe("stream");

            const channelSocket = yield* session.webSocket(server.url);
            const channel = Channel.pipeTo(
              Channel.fromIterable([
                [new TextEncoder().encode("channel")] as const,
              ]),
              Socket.toChannel(channelSocket),
            );
            const head = yield* Channel.runHead(channel);
            expect(Option.isSome(head)).toBe(true);
            if (Option.isSome(head)) {
              expect(new TextDecoder().decode(head.value[0])).toBe("channel");
            }
          }).pipe(
            Effect.provide(
              TlsClient.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    ConfigProvider.layer(
                      ConfigProvider.fromUnknown({
                        TLS_CLIENT_BRIDGE_PATH: configuredBridgePath,
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    } finally {
      await server.close();
    }
  }, 30_000);

  it("maps a remote close code to SocketCloseError", async () => {
    const server = await startWebSocketServer();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* TlsClient;
            const session = yield* client.session({ profile: "chrome_146" });
            const socket = yield* session.webSocket(server.url);
            const reader = yield* socket.reader;
            server.sendClose(4001, "server stopped");
            const error = yield* Effect.flip(reader.pull);
            expect(error).toBeInstanceOf(Socket.SocketError);
            if (error instanceof Socket.SocketError) {
              expect(error.reason).toBeInstanceOf(Socket.SocketCloseError);
              if (error.reason instanceof Socket.SocketCloseError) {
                expect(error.reason.code).toBe(4001);
                expect(error.reason.closeReason).toBe("server stopped");
              }
            }
          }).pipe(
            Effect.provide(
              TlsClient.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    ConfigProvider.layer(
                      ConfigProvider.fromUnknown({
                        TLS_CLIENT_BRIDGE_PATH: configuredBridgePath,
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    } finally {
      await server.close();
    }
  }, 30_000);

  it("delivers a burst without unbounded reader buffering", async () => {
    const server = await startWebSocketServer();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* TlsClient;
            const session = yield* client.session({ profile: "chrome_146" });
            const socket = yield* session.webSocket(server.url);
            const reader = yield* socket.reader.pipe(
              Effect.timeout(Duration.seconds(5)),
            );
            server.sendBurst(40_000);
            let received = 0;
            while (received < 40_000) {
              const next = yield* reader.pull.pipe(
                Effect.timeout(Duration.seconds(5)),
              );
              received += next.length;
            }
            expect(received).toBe(40_000);
          }).pipe(
            Effect.provide(
              TlsClient.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    ConfigProvider.layer(
                      ConfigProvider.fromUnknown({
                        TLS_CLIENT_BRIDGE_PATH: configuredBridgePath,
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    } finally {
      await server.close();
    }
  }, 30_000);
});
