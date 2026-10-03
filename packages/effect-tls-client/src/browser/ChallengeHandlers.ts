import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BrowserChallengeHandler } from "./Browser.js";

/** Tries handlers in order: None falls through; the first Some, failure, or interruption stops. */
export const composeChallengeHandlers = (
  ...handlers: ReadonlyArray<BrowserChallengeHandler>
): BrowserChallengeHandler =>
  Effect.fnUntraced(function* (challenge, context) {
    for (const handler of handlers) {
      const resolution = yield* handler(challenge, context);
      if (Option.isSome(resolution)) return resolution;
    }
    return Option.none();
  });
