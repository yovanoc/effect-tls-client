import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Cookies from "effect/unstable/http/Cookies";
import {
  BrowserChallenge,
  BrowserSessionError,
  composeChallengeHandlers,
  type BrowserChallengeContext,
  type BrowserChallengeHandler,
  type BrowserChallengeResolution,
} from "../src/browser/index.js";

const challenge = BrowserChallenge.make({
  kind: "AwsWaf",
  status: 202,
  url: "https://example.test/",
  headers: [["x-amzn-waf-action", "challenge"]],
  evidence: "x-amzn-waf-action",
});
const context: BrowserChallengeContext = {
  body: "challenge body",
  response: {
    ...challenge,
    protocol: "HTTP/2.0",
    cookies: Cookies.empty,
    bytesRead: Effect.succeed(0),
    bytesWritten: Effect.succeed(0),
    stream: Stream.empty,
    bytes: Effect.succeed(new Uint8Array()),
    text: Effect.succeed("challenge body"),
    json: Effect.succeed({}),
    close: Effect.void,
  },
  transport: {
    id: "composition-test",
    request: () => Effect.die("unused"),
    webSocket: () => Effect.die("unused"),
    cookies: () => Effect.die("unused"),
    setCookies: () => Effect.die("unused"),
    scriptCookies: () => Effect.die("unused"),
    exportCookies: Effect.die("unused"),
    importCookies: () => Effect.die("unused"),
    bandwidth: Effect.die("unused"),
    resetBandwidth: Effect.die("unused"),
    setProxy: () => Effect.die("unused"),
  },
  evaluate: () => Effect.die("unused"),
};

describe("composeChallengeHandlers", () => {
  it.effect("returns None for empty and all-declining handlers", () =>
    Effect.gen(function* () {
      expect(yield* composeChallengeHandlers()(challenge, context)).toEqual(
        Option.none(),
      );
      const calls: Array<number> = [];
      const decline =
        (index: number): BrowserChallengeHandler =>
        () =>
          Effect.sync(() => {
            calls.push(index);
            return Option.none();
          });
      const result = yield* composeChallengeHandlers(decline(1), decline(2))(
        challenge,
        context,
      );
      expect(result).toEqual(Option.none());
      expect(calls).toEqual([1, 2]);
    }),
  );

  it.effect(
    "runs in order with identical inputs and returns the first Some unchanged",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const retry: BrowserChallengeResolution = {
          url: "https://example.test/retry",
          headers: [["x-retry", "yes"]],
        };
        const accepted = Option.some(retry);
        const handler =
          (
            name: string,
            result: Option.Option<BrowserChallengeResolution>,
          ): BrowserChallengeHandler =>
          (receivedChallenge, receivedContext) => {
            expect(receivedChallenge).toBe(challenge);
            expect(receivedContext).toBe(context);
            calls.push(`${name}:invoke`);
            return Effect.sync(() => {
              calls.push(`${name}:complete`);
              return result;
            });
          };
        const result = yield* composeChallengeHandlers(
          handler("decline", Option.none()),
          handler("accept", accepted),
          handler("later", Option.some({})),
        )(challenge, context);
        expect(result).toBe(accepted);
        expect(calls).toEqual([
          "decline:invoke",
          "decline:complete",
          "accept:invoke",
          "accept:complete",
        ]);
      }),
  );

  it.effect(
    "propagates the typed failure without invoking later handlers",
    () =>
      Effect.gen(function* () {
        const failure = BrowserSessionError.make({
          operation: "test challenge",
          kind: "Config",
          message: "invalid handler configuration",
        });
        const calls: Array<string> = [];
        const result = yield* composeChallengeHandlers(
          () => {
            calls.push("failure");
            return Effect.fail(failure);
          },
          () => {
            calls.push("later");
            return Effect.succeedNone;
          },
        )(challenge, context).pipe(Effect.flip);
        expect(result).toBe(failure);
        expect(calls).toEqual(["failure"]);
      }),
  );

  it.effect("propagates interruption without invoking later handlers", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const exit = yield* composeChallengeHandlers(
        () => {
          calls.push("interrupt");
          return Effect.interrupt;
        },
        () => {
          calls.push("later");
          return Effect.succeedNone;
        },
      )(challenge, context).pipe(Effect.exit);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(calls).toEqual(["interrupt"]);
    }),
  );
});
