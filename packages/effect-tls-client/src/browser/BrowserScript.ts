import { Effect, Schema } from "effect";

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

/** Errors returned by a caller-supplied browser script runtime. */
export class BrowserScriptError extends Schema.TaggedError<BrowserScriptError>()(
  "BrowserScriptError",
  {
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** The small, serializable page state visible to a script. */
export const BrowserScriptContext = Schema.Struct({
  url: Schema.String,
  cookie: Schema.String,
  userAgent: Schema.String,
});
export interface BrowserScriptContext extends Schema.Schema.Type<
  typeof BrowserScriptContext
> {}

/** A script result and the raw cookie writes it requested. */
export const BrowserScriptResult = Schema.Struct({
  value: Schema.String,
  setCookies: Schema.Array(Schema.String),
});
export interface BrowserScriptResult extends Schema.Schema.Type<
  typeof BrowserScriptResult
> {}

/**
 * An evaluator at a process-backed browser-script boundary, not a malicious-code
 * sandbox. Implementations must terminate synchronous work rather than relying
 * on Effect interruption.
 */
export interface BrowserScriptRuntime {
  readonly evaluate: (
    source: string,
    context?: BrowserScriptContext,
  ) => Effect.Effect<BrowserScriptResult, BrowserScriptError>;
}

/**
 * Runs a script through fixed source/result limits and a cooperative outer time
 * limit. A runtime such as BrowserMock supplies the hard process cutoff.
 */
export const runBoundedScript = Effect.fn("BrowserScript.runBounded")(
  function* (
    runtime: BrowserScriptRuntime,
    input: unknown,
    context?: BrowserScriptContext,
  ) {
    const source = yield* Schema.decodeUnknownEffect(Schema.String)(input).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserScriptError({
            reason: "script source is not a string",
            cause,
          }),
      ),
    );
    if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
      return yield* new BrowserScriptError({
        reason: "script source exceeds the 64 KiB limit",
      });
    }

    const result = yield* Effect.try({
      try: () => runtime.evaluate(source, context),
      catch: (cause) =>
        new BrowserScriptError({
          reason: "script runtime threw before evaluation",
          cause,
        }),
    }).pipe(
      Effect.flatMap((effect) => effect),
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () =>
          Effect.fail(
            new BrowserScriptError({ reason: "script evaluation timed out" }),
          ),
      }),
    );
    const output = yield* Schema.decodeEffect(BrowserScriptResult)(result).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserScriptError({
            reason: "script runtime returned an invalid result",
            cause,
          }),
      ),
    );
    const encoder = new TextEncoder();
    if (encoder.encode(output.value).byteLength > MAX_RESULT_BYTES) {
      return yield* new BrowserScriptError({
        reason: "script result exceeds the 64 KiB limit",
      });
    }
    if (
      output.setCookies.reduce(
        (bytes, cookie) => bytes + encoder.encode(cookie).byteLength,
        0,
      ) > MAX_RESULT_BYTES
    ) {
      return yield* new BrowserScriptError({
        reason: "script cookie output exceeds the 64 KiB limit",
      });
    }
    return output;
  },
);
