import { Effect, Exit, Option, Schema, type Scope } from "effect";
import {
  SessionConfig,
  TlsClient,
  type Pair,
  type RequestBody,
  type TlsResponse,
  type TlsSession,
} from "../TlsClient.js";
import {
  Identity,
  Pair as PairSchema,
  type SessionConfig as SessionConfigType,
} from "../internal/Protocol.js";
import type { BridgeError } from "../internal/Errors.js";
import {
  BrowserScriptError,
  runBoundedScript,
  type BrowserScriptRuntime,
} from "./BrowserScript.js";

const MAX_REDIRECTS = 15;
const MAX_CHALLENGE_RETRIES = 1;
const MAX_CONFIG_REDIRECTS = 100;
const MAX_CONFIG_CHALLENGE_RETRIES = 10;
/** Cooperative interruption deadline; it cannot preempt synchronous handlers. */
const CHALLENGE_HANDLER_TIMEOUT = "5 seconds";
const LOCATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const RedirectCount = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(MAX_CONFIG_REDIRECTS),
);
const ChallengeCount = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(MAX_CONFIG_CHALLENGE_RETRIES),
);

const BrowserErrorKind = Schema.Literals([
  "Config",
  "CookieHeader",
  "Redirect",
  "RedirectLimit",
  "ChallengeLimit",
]);
type BrowserErrorKind = Schema.Schema.Type<typeof BrowserErrorKind>;

/** A typed error for browser-layer work that is not a transport failure. */
export class BrowserSessionError extends Schema.TaggedError<BrowserSessionError>()(
  "BrowserSessionError",
  {
    operation: Schema.String,
    kind: BrowserErrorKind,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** Browser headers that must be supplied to the transport session at creation. */
export const BrowserIdentity = Identity;
export type BrowserIdentity = Schema.Schema.Type<typeof BrowserIdentity>;

/** Configuration for a scoped browser session backed by one TlsSession. */
export const BrowserSessionConfig = Schema.Struct({
  transport: SessionConfig,
  identity: BrowserIdentity,
  maxRedirects: Schema.optionalKey(RedirectCount),
  maxChallengeRetries: Schema.optionalKey(ChallengeCount),
});
export interface BrowserSessionConfig extends Schema.Schema.Type<
  typeof BrowserSessionConfig
> {}

/** Request controls for browser-kind GET and POST requests. */
export interface BrowserRequestOptions {
  readonly referer?: string;
  readonly origin?: string;
  readonly headers?: ReadonlyArray<Pair>;
  readonly body?: RequestBody;
  readonly navigation?: boolean;
}

/** Navigation controls for the initial page request. */
export interface BrowserNavigateOptions {
  readonly referer?: string;
  readonly headers?: ReadonlyArray<Pair>;
}

const BrowserRequestOptionsSchema = Schema.Struct({
  referer: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Array(PairSchema)),
  navigation: Schema.optionalKey(Schema.Boolean),
});

const BrowserNavigateOptionsSchema = Schema.Struct({
  referer: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Array(PairSchema)),
});

const decodeBrowserRequestOptions = (
  options: BrowserRequestOptions | undefined,
): Effect.Effect<BrowserRequestOptions, BrowserSessionError> =>
  Schema.decodeEffect(BrowserRequestOptionsSchema)(options ?? {}).pipe(
    Effect.mapError(
      (cause) =>
        new BrowserSessionError({
          operation: "browser request options",
          kind: "Config",
          message: "invalid browser request options",
          cause,
        }),
    ),
    Effect.map((parsed) =>
      options?.body === undefined ? parsed : { ...parsed, body: options.body },
    ),
  );

const decodeBrowserNavigateOptions = (
  options: BrowserNavigateOptions | undefined,
): Effect.Effect<BrowserNavigateOptions, BrowserSessionError> =>
  Schema.decodeEffect(BrowserNavigateOptionsSchema)(options ?? {}).pipe(
    Effect.mapError(
      (cause) =>
        new BrowserSessionError({
          operation: "browser navigation options",
          kind: "Config",
          message: "invalid browser navigation options",
          cause,
        }),
    ),
  );

