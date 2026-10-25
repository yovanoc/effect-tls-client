import type { AwsWafPageScript } from "../AwsWaf.js";

const MAX_SCRIPTS = 16;
const MAX_SOURCE_BYTES = 64 * 1024;

const unsupported = (reason: string): AwsWafPageScript => ({
  _tag: "Unsupported",
  reason,
});

/** Bounded classic-script discovery, not an HTML tree builder or JS parser. */
export const discoverAwsWafScripts = (
  html: string,
): ReadonlyArray<AwsWafPageScript> => {
  // ponytail: bounded scanner, reject ambiguous markup; use an HTML parser if broader documents are required.
  if (html.length > 1024 * 1024) {
    return [unsupported("page exceeds the 1 MiB discovery limit")];
  }
  const scripts: Array<AwsWafPageScript> = [];
  const tags =
    /<!--[\s\S]*?(?:-->|$)|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|<![^>]*>|<\?[^>]*>/iuy;
  let sourceBytes = 0;
  let offset = 0;
  while (offset < html.length) {
    const start = html.indexOf("<", offset);
    if (start < 0) break;
    tags.lastIndex = start;
    const tag = tags.exec(html);
    if (tag === null) {
      return [
        ...scripts.slice(0, MAX_SCRIPTS - 1),
        unsupported("ambiguous HTML markup"),
      ];
    }
    offset = tags.lastIndex;
    const markup = tag[0];
    if (markup.startsWith("<!--")) continue;
    if (markup.startsWith("<!") || markup.startsWith("<?")) {
      // A doctype is inert; other declaration forms have context-dependent parsing.
      if (/^<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>$/iu.test(markup)) continue;
      return [
        ...scripts.slice(0, MAX_SCRIPTS - 1),
        unsupported("ambiguous HTML declaration"),
      ];
    }
    if (markup.startsWith("</")) continue;
    const name = /^<([a-z][a-z0-9:-]*)/iu.exec(markup)?.[1]?.toLowerCase();
    if (name === undefined) continue;
    // A base can change URLs even for scripts discovered earlier in the document.
    if (name === "base") return [unsupported("base elements are unsupported")];
    if (["svg", "math", "template", "noscript", "plaintext"].includes(name)) {
      return [
        ...scripts.slice(0, MAX_SCRIPTS - 1),
        unsupported("unsupported HTML parsing context"),
      ];
    }
    if (
      [
        "textarea",
        "style",
        "title",
        "xmp",
        "iframe",
        "noembed",
        "noframes",
      ].includes(name)
    ) {
      const end = new RegExp(`</${name}[\\t\\n\\f\\r ]*>`, "giu");
      end.lastIndex = tags.lastIndex;
      const close = end.exec(html);
      if (close === null) break;
      offset = end.lastIndex;
      continue;
    }
    if (name !== "script") continue;
    if (scripts.length === MAX_SCRIPTS) {
      scripts[MAX_SCRIPTS - 1] = unsupported(
        "page exceeds the 16-script limit",
      );
      break;
    }
    const end = /<\/script(?=[\t\n\f\r />])[^>]*>/giu;
    end.lastIndex = tags.lastIndex;
    const close = end.exec(html);
    if (close === null) {
      scripts.push(unsupported("unterminated script element"));
      break;
    }
    if (!/^<\/script[\t\n\f\r ]*>$/iu.test(close[0])) {
      scripts.push(unsupported("ambiguous script closing tag"));
      break;
    }
    const body = html.slice(tags.lastIndex, close.index);
    if (body.includes("<!--") || /<script(?=[\t\n\f\r />])/iu.test(body)) {
      scripts.push(unsupported("ambiguous script raw text"));
      break;
    }
    offset = end.lastIndex;
    const attributes = markup.slice("<script".length, -1);
    const attrs = new Map<string, string>();
    const attribute =
      /[\t\n\f\r ]+([a-z_:][a-z0-9_:.-]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+)))?/iuy;
    let cursor = 0;
    let reason: string | undefined;
    while (
      cursor < attributes.length &&
      !/^[\t\n\f\r ]*$/u.test(attributes.slice(cursor))
    ) {
      attribute.lastIndex = cursor;
      const match = attribute.exec(attributes);
      const key = match?.[1]?.toLowerCase();
      if (match === null || key === undefined || attrs.has(key)) {
        reason = "ambiguous script attributes";
        break;
      }
      attrs.set(key, match[2] ?? match[3] ?? match[4] ?? "");
      cursor = attribute.lastIndex;
    }
    const type =
      attrs
        .get("type")
        ?.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "")
        .toLowerCase() ?? "";
    if (
      !["", "text/javascript", "application/javascript"].includes(type) ||
      attrs.has("language") ||
      attrs.has("nomodule")
    ) {
      reason = "unsupported script type";
    }
    if (attrs.has("async") || attrs.has("defer"))
      reason = "async/defer scripts are unsupported";
    if (attrs.has("src") && body.trim() !== "")
      reason = "external script also has inline content";
    if (
      attrs.has("src") &&
      (attrs.get("src") === "" ||
        /[&\u0000-\u0020]/u.test(attrs.get("src") ?? ""))
    ) {
      reason = "empty or ambiguous script URL";
    }
    sourceBytes += new TextEncoder().encode(body).byteLength;
    if (sourceBytes > MAX_SOURCE_BYTES) {
      scripts.push(
        unsupported("inline discovery exceeds the 64 KiB source limit"),
      );
      break;
    }
    const src = attrs.get("src");
    if (reason !== undefined) scripts.push(unsupported(reason));
    else if (src !== undefined) scripts.push({ _tag: "External", url: src });
    else scripts.push({ _tag: "Inline", source: body });
  }
  return scripts;
};
