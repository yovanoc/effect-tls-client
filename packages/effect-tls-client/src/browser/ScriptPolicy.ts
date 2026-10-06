import { Schema } from "effect";

const MAX_ALLOWED_ORIGINS = 32;

const parseUrl = (input: string, base?: string): URL => {
  try {
    return base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    throw new TypeError("invalid script network URL");
  }
};

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  hostname === "::1" ||
  /^127(?:\.\d{1,3}){3}$/u.test(hostname);

export const normalizeAllowedOrigins = (
  input: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (input.length > MAX_ALLOWED_ORIGINS) {
    throw new TypeError(
      `allowedOrigins cannot exceed ${MAX_ALLOWED_ORIGINS} entries`,
    );
  }
  return [
    ...new Set(
      input.map((value) => {
        const url = parseUrl(value);
        if (
          (url.protocol !== "https:" && url.protocol !== "http:") ||
          url.username !== "" ||
          url.password !== "" ||
          url.pathname !== "/" ||
          url.search !== "" ||
          url.hash !== "" ||
          (url.protocol === "http:" && !isLoopback(url.hostname))
        ) {
          throw new TypeError(`not an allowed script origin: ${value}`);
        }
        return url.origin;
      }),
    ),
  ];
};

// Reject rather than normalize path spelling that intermediaries may interpret differently.
const isUnambiguousPath = (path: string): boolean =>
  !/[\\%\s\u0000-\u001f\u007f?#]/u.test(path) &&
  !path.includes("//") &&
  !path.split("/").some((segment) => segment === "." || segment === "..");

export const AllowedPathPrefixes = Schema.Record(
  Schema.String,
  Schema.Array(
    Schema.String.check(
      Schema.makeFilter(
        (prefix) =>
          prefix.startsWith("/") &&
          isUnambiguousPath(prefix) &&
          new URL(prefix, "https://path-policy.invalid").pathname === prefix,
      ),
    ),
  ),
).check(
  Schema.makeFilter((mapping) =>
    Object.keys(mapping).every((origin) => {
      try {
        return normalizeAllowedOrigins([origin])[0] === origin;
      } catch {
        return false;
      }
    }),
  ),
);

export const ScriptPolicy = Schema.Struct({
  allowedPathPrefixes: Schema.optionalKey(AllowedPathPrefixes),
});
export interface ScriptPolicy extends Schema.Schema.Type<typeof ScriptPolicy> {}

export const scriptOrigin = (input: string): string => parseUrl(input).origin;

export const resolveAllowedUrl = (
  input: string,
  base: string,
  allowedOrigins: ReadonlyArray<string>,
  allowedPathPrefixes?: Readonly<Record<string, ReadonlyArray<string>>>,
): URL => {
  const url = parseUrl(input, base);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    !allowedOrigins.includes(url.origin)
  ) {
    throw new TypeError(`script network origin is not allowed: ${url.origin}`);
  }
  const prefixes =
    allowedPathPrefixes !== undefined &&
    Object.hasOwn(allowedPathPrefixes, url.origin)
      ? allowedPathPrefixes[url.origin]
      : undefined;
  if (prefixes !== undefined) {
    // Check raw spelling: WHATWG URL erases dot segments and backslashes.
    const reference = input.split(/[?#]/u)[0] ?? "";
    const path = reference.replace(/^(?:https?:)?\/\/[^/]*/iu, "");
    if (
      /[\\\s\u0000-\u001f\u007f]/u.test(reference) ||
      !isUnambiguousPath(path) ||
      !isUnambiguousPath(url.pathname)
    ) {
      throw new TypeError("ambiguous script network path");
    }
  }
  if (
    prefixes !== undefined &&
    !prefixes.some(
      (prefix) =>
        url.pathname === prefix ||
        url.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
    )
  ) {
    throw new TypeError(`script network path is not allowed: ${url.pathname}`);
  }
  url.hash = "";
  return url;
};