/** A recognized AWS WAF challenge response. */
export const BrowserChallenge = Schema.Struct({
  kind: Schema.Literals(["AwsWaf"]),
  status: Schema.Int,
  url: Schema.String,
  headers: Schema.Array(PairSchema),
  evidence: Schema.Literals(["x-amzn-waf-action"]),
});
export interface BrowserChallenge extends Schema.Schema.Type<
  typeof BrowserChallenge
> {}

/** A retry request returned by an application-provided challenge handler. */
export interface BrowserChallengeResolution {
  readonly url?: string;
  readonly headers?: ReadonlyArray<Pair>;
}

/** Context made available to an optional challenge handler. */
export interface BrowserChallengeContext {
  readonly transport: TlsSession;
  readonly response: TlsResponse;
  readonly body: string;
  /** The runtime has a hard cutoff; host cookie reads/writes can still fail. */
  readonly evaluate: (
    source: unknown,
  ) => Effect.Effect<string, BrowserOperationError>;
}

/**
 * An application-owned challenge hook. Returning `None` leaves the challenge
 * response visible to the caller instead of claiming that it was solved.
 */
export type BrowserChallengeHandler = (
  challenge: BrowserChallenge,
  context: BrowserChallengeContext,
) => Effect.Effect<
  Option.Option<BrowserChallengeResolution>,
  BrowserOperationError
>;

/** Optional application-owned script and challenge capabilities. */
export interface BrowserHandlers {
  readonly challengeHandler?: BrowserChallengeHandler;
  readonly scriptRuntime?: BrowserScriptRuntime;
}

/** A page returned by navigation after redirects and HTML redirects settle. */
export interface BrowserPage {
  readonly status: number;
  readonly url: string;
  readonly headers: ReadonlyArray<Pair>;
  readonly protocol: TlsResponse["protocol"];
  readonly body: string;
  readonly response: TlsResponse;
  readonly challenge?: BrowserChallenge;
  readonly cloudFrontForbidden: boolean;
  readonly close: Effect.Effect<void>;
}

/** Browser operations fail with the underlying typed transport error or a browser error. */
export type BrowserOperationError =
  | BridgeError
  | BrowserSessionError
  | BrowserScriptError;

/** Header order used by the supplied Chrome identity helpers. */
export const ChromeHeaderOrder = [
  "host",
  "connection",
  "content-length",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "upgrade-insecure-requests",
  "user-agent",
  "accept",
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-user",
  "sec-fetch-dest",
  "referer",
  "accept-encoding",
  "accept-language",
  "cookie",
  "content-type",
] as const;

const makeChromeIdentity = (major: number): BrowserIdentity => {
  const version = `${major}.0.0.0`;
  return BrowserIdentity.make({
    headers: [
      [
        "user-agent",
        `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
      ],
      ["accept-language", "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"],
      [
        "sec-ch-ua",
        `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not?A_Brand";v="24"`,
      ],
      ["sec-ch-ua-mobile", "?0"],
      ["sec-ch-ua-platform", '"macOS"'],
    ],
    headerOrder: ChromeHeaderOrder,
  });
};

/** Creates a Chrome-like identity for a matching transport profile. */
export const chromeIdentity = makeChromeIdentity;

/** Chrome identity matching the legacy browser reference profile. */
export const Chrome146Identity = makeChromeIdentity(146);

/** Chrome identity matching the current example profile. */
export const Chrome152Identity = makeChromeIdentity(152);

const headerValue = (
  headers: ReadonlyArray<Pair>,
  name: string,
): string | undefined =>
  headers.find(([headerName]) => headerName.toLowerCase() === name)?.[1];

