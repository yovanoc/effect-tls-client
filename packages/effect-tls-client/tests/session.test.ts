import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import type { Scope } from "effect";
import { NodeServices } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import {
  BridgeProtocolError,
  SessionConfig,
  SessionConfigError,
  TlsClient,
  TlsRequestError,
  isTransientRequestKind,
} from "../src/index.js";
import { Bridge } from "../src/internal/Bridge.js";
import { FrameKind } from "../src/internal/Frame.js";
import { makeTlsClientLayer } from "../src/TlsClient.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/bridge-fixture.mjs", import.meta.url),
);
const bodyErrorFixturePath = fileURLToPath(
  new URL("./fixtures/bridge-body-error-fixture.mjs", import.meta.url),
);

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

const withClient = <A, E>(
  effect: Effect.Effect<A, E, TlsClient | Scope.Scope>,
) => withClientAt(fixturePath, effect);

describe("TlsClient sessions", () => {
  it.effect("creates a session and exposes a streamed cached response", () =>
    withClient(
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const session = yield* client.session({ profile: "chrome_146" });
        const response = yield* session.request("https://fixture.test/data");

        expect(response.status).toBe(200);
        expect(response.url).toBe("https://fixture.test/data");
        expect(response.protocol).toBe("HTTP/1.1");
        expect(response.headers).toEqual([
          ["Content-Type", "application/json"],
          ["Set-Cookie", "fixture=1; Path=/"],
        ]);
        expect(response.cookies.cookies["fixture"]?.value).toBe("1");

        const bytes = yield* response.bytes;
        const text = yield* response.text;
        const json = yield* response.json;
        expect(new TextDecoder().decode(bytes)).toBe('{"ok":true}');
        expect(text).toBe('{"ok":true}');
        expect(json).toEqual({ ok: true });
        const streamed = yield* session.request("https://fixture.test/stream");
        const chunks = yield* streamed.stream.pipe(Stream.runCollect);
        expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(
          '{"ok":true}',
        );
      }),
    ),
  );

  it.effect("rejects mutually exclusive profile configuration", () =>
    Effect.flip(
      withClient(
        Effect.gen(function* () {
          const client = yield* TlsClient;
          return yield* client.session({
            profile: "chrome_146",
            customProfile: { ja3String: "771,4865-4866-4867,0-11,23-24,0" },
          });
        }),
      ),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(SessionConfigError);
        }),
      ),
    ),
  );

  it("exports a schema that rejects a missing identity profile", () => {
    expect(() => SessionConfig.make({})).toThrow();
  });

  it.effect("destroys a session when its nested scope closes", () =>
    withClient(
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const session = yield* Effect.scoped(
          client.session({ profile: "chrome_146" }),
        );
        const error = yield* Effect.flip(
          session.request("https://fixture.test/after-close"),
        );
        expect(error._tag).toBe("SessionNotFound");
      }),
    ),
  );

  it.effect("classifies a Connect request error as transient", () =>
    withClient(
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const session = yield* client.session({ profile: "chrome_146" });
        const error = yield* Effect.flip(
          session.request("https://fixture.test/connect-error"),
        );
        expect(error).toBeInstanceOf(TlsRequestError);
        if (error._tag === "TlsRequestError") {
          expect(error.kind).toBe("Connect");
          expect(error.isTransient).toBe(true);
        }
      }),
    ),
  );

  it.effect("preserves an Internal Bridge diagnostic", () =>
    withClient(
      Effect.gen(function* () {
        const client = yield* TlsClient;
        const session = yield* client.session({ profile: "chrome_146" });
        const error = yield* Effect.flip(
          session.request("https://fixture.test/internal-error"),
        );
        expect(error).toBeInstanceOf(BridgeProtocolError);
        if (error._tag === "BridgeProtocolError") {
          expect(error.message).toBe("fixture internal failure");
        }
      }),
    ),
  );

  it.effect("preserves a failing upload stream as a Body error", () =>
    Effect.flip(
      withClientAt(
        bodyErrorFixturePath,
        Effect.gen(function* () {
          const client = yield* TlsClient;
          const session = yield* client.session({ profile: "chrome_146" });
          return yield* session.request("https://fixture.test/upload", {
            method: "POST",
            body: Stream.fromIterable([new Uint8Array([1])]).pipe(
              Stream.concat(Stream.fail("body source failed")),
            ),
          });
        }),
      ),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(TlsRequestError);
          if (error._tag === "TlsRequestError") {
            expect(error.kind).toBe("Body");
            expect(error.message).toBe("body source failed");
          }
        }),
      ),
    ),
  );

  it("marks every transient request kind", () => {
    for (const kind of ["Dns", "Connect", "Timeout", "Proxy"] as const) {
      const error = new TlsRequestError({
        kind,
        message: "fixture",
        isTransient: isTransientRequestKind(kind),
      });
      expect(error.isTransient).toBe(true);
    }
  });

  it.effect(
    "destroys a remotely-created session if creation is interrupted",
    () =>
      Effect.gen(function* () {
        const creationStarted = Deferred.makeUnsafe<void>();
        let destroyCalls = 0;
        const ok = {
          kind: FrameKind.ok,
          id: 1,
          meta: new Uint8Array(0),
          body: new Uint8Array(0),
        };
        const fakeBridge = Bridge.of({
          call: (kind) => {
            if (kind === FrameKind.sessionCreate) {
              return Effect.gen(function* () {
                yield* Deferred.succeed(creationStarted, undefined);
                return yield* Effect.never;
              });
            }
            if (kind === FrameKind.sessionDestroy) {
              return Effect.sync(() => {
                destroyCalls += 1;
              }).pipe(Effect.as(ok));
            }
            return Effect.succeed(ok);
          },
          stream: () => Stream.empty,
          request: () => Effect.die("unused in session lifecycle test"),
          webSocket: () => Effect.die("unused in session lifecycle test"),
          version: Effect.succeed({
            packageVersion: "fixture",
            bridgeVersion: "fixture",
            protocolVersion: 1,
            tlsClientVersion: "fixture",
            goVersion: "fixture",
          }),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* TlsClient;
            const fiber = yield* client
              .session({ profile: "chrome_146" })
              .pipe(Effect.forkChild);
            yield* Deferred.await(creationStarted);
            yield* Fiber.interrupt(fiber);
            expect(destroyCalls).toBe(1);
          }).pipe(
            Effect.provide(
              makeTlsClientLayer.pipe(
                Layer.provide(Layer.succeed(Bridge, fakeBridge)),
              ),
            ),
          ),
        );
      }),
  );
});
