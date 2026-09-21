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

/**
 * A script evaluator supplied by the application at a trusted sandbox boundary.
 * The runtime must cooperate with Effect interruption; this is not a CPU or
 * security boundary for synchronous evaluators.
 */
export interface BrowserScriptRuntime {
  readonly evaluate: (
    source: string,
  ) => Effect.Effect<string, BrowserScriptError>;
}

/**
 * Runs a script through an optional runtime with fixed source/result limits and
 * a cooperative time limit. Synchronous runtime work cannot be preempted.
 * This module deliberately does not provide a Node `vm` or vendor-script executor.
 */
export const runBoundedScript = Effect.fn("BrowserScript.runBounded")(
  function* (runtime: BrowserScriptRuntime, input: unknown) {
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
      try: () => runtime.evaluate(source),
      catch: (cause) =>
        new BrowserScriptError({
          reason: "script runtime threw before evaluation",
          cause,
        }),
    }).pipe(
      Effect.flatMap((effect) => effect),
      // This timeout can only interrupt a runtime that cooperates with Effect.
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () =>
          Effect.fail(
            new BrowserScriptError({ reason: "script evaluation timed out" }),
          ),
      }),
    );
    const output = yield* Schema.decodeEffect(Schema.String)(result).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserScriptError({
            reason: "script runtime returned a non-string result",
            cause,
          }),
      ),
    );
    if (new TextEncoder().encode(output).byteLength > MAX_RESULT_BYTES) {
      return yield* new BrowserScriptError({
        reason: "script result exceeds the 64 KiB limit",
      });
    }
    return output;
  },
);
