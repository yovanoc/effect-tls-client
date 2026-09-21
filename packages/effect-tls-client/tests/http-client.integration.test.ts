import { describe, expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Metric,
  Result,
  Schema,
  Stream,
} from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { NodeServices } from "@effect/platform-node";
import { createServer } from "node:http";
import { TlsClientMetrics, TlsHttpClient } from "../src/index.js";

const bridgePath = process.env["TLS_CLIENT_BRIDGE_PATH"];
const describeRealIntegration =
  bridgePath === undefined || process.env["TLS_CLIENT_INTEGRATION"] !== "1"
    ? describe.skip
    : describe;

interface IntegrationServer {
  readonly baseUrl: string;
  readonly hangAborted: Promise<void>;
  readonly streamClosed: Promise<void>;
  readonly close: () => Promise<void>;
}

const startServer = (): Promise<IntegrationServer> =>
  new Promise((resolve, reject) => {
    let resolveHangAborted: () => void = () => {};
    let resolveStreamClosed: () => void = () => {};
    const hangAborted = new Promise<void>((done) => {
      resolveHangAborted = done;
    });
    const streamClosed = new Promise<void>((done) => {
      resolveStreamClosed = done;
    });
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/redirect") {
        response.writeHead(302, { Location: "/json" });
        response.end();
        return;
      }
      if (path === "/json") {
        response.setHeader("Content-Type", "application/json");
        response.end('{"ok":true}');
        return;
      }
      if (path === "/hang") {
        request.once("aborted", resolveHangAborted);
        response.once("close", resolveHangAborted);
        return;
      }
      if (path === "/stream") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.write("first");
        const timer = setInterval(() => {
          if (!response.destroyed) response.write("next");
        }, 10);
        response.once("close", () => {
          clearInterval(timer);
          resolveStreamClosed();
        });
        return;
      }
      if (path === "/upload") {
        request.once("aborted", () => response.destroy());
        request.once("end", () => response.end("ok"));
        request.resume();
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("integration server did not expose an address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        hangAborted,
        streamClosed,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) =>
              error === undefined ? done() : fail(error),
            );
          }),
      });
    });
  });

const clientLayer = TlsHttpClient.layer({ profile: "chrome_146" }).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ TLS_CLIENT_BRIDGE_PATH: bridgePath }),
      ),
    ),
  ),
);

describeRealIntegration("TlsHttpClient real Bridge integration", () => {
  it.live("records real Bridge GET and POST telemetry", () => {
    const registry = new Map();
    return Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(startServer),
        (value) => Effect.promise(value.close),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const get = yield* client.get(`${server.baseUrl}/json`);
          yield* get.arrayBuffer;
          const post = yield* client.post(`${server.baseUrl}/json`, {
            body: HttpBody.uint8Array(new Uint8Array([1, 2, 3])),
          });
          yield* post.arrayBuffer;
        }).pipe(Effect.provide(clientLayer)),
      );
      const requestMetric = Metric.withAttributes(TlsClientMetrics.requests, {
        profile: "chrome_146",
        protocol: "HTTP/1.1",
        error_kind: "none",
      });
      expect((yield* Metric.value(requestMetric)).count).toBe(2);
    }).pipe(Effect.provideService(Metric.MetricRegistry, registry));
  });

  it.live(
    "redirects, cancels, closes early streams, and maps upload failures",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Effect.acquireRelease(
            Effect.promise(startServer),
            (value) => Effect.promise(value.close),
          );
          const client = yield* HttpClient.HttpClient;
          const response = yield* HttpClient.followRedirects(2)(client).get(
            `${server.baseUrl}/redirect`,
          );
          expect(response.status).toBe(200);
          expect(
            yield* HttpClientResponse.schemaBodyJson(
              Schema.Struct({ ok: Schema.Boolean }),
            )(response),
          ).toEqual({ ok: true });

          const timeout = yield* client
            .get(`${server.baseUrl}/hang`)
            .pipe(Effect.timeout(Duration.millis(100)), Effect.result);
          expect(Result.isFailure(timeout)).toBe(true);
          yield* Effect.promise(() => server.hangAborted);

          const streamResponse = yield* client.get(`${server.baseUrl}/stream`);
          yield* streamResponse.stream.pipe(Stream.take(1), Stream.runDrain);
          yield* Effect.promise(() => server.streamClosed);

          const upload = yield* client
            .post(`${server.baseUrl}/upload`, {
              body: HttpBody.stream(Stream.fail("upload failed")),
            })
            .pipe(Effect.result);
          expect(Result.isFailure(upload)).toBe(true);
          if (Result.isFailure(upload)) {
            expect(upload.failure.reason._tag).toBe("EncodeError");
          }
        }).pipe(Effect.provide(clientLayer)),
      ),
  );
});
