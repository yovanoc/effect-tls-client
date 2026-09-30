import { Effect, Option, Schema } from "effect";
import { Cookies } from "effect/unstable/http";
import {
  BrowserSessionError,
  type BrowserChallengeHandler,
} from "./Browser.js";

const Options = Schema.Struct({
  source: Schema.NonEmptyString,
  cookieNames: Schema.NonEmptyArray(Schema.NonEmptyString),
});

/** Reviewed source and the nonempty cookies required to request a retry. */
export interface ReviewedChallengeOptions extends Schema.Schema.Type<
  typeof Options
> {}

/** Runs opt-in reviewed source; fresh Jar cookies are retry evidence, not proof of clearance. */
export const reviewedChallengeHandler = (
  options: ReviewedChallengeOptions,
): BrowserChallengeHandler =>
  Effect.fn("Browser.reviewedChallengeHandler")(
    function* (_challenge, context) {
      const config = yield* Schema.decodeEffect(Options)(options).pipe(
        Effect.mapError((cause) =>
          BrowserSessionError.make({
            operation: "reviewed challenge options",
            kind: "Config",
            message: "invalid reviewed challenge options",
            cause,
          }),
        ),
      );
      const before = yield* context.transport.cookies(context.response.url);
      yield* context.evaluate(config.source);
      const after = yield* context.transport.cookies(context.response.url);

      const present = config.cookieNames.every((name) =>
        Option.exists(
          Cookies.get(after, name),
          (cookie) => cookie.value !== "",
        ),
      );
      const changed = config.cookieNames.some((name) =>
        Option.exists(
          Cookies.get(after, name),
          (cookie) =>
            !Option.exists(
              Cookies.get(before, name),
              (previous) => previous.value === cookie.value,
            ),
        ),
      );
      return present && changed ? Option.some({}) : Option.none();
    },
  );