const mergeHeaders = (
  base: ReadonlyArray<Pair>,
  additions: ReadonlyArray<Pair>,
): Array<Pair> => {
  const result = [...base];
  for (const [name, value] of additions) {
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (result[index]?.[0].toLowerCase() === name.toLowerCase()) {
        result.splice(index, 1);
      }
    }
    result.push([name, value]);
  }
  return result;
};

const sameSite = (referer: string, target: string): string => {
  if (referer === "") return "none";
  try {
    const refererUrl = new URL(referer);
    const targetUrl = new URL(target);
    if (refererUrl.origin === targetUrl.origin) return "same-origin";
    const site = (url: URL): string => {
      const labels = url.hostname.split(".");
      return labels.length < 2 ? url.hostname : labels.slice(-2).join(".");
    };
    return refererUrl.protocol === targetUrl.protocol &&
      site(refererUrl) === site(targetUrl)
      ? "same-site"
      : "cross-site";
  } catch {
    return "cross-site";
  }
};

const sanitizeReferer = (
  referer: string,
  target: string,
): string | undefined => {
  if (referer === "") return undefined;
  try {
    const refererUrl = new URL(referer);
    const targetUrl = new URL(target);
    if (
      !["http:", "https:"].includes(refererUrl.protocol) ||
      !["http:", "https:"].includes(targetUrl.protocol) ||
      (refererUrl.protocol === "https:" && targetUrl.protocol === "http:")
    ) {
      return undefined;
    }
    refererUrl.username = "";
    refererUrl.password = "";
    refererUrl.hash = "";
    return refererUrl.origin === targetUrl.origin
      ? refererUrl.toString()
      : refererUrl.origin;
  } catch {
    return undefined;
  }
};

const refererHeaders = (
  referer: string,
  target: string,
): ReadonlyArray<Pair> => {
  const sanitized = sanitizeReferer(referer, target);
  return sanitized === undefined ? [] : [["referer", sanitized]];
};

/** Builds navigation headers without adding a Cookie header. */
export const navigationHeaders = (
  baseHints: ReadonlyArray<Pair>,
  target: string,
  referer = "",
  extra: ReadonlyArray<Pair> = [],
): ReadonlyArray<Pair> =>
  mergeHeaders(baseHints, [
    [
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    ],
    ["sec-fetch-dest", "document"],
    ["sec-fetch-mode", "navigate"],
    ["sec-fetch-site", sameSite(referer, target)],
    ["sec-fetch-user", "?1"],
    ["upgrade-insecure-requests", "1"],
    ...refererHeaders(referer, target),
    ...extra,
  ]);

/** Builds XHR/fetch-like headers without adding a Cookie header. */
export const xhrHeaders = (
  baseHints: ReadonlyArray<Pair>,
  target: string,
  referer = "",
  origin = "",
  extra: ReadonlyArray<Pair> = [],
): ReadonlyArray<Pair> =>
  mergeHeaders(baseHints, [
    ["accept", "application/json, text/plain, */*"],
    ["sec-fetch-dest", "empty"],
    ["sec-fetch-mode", "cors"],
    ["sec-fetch-site", sameSite(referer, target)],
    ...(origin === "" ? [] : ([["origin", origin]] as const)),
    ...refererHeaders(referer, target),
    ...extra,
  ]);

const htmlRedirect = (body: string): Option.Option<string> => {
  const markup = body
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, "")
    .replaceAll(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/giu, "");
  const meta =
    /<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=(?<target>[^"'>\s]+)/iu.exec(
      markup,
    );
  if (meta === null || meta.groups === undefined) {
    return Option.none();
  }
  const target = meta.groups["target"];
  if (target === undefined) {
    return Option.none();
  }
  return Option.some(target.replaceAll("&amp;", "&"));
};

