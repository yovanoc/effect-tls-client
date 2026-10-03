import { Duration, Effect, Schema, type Option } from "effect";

import { DOCUMENT_INPUT_RULES } from "./HtmlSnapshot.js";

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

/** Errors returned by a caller-supplied browser script runtime. */
export class BrowserScriptError extends Schema.TaggedError<BrowserScriptError>()(
  "BrowserScriptError",
  {
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
    /** BrowserMock pre-spawn host validation only; never populated from guest IPC.
     * Caller-supplied runtimes remain caller authority, not a sandbox guarantee.
     */
    documentInputRule: Schema.optionalKey(
      Schema.Literals(DOCUMENT_INPUT_RULES),
    ),
    documentInputFailure: Schema.optionalKey(
      Schema.Literals([
        "InvalidContext",
        "ConflictingInputs",
        "UnsupportedInput",
        "SnapshotLimitExceeded",
        "StartupLimitExceeded",
      ]),
    ),
  },
) {}

/** The small, serializable page state visible to a script. */
export const BrowserScriptContext = Schema.Struct({
  url: Schema.String,
  cookie: Schema.String,
  userAgent: Schema.String,
  languages: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(16)),
  ),
  referrer: Schema.optionalKey(Schema.String),
  /** Explicit complete strict body fragment; BrowserMock validates it before spawn. */
  html: Schema.optionalKey(Schema.String),
  /** Explicit whole strict document; mutually exclusive with html. */
  document: Schema.optionalKey(Schema.String),
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
export interface BrowserScriptRequest {
  readonly kind: "fetch" | "script";
  readonly url: string;
  readonly method: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** At most one of the string and raw-byte body fields is non-null. */
  readonly body: string | null;
  readonly bodyBytes: ReadonlyArray<number> | null;
}

export interface BrowserScriptNetworkResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
  readonly cookie: string;
  readonly error?: string;
}

/** Untrusted HTML evidence; never automatically extracted or executed. */
export const UntrustedFrameCandidate = Schema.Struct({
  parentUrl: Schema.String,
  url: Schema.String,
  origin: Schema.String,
  status: Schema.Int,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  body: Schema.String,
});
export interface UntrustedFrameCandidate extends Schema.Schema.Type<
  typeof UntrustedFrameCandidate
> {}

/** Only caller-selected source may leave the host. Cookies are read-only. */
export const ReviewedFrame = Schema.Struct({
  scripts: Schema.Array(Schema.String).check(
    Schema.isMaxLength(8),
    Schema.makeFilter(
      (scripts) =>
        scripts.reduce(
          (bytes, source) =>
            bytes + new TextEncoder().encode(source).byteLength,
          0,
        ) <= MAX_SOURCE_BYTES || "frame scripts exceed the 64 KiB limit",
    ),
  ),
  cookiePolicy: Schema.optionalKey(Schema.Literals(["none", "same-origin"])),
});
export interface ReviewedFrame extends Schema.Schema.Type<
  typeof ReviewedFrame
> {}

export type BrowserFrameReviewer = (
  candidate: UntrustedFrameCandidate,
) => Effect.Effect<Option.Option<ReviewedFrame>, BrowserScriptError>;

export const FrameLoadResult = Schema.Struct({
  parentUrl: UntrustedFrameCandidate.fields.parentUrl,
  url: UntrustedFrameCandidate.fields.url,
  origin: UntrustedFrameCandidate.fields.origin,
  status: UntrustedFrameCandidate.fields.status,
  headers: UntrustedFrameCandidate.fields.headers,
  scripts: ReviewedFrame.fields.scripts,
  cookie: Schema.NullOr(Schema.String),
});
export interface FrameLoadResult extends Schema.Schema.Type<
  typeof FrameLoadResult
> {}

/** Host capabilities are serialized through the runner; no callback enters the VM. */
export interface BrowserScriptHost {
  /** Absent unless the caller explicitly supplies a trusted reviewer. */
  readonly loadFrame?: (
    url: string,
  ) => Effect.Effect<FrameLoadResult, BrowserScriptError>;
  readonly request: (
    request: BrowserScriptRequest,
  ) => Effect.Effect<BrowserScriptNetworkResponse, BrowserScriptError>;
  readonly setCookie: (
    value: string,
  ) => Effect.Effect<string, BrowserScriptError>;
}

export const BrowserScriptMode = Schema.Literals(["async", "classic"]);

export interface BrowserScriptRuntime {
  readonly evaluateClassic?: BrowserScriptRuntime["evaluate"];
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly evaluate: (
    source: string,
    context?: BrowserScriptContext,
    host?: BrowserScriptHost,
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
    host?: BrowserScriptHost,
    mode: "async" | "classic" = "async",
  ) {
    const executionMode = yield* Schema.decodeEffect(BrowserScriptMode)(
      mode,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserScriptError({
            reason: "invalid script execution mode",
            cause,
          }),
      ),
    );
    const evaluate =
      executionMode === "classic" ? runtime.evaluateClassic : runtime.evaluate;
    if (evaluate === undefined) {
      return yield* new BrowserScriptError({
        reason: "Runtime does not support classic script evaluation",
      });
    }
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
      try: () => evaluate.call(runtime, source, context, host),
      catch: (cause) =>
        new BrowserScriptError({
          reason: "script runtime threw before evaluation",
          cause,
        }),
    }).pipe(
      Effect.flatMap((effect) => effect),
      Effect.timeoutOrElse({
        duration: Duration.millis(runtime.timeoutMs ?? 2_000),
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
