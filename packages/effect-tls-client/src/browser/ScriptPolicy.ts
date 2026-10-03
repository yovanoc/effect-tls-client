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

export const scriptOrigin = (input: string): string => parseUrl(input).origin;

export const resolveAllowedUrl = (
  input: string,
  base: string,
  allowedOrigins: ReadonlyArray<string>,
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
  url.hash = "";
  return url;
};