const absoluteUrl = (
  target: string,
  base: string,
): Effect.Effect<string, BrowserSessionError> =>
  Effect.try({
    try: () => {
      const url = new URL(target, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("redirect protocol must be HTTP or HTTPS");
      }
      return url.toString();
    },
    catch: (cause) =>
      new BrowserSessionError({
        operation: "navigate redirect target",
        kind: "Redirect",
        message: "redirect target is not a valid URL",
        cause,
      }),
  });

/** Recognizes only the explicit AWS WAF action header, not a guessed solver page. */
export const recognizeAwsWafChallenge = (
  response: Pick<TlsResponse, "status" | "url" | "headers">,
): BrowserChallenge | undefined =>
  headerValue(response.headers, "x-amzn-waf-action")?.trim().toLowerCase() ===
  "challenge"
    ? BrowserChallenge.make({
        kind: "AwsWaf",
        status: response.status,
        url: response.url,
        headers: response.headers,
        evidence: "x-amzn-waf-action",
      })
    : undefined;

/** Identifies the observed CloudFront 403 without calling it a completed challenge. */
export const isCloudFrontForbidden = (
  response: Pick<TlsResponse, "status" | "headers">,
): boolean =>
  response.status === 403 &&
  headerValue(response.headers, "server")
    ?.toLowerCase()
    .includes("cloudfront") === true;

const validateHeaders = (
  operation: string,
  headers: ReadonlyArray<Pair>,
): Effect.Effect<void, BrowserSessionError> =>
  headers.some(([name]) => name.toLowerCase() === "cookie")
    ? Effect.fail(
        new BrowserSessionError({
          operation,
          kind: "CookieHeader",
          message:
            "Cookie headers are owned by the TlsSession cookie jar; use transport.setCookies",
        }),
      )
    : Effect.void;

const redirectTarget = (
  response: TlsResponse,
  body: string,
): Option.Option<string> =>
  Option.orElse(
    LOCATION_REDIRECT_STATUSES.has(response.status)
      ? Option.fromNullishOr(headerValue(response.headers, "location"))
      : Option.none(),
    () => htmlRedirect(body),
  );

const pageFrom = (
  response: TlsResponse,
  body: string,
  challenge: BrowserChallenge | undefined,
): BrowserPage => ({
  status: response.status,
  url: response.url,
  headers: response.headers,
  protocol: response.protocol,
  body,
  response,
  ...(challenge === undefined ? {} : { challenge }),
  cloudFrontForbidden: isCloudFrontForbidden(response),
  close: response.close,
});

const readBody = (response: TlsResponse): Effect.Effect<string, BridgeError> =>
  response.text;

interface Step {
  readonly current: string;
  readonly referer: string;
  readonly extraHeaders: ReadonlyArray<Pair>;
  readonly hop: number;
  readonly challengeRetries: number;
}

/** A scoped browser facade over an existing TlsSession. */
export interface BrowserSession {
  readonly id: string;
  readonly transport: TlsSession;
  readonly get: (
    url: string,
    options?: BrowserRequestOptions,
  ) => Effect.Effect<TlsResponse, BrowserOperationError, Scope.Scope>;
  readonly post: (
    url: string,
    options?: BrowserRequestOptions,
  ) => Effect.Effect<TlsResponse, BrowserOperationError, Scope.Scope>;
  readonly navigate: (
    url: string,
    options?: BrowserNavigateOptions,
  ) => Effect.Effect<BrowserPage, BrowserOperationError, Scope.Scope>;
}

const makeBrowserSession = (
  transport: TlsSession,
  identity: BrowserIdentity,
  limits: Pick<BrowserSessionConfig, "maxRedirects" | "maxChallengeRetries">,
  handlers: BrowserHandlers,
  identityAlreadyConfigured = false,
): BrowserSession => {
  const maxRedirects = limits.maxRedirects ?? MAX_REDIRECTS;
  const maxChallengeRetries =
    limits.maxChallengeRetries ?? MAX_CHALLENGE_RETRIES;
  const requestIdentityHeaders: ReadonlyArray<Pair> = identityAlreadyConfigured
    ? []
    : identity.headers;
  const requestHeaderOrder = identityAlreadyConfigured
    ? undefined
    : identity.headerOrder;
  const identityValidation = validateHeaders(
    "browser identity",
    identity.headers,
  );
  const evaluate = (response: TlsResponse, source: unknown) => {
    const runtime = handlers.scriptRuntime;
    if (runtime === undefined) {
      return Effect.fail(
        new BrowserScriptError({ reason: "script runtime unavailable" }),
      );
    }
    return Effect.gen(function* () {
      const visibleCookie = yield* transport.scriptCookies(response.url);
      const result = yield* runBoundedScript(runtime, source, {
        url: response.url,
        cookie: visibleCookie,
        userAgent: headerValue(identity.headers, "user-agent") ?? "",
      });
      yield* transport.scriptCookies(response.url, result.setCookies);
      return result.value;
    });
  };

  const get = Effect.fn("BrowserSession.get")(function* (
    url: string,
    options?: BrowserRequestOptions,
  ) {
    yield* identityValidation;
    const input = yield* decodeBrowserRequestOptions(options);
    const headers = input.headers ?? [];
    yield* validateHeaders("get headers", headers);
    return yield* transport.request(url, {
      method: "GET",
      headers: xhrHeaders(
        requestIdentityHeaders,
        url,
        input.referer ?? "",
        input.origin ?? "",
        headers,
      ),
      ...(requestHeaderOrder === undefined
        ? {}
        : { headerOrder: requestHeaderOrder }),
      followRedirects: false,
    });
  });

  const post = Effect.fn("BrowserSession.post")(function* (
    url: string,
    options?: BrowserRequestOptions,
  ) {
    yield* identityValidation;
    const input = yield* decodeBrowserRequestOptions(options);
    const headers = input.headers ?? [];
    yield* validateHeaders("post headers", headers);
    const base =
      input.navigation === true
        ? navigationHeaders(
            requestIdentityHeaders,
            url,
            input.referer ?? "",
            headers,
          )
        : xhrHeaders(
            requestIdentityHeaders,
            url,
            input.referer ?? "",
            input.origin ?? "",
            headers,
          );
    const stamped =
      input.navigation === true &&
      input.origin !== undefined &&
      input.origin !== ""
        ? mergeHeaders(base, [["origin", input.origin]])
        : base;
    return yield* transport.request(url, {
      method: "POST",
      headers: stamped,
      ...(requestHeaderOrder === undefined
        ? {}
        : { headerOrder: requestHeaderOrder }),
      ...(input.body === undefined ? {} : { body: input.body }),
      followRedirects: false,
    });
  });

  const navigate = Effect.fn("BrowserSession.navigate")(function* (
    startUrl: string,
    options?: BrowserNavigateOptions,
  ) {
    yield* identityValidation;
    const inputOptions = yield* decodeBrowserNavigateOptions(options);
    const initialHeaders = inputOptions.headers ?? [];
    yield* validateHeaders("navigate headers", initialHeaders);

    const step = (
      input: Step,
    ): Effect.Effect<BrowserPage, BrowserOperationError, Scope.Scope> =>
      Effect.gen(function* () {
        if (input.hop > maxRedirects) {
          return yield* new BrowserSessionError({
            operation: "navigate",
            kind: "RedirectLimit",
            message: `navigation exceeded ${maxRedirects} redirects`,
          });
        }
        const response = yield* transport.request(input.current, {
          method: "GET",
          headers: navigationHeaders(
            requestIdentityHeaders,
            input.current,
            input.referer,
            input.extraHeaders,
          ),
          ...(requestHeaderOrder === undefined
            ? {}
            : { headerOrder: requestHeaderOrder }),
          followRedirects: false,
        });
        const location = LOCATION_REDIRECT_STATUSES.has(response.status)
          ? headerValue(response.headers, "location")
          : undefined;
        if (location !== undefined) {
          const next = yield* absoluteUrl(location, input.current).pipe(
            Effect.ensuring(response.close),
          );
          return yield* step({
            current: next,
            referer: input.current,
            extraHeaders: [],
            hop: input.hop + 1,
            challengeRetries: input.challengeRetries,
          });
        }

        const body = yield* readBody(response).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? response.close : Effect.void,
          ),
        );
        const challenge = recognizeAwsWafChallenge(response);
        if (
          challenge !== undefined &&
          handlers.challengeHandler !== undefined &&
          input.challengeRetries < maxChallengeRetries
        ) {
          const resolution = yield* handlers
            .challengeHandler(challenge, {
              transport,
              response,
              body,
              evaluate: (source) => evaluate(response, source),
            })
            .pipe(
              Effect.timeoutOrElse({
                duration: CHALLENGE_HANDLER_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new BrowserSessionError({
                      operation: "challenge handler",
                      kind: "ChallengeLimit",
                      message: "challenge handler timed out",
                    }),
                  ),
              }),
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? response.close : Effect.void,
              ),
            );
          if (Option.isSome(resolution)) {
            const retryHeaders = resolution.value.headers ?? [];
            const next = yield* Effect.gen(function* () {
              yield* validateHeaders("challenge headers", retryHeaders);
              return resolution.value.url === undefined
                ? input.current
                : yield* absoluteUrl(resolution.value.url, input.current);
            }).pipe(Effect.ensuring(response.close));
            return yield* step({
              current: next,
              referer: response.url,
              extraHeaders: retryHeaders,
              hop: input.hop,
              challengeRetries: input.challengeRetries + 1,
            });
          }
        }

        const htmlTarget = redirectTarget(response, body);
        if (Option.isSome(htmlTarget)) {
          const next = yield* absoluteUrl(htmlTarget.value, response.url).pipe(
            Effect.ensuring(response.close),
          );
          return yield* step({
            current: next,
            referer: response.url,
            extraHeaders: [],
            hop: input.hop + 1,
            challengeRetries: input.challengeRetries,
          });
        }

        return pageFrom(response, body, challenge);
      });

    return yield* step({
      current: startUrl,
      referer: inputOptions.referer ?? "",
      extraHeaders: initialHeaders,
      hop: 0,
      challengeRetries: 0,
    });
  });

  return { id: transport.id, transport, get, post, navigate };
};

/**
 * Wraps an existing scoped TlsSession without creating another transport or cookie jar.
 * The transport identity is fixed already, so it must have no Cookie header; this
 * wrapper cannot inspect or remove one configured on the existing session.
 */
export const fromSession = (
  transport: TlsSession,
  identity: BrowserIdentity,
  handlers: BrowserHandlers = {},
): BrowserSession =>
  makeBrowserSession(
    transport,
    identity,
    { maxRedirects: MAX_REDIRECTS, maxChallengeRetries: MAX_CHALLENGE_RETRIES },
    handlers,
  );

/** Opens one scoped TlsSession and adds browser navigation on top of it. */
export const open = Effect.fn("BrowserSession.open")(function* (
  input: unknown,
  handlers: BrowserHandlers = {},
) {
  const config = yield* Schema.decodeUnknownEffect(BrowserSessionConfig)(
    input,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new BrowserSessionError({
          operation: "browser session config",
          kind: "Config",
          message: "invalid browser session configuration",
          cause,
        }),
    ),
  );
  yield* validateHeaders("browser identity", config.identity.headers);
  const client = yield* TlsClient;
  const transportConfig: SessionConfigType = {
    ...config.transport,
    identity: config.identity,
  };
  const transport = yield* client.session(transportConfig);
  return makeBrowserSession(transport, config.identity, config, handlers, true);
});
