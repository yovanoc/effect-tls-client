/**
 * Parses either a strict body-context HTML fragment or a complete document with
 * explicit doctype/html/head/body roots. Ordinary tags are a, address, article,
 * aside, b, blockquote, code, div, em, footer, header, i, main, p, section,
 * small, span, strong, sub, sup, and u; standard void tags except col are
 * accepted in body content. Non-void tags must be explicitly and properly
 * nested (anchors cannot nest, and p cannot contain a p-closing start tag).
 * Simple comments, quoted/unquoted/boolean attributes, and only the five named
 * references below plus valid decimal/hex numeric references are supported.
 * Script and style are raw text only; script escape syntax is unsupported.
 * No document repair, execution, or loading occurs. Any syntax outside the
 * selected subset rejects the entire snapshot.
 */

/** Code-owned document rejection families; never derived from input operands. */
export const DOCUMENT_INPUT_RULES = [
  "InputEncoding",
  "Doctype",
  "DocumentStructure",
  "HeadContentSubset",
  "CommentSyntax",
  "MarkupSyntax",
  "CharacterReference",
  "TagSyntax",
  "ClosingStructure",
  "ImplicitRepair",
  "AttributeSyntax",
  "SelfClosingNormal",
  "RawTextSubset",
  "TitleRcdataSubset",
  "DocumentElementSubset",
  "TableSubset",
  "SelectSubset",
  "TemplateSubset",
  "ScriptingDependentSubset",
  "ForeignContentSubset",
  "ElementSubset",
  "SnapshotRecordInvariant",
] as const;

export type DocumentInputRule = (typeof DOCUMENT_INPUT_RULES)[number];

interface HtmlSnapshotNode {
  readonly tag: string;
  /** Preorder index of the parent element, or -1 for a fragment child. */
  readonly parent: number;
  readonly attributes: ReadonlyArray<readonly [string, string]>;
  /** Complete DOM-style textContent, including descendant text. */
  readonly textContent: string;
}

interface HtmlSnapshot {
  readonly nodes: ReadonlyArray<HtmlSnapshotNode>;
  /** Fragment text in tree order, or textContent of the document element. */
  readonly textContent: string;
}

type HtmlSnapshotParseResult =
  | { readonly _tag: "Success"; readonly snapshot: HtmlSnapshot }
  | {
      readonly _tag: "Unsupported";
      readonly reason: string;
      readonly rule?: DocumentInputRule;
    }
  | {
      readonly _tag: "LimitExceeded";
      readonly limit:
        | "inputBytes"
        | "elements"
        | "attributesUtf8Bytes"
        | "attributeValueCharacters";
    };

type ParseFailure = Extract<
  HtmlSnapshotParseResult,
  { readonly _tag: "Unsupported" | "LimitExceeded" }
>;

class ParseAbort {
  constructor(readonly result: ParseFailure) {}
}

interface MutableNode {
  readonly tag: string;
  readonly parent: number;
  readonly attributes: Array<[string, string]>;
  readonly textParts: string[];
}

type DocumentPhase =
  | "fragment"
  | "beforeDoctype"
  | "beforeHtml"
  | "beforeHead"
  | "inHead"
  | "afterHead"
  | "inBody"
  | "afterBody"
  | "afterHtml";

const MAX_ELEMENTS = 32;
const MAX_ATTRIBUTE_BYTES = 16 * 1024;
const MAX_ATTRIBUTE_VALUE_CHARACTERS = 8192;
const MAX_INPUT_BYTES = 128 * 1024;

const NORMAL_TAGS = new Set([
  "a",
  "address",
  "article",
  "aside",
  "b",
  "blockquote",
  "code",
  "div",
  "em",
  "footer",
  "header",
  "i",
  "main",
  "p",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
  "script",
  "style",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const PARAGRAPH_CLOSING_START_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "fieldset",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "table",
  "ul",
]);

const NAMED_REFERENCES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);

const isHtmlWhitespace = (character: string | undefined): boolean =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\f" ||
  character === "\r";

const isAsciiLetter = (character: string | undefined): boolean =>
  (character !== undefined && character >= "a" && character <= "z") ||
  (character !== undefined && character >= "A" && character <= "Z");

const isAttributeNameStart = (character: string | undefined): boolean =>
  isAsciiLetter(character) || character === "_" || character === ":";

const isAttributeNameCharacter = (character: string | undefined): boolean =>
  isAttributeNameStart(character) ||
  (character !== undefined && character >= "0" && character <= "9") ||
  character === "." ||
  character === "-";

const isWellFormedInput = (input: string): boolean => {
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (index + 1 >= input.length || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

const normalizedLineEndings = (input: string): string =>
  input.replace(/\r\n?/g, "\n");

const unsupportedTagReason = (
  tag: string,
): readonly [string, DocumentInputRule] => {
  if (tag === "html" || tag === "head" || tag === "body") {
    return [
      `document element <${tag}> semantics are unsupported`,
      "DocumentElementSubset",
    ];
  }
  if (
    tag === "table" ||
    tag === "tbody" ||
    tag === "thead" ||
    tag === "tfoot" ||
    tag === "tr" ||
    tag === "td" ||
    tag === "th" ||
    tag === "caption" ||
    tag === "colgroup"
  ) {
    return [
      `table repair semantics for <${tag}> are unsupported`,
      "TableSubset",
    ];
  }
  if (
    tag === "select" ||
    tag === "option" ||
    tag === "optgroup" ||
    tag === "datalist"
  ) {
    return [`select semantics for <${tag}> are unsupported`, "SelectSubset"];
  }
  if (tag === "template")
    return ["template contents are unsupported", "TemplateSubset"];
  if (tag === "noscript")
    return [
      "scripting-dependent noscript parsing is unsupported",
      "ScriptingDependentSubset",
    ];
  if (tag === "svg" || tag === "math") {
    return [
      `foreign-content semantics for <${tag}> are unsupported`,
      "ForeignContentSubset",
    ];
  }
  if (
    tag === "textarea" ||
    tag === "title" ||
    tag === "iframe" ||
    tag === "noembed" ||
    tag === "noframes" ||
    tag === "xmp" ||
    tag === "plaintext"
  ) {
    return [
      `special text or embedded semantics for <${tag}> are unsupported`,
      "ElementSubset",
    ];
  }
  if (tag === "form" || tag === "button") {
    return [
      `form-control parsing semantics for <${tag}> are unsupported`,
      "ElementSubset",
    ];
  }
  return [
    `element <${tag}> is outside the supported fragment subset`,
    "ElementSubset",
  ];
};

const parseHtml = (
  input: string,
  mode: "fragment" | "document",
): HtmlSnapshotParseResult => {
  if (
    input.length > MAX_INPUT_BYTES ||
    new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES
  ) {
    return { _tag: "LimitExceeded", limit: "inputBytes" };
  }
  if (!isWellFormedInput(input)) {
    return {
      _tag: "Unsupported",
      reason: "NUL or malformed UTF-16 input",
      ...(mode === "document" ? { rule: "InputEncoding" as const } : {}),
    };
  }

  const source = normalizedLineEndings(input);
  const nodes: MutableNode[] = [];
  const stack: number[] = [];
  const allText: string[] = [];
  let cursor = 0;
  let attributeBytes = 0;
  let documentPhase: DocumentPhase =
    mode === "document" ? "beforeDoctype" : "fragment";
  const currentPhase = (): DocumentPhase => documentPhase;

  const abort = (result: ParseFailure): never => {
    throw new ParseAbort(result);
  };
  const reject = (reason: string, rule: DocumentInputRule): never =>
    abort({
      _tag: "Unsupported",
      reason,
      ...(mode === "document" ? { rule } : {}),
    });
  const exceed = (
    limit: Extract<
      HtmlSnapshotParseResult,
      { readonly _tag: "LimitExceeded" }
    >["limit"],
  ): never => abort({ _tag: "LimitExceeded", limit });
  const asciiEqualsAt = (position: number, value: string): boolean => {
    for (let offset = 0; offset < value.length; offset += 1) {
      let code = source.charCodeAt(position + offset);
      if (code >= 0x41 && code <= 0x5a) code += 0x20;
      if (code !== value.charCodeAt(offset)) return false;
    }
    return true;
  };
  const onlyHtmlWhitespace = (value: string): boolean => {
    for (const character of value) {
      if (!isHtmlWhitespace(character)) return false;
    }
    return true;
  };
  const parseDoctype = (): void => {
    if (
      !source.startsWith("<!", cursor) ||
      !asciiEqualsAt(cursor + 2, "doctype")
    ) {
      reject("only the standard <!doctype html> is supported", "Doctype");
    }
    cursor += 9;
    if (!isHtmlWhitespace(source[cursor])) {
      reject(
        "doctype keyword and name must be separated by whitespace",
        "Doctype",
      );
    }
    while (isHtmlWhitespace(source[cursor])) cursor += 1;
    if (!asciiEqualsAt(cursor, "html")) {
      reject("only the standard <!doctype html> is supported", "Doctype");
    }
    cursor += 4;
    if (!isHtmlWhitespace(source[cursor]) && source[cursor] !== ">") {
      reject("legacy doctype identifiers are unsupported", "Doctype");
    }
    while (isHtmlWhitespace(source[cursor])) cursor += 1;
    if (source[cursor] !== ">") {
      reject("legacy doctype identifiers are unsupported", "Doctype");
    }
    cursor += 1;
    documentPhase = "beforeHtml";
  };
  const isSupportedStartTag = (tag: string): boolean => {
    if (mode === "fragment") return VOID_TAGS.has(tag) || NORMAL_TAGS.has(tag);
    switch (currentPhase()) {
      case "beforeHtml":
        return tag === "html";
      case "beforeHead":
        return tag === "head";
      case "inHead":
        return (
          tag === "meta" ||
          tag === "link" ||
          tag === "script" ||
          tag === "style" ||
          tag === "title"
        );
      case "afterHead":
        return tag === "body";
      case "inBody":
        return VOID_TAGS.has(tag) || NORMAL_TAGS.has(tag);
      default:
        return false;
    }
  };
  const appendText = (text: string): void => {
    if (text === "") return;
    allText.push(text);
    if (
      mode === "document" &&
      (currentPhase() === "afterBody" || currentPhase() === "afterHtml")
    ) {
      const html = nodes.find(
        (node) => node.tag === "html" && node.parent === -1,
      );
      const body = nodes.find(
        (node) => node.tag === "body" && node.parent === 0,
      );
      if (html !== undefined) html.textParts.push(text);
      if (body !== undefined) body.textParts.push(text);
      return;
    }
    for (const parent of stack) {
      const node = nodes[parent];
      if (node !== undefined) node.textParts.push(text);
    }
  };

  const decodeReferences = (value: string): string => {
    let decoded = "";
    let start = 0;
    while (start < value.length) {
      if (value[start] !== "&") {
        decoded += value[start];
        start += 1;
        continue;
      }

      let semicolon = start + 1;
      while (semicolon < value.length && value[semicolon] !== ";") {
        semicolon += 1;
      }
      if (semicolon === value.length) {
        reject("character reference without a semicolon", "CharacterReference");
      }

      const reference = value.slice(start + 1, semicolon);
      const named = NAMED_REFERENCES.get(reference);
      if (named !== undefined) {
        decoded += named;
      } else if (reference.startsWith("#")) {
        let digit = 1;
        let radix = 10;
        if (reference[digit] === "x" || reference[digit] === "X") {
          radix = 16;
          digit += 1;
        }
        if (digit === reference.length) {
          reject("invalid numeric character reference", "CharacterReference");
        }
        let codePoint = 0;
        for (; digit < reference.length; digit += 1) {
          const character = reference[digit];
          let valueDigit = -1;
          if (character !== undefined && character >= "0" && character <= "9") {
            valueDigit = character.charCodeAt(0) - 48;
          } else if (
            radix === 16 &&
            character !== undefined &&
            character.toLowerCase() >= "a" &&
            character.toLowerCase() <= "f"
          ) {
            valueDigit = character.toLowerCase().charCodeAt(0) - 87;
          }
          if (valueDigit < 0 || valueDigit >= radix) {
            reject("invalid numeric character reference", "CharacterReference");
          }
          codePoint = codePoint * radix + valueDigit;
          if (codePoint > 0x10ffff) {
            reject(
              "numeric character reference is outside Unicode",
              "CharacterReference",
            );
          }
        }
        if (
          codePoint === 0 ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
          (codePoint < 0x20 &&
            codePoint !== 0x09 &&
            codePoint !== 0x0a &&
            codePoint !== 0x0c &&
            codePoint !== 0x0d) ||
          (codePoint >= 0x7f && codePoint <= 0x9f)
        ) {
          reject(
            "numeric character reference is not supported",
            "CharacterReference",
          );
        }
        decoded += String.fromCodePoint(codePoint);
      } else {
        reject(
          `unknown character reference &${reference};`,
          "CharacterReference",
        );
      }
      start = semicolon + 1;
    }
    return decoded;
  };

  const parseEndTag = (pop = true): string => {
    cursor += 2;
    if (!isAsciiLetter(source[cursor])) reject("invalid end tag", "TagSyntax");
    const nameStart = cursor;
    while (
      cursor < source.length &&
      !isHtmlWhitespace(source[cursor]) &&
      source[cursor] !== ">" &&
      source[cursor] !== "/"
    ) {
      if (!isAsciiLetter(source[cursor])) {
        reject("non-ASCII-letter tag name", "TagSyntax");
      }
      cursor += 1;
    }
    const tag = source.slice(nameStart, cursor).toLowerCase();
    while (isHtmlWhitespace(source[cursor])) cursor += 1;
    if (source[cursor] !== ">")
      reject(`ambiguous closing tag </${tag}>`, "TagSyntax");
    cursor += 1;

    const parent = stack[stack.length - 1];
    if (parent === undefined || nodes[parent]?.tag !== tag) {
      reject(
        `unexpected or mismatched closing tag </${tag}>`,
        "ClosingStructure",
      );
    }
    if (pop) stack.pop();
    return tag;
  };

  const rawTextCloseAt = (position: number, tag: string): boolean => {
    if (source[position] !== "<" || source[position + 1] !== "/") {
      return false;
    }
    for (let offset = 0; offset < tag.length; offset += 1) {
      const character = source[position + 2 + offset];
      if (
        character === undefined ||
        !isAsciiLetter(character) ||
        character.toLowerCase() !== tag[offset]
      ) {
        return false;
      }
    }
    const delimiter = source[position + 2 + tag.length];
    return (
      delimiter === ">" || delimiter === "/" || isHtmlWhitespace(delimiter)
    );
  };

  try {
    while (cursor < source.length) {
      if (source.startsWith("<!--", cursor)) {
        let end = cursor + 4;
        while (
          end + 2 < source.length &&
          !(
            source[end] === "-" &&
            source[end + 1] === "-" &&
            source[end + 2] === ">"
          )
        ) {
          end += 1;
        }
        if (end + 2 >= source.length)
          reject("unterminated comment", "CommentSyntax");
        const comment = source.slice(cursor + 4, end);
        if (comment.startsWith(">") || comment.includes("--")) {
          reject(
            "comment syntax is outside the supported subset",
            "CommentSyntax",
          );
        }
        cursor = end + 3;
        continue;
      }

      if (source[cursor] !== "<") {
        const start = cursor;
        while (cursor < source.length && source[cursor] !== "<") cursor += 1;
        const text = decodeReferences(source.slice(start, cursor));
        if (mode === "document") {
          if (!onlyHtmlWhitespace(text)) {
            if (
              currentPhase() === "beforeDoctype" ||
              currentPhase() === "beforeHtml" ||
              currentPhase() === "beforeHead" ||
              currentPhase() === "inHead"
            ) {
              reject(
                "non-whitespace text would trigger document repair",
                "DocumentStructure",
              );
            }
            if (
              currentPhase() === "afterHead" ||
              currentPhase() === "afterBody" ||
              currentPhase() === "afterHtml"
            ) {
              reject(
                "non-whitespace text outside the body is unsupported",
                "DocumentStructure",
              );
            }
          }
          if (
            currentPhase() === "beforeDoctype" ||
            currentPhase() === "beforeHtml" ||
            currentPhase() === "beforeHead"
          ) {
            continue;
          }
        }
        appendText(text);
        continue;
      }

      if (source.startsWith("</", cursor)) {
        if (mode === "document") {
          if (currentPhase() === "inHead") {
            const tag = parseEndTag();
            if (tag === "head") documentPhase = "afterHead";
          } else if (currentPhase() === "inBody") {
            const tag = parseEndTag();
            if (tag === "body") documentPhase = "afterBody";
          } else if (currentPhase() === "afterBody") {
            if (parseEndTag(false) !== "html") {
              reject("only </html> may follow the body", "DocumentStructure");
            }
            documentPhase = "afterHtml";
          } else {
            reject(
              "unexpected end tag in document structure",
              "DocumentStructure",
            );
          }
        } else {
          parseEndTag();
        }
        continue;
      }
      if (mode === "document" && currentPhase() === "beforeDoctype") {
        parseDoctype();
        continue;
      }
      if (source.startsWith("<!", cursor) || source.startsWith("<?", cursor)) {
        reject(
          "doctype, declaration, and processing-instruction syntax is unsupported",
          "MarkupSyntax",
        );
      }
      if (!isAsciiLetter(source[cursor + 1])) {
        reject("ambiguous markup beginning with '<'", "MarkupSyntax");
      }

      cursor += 1;
      const nameStart = cursor;
      while (
        cursor < source.length &&
        !isHtmlWhitespace(source[cursor]) &&
        source[cursor] !== "/" &&
        source[cursor] !== ">"
      ) {
        if (!isAsciiLetter(source[cursor])) {
          reject("non-ASCII-letter tag name", "TagSyntax");
        }
        cursor += 1;
      }
      const tag = source.slice(nameStart, cursor).toLowerCase();
      const isVoid = VOID_TAGS.has(tag);
      if (!isSupportedStartTag(tag)) {
        if (mode === "fragment" || currentPhase() === "inBody") {
          reject(...unsupportedTagReason(tag));
        }
        reject(
          `unexpected <${tag}> in document structure`,
          currentPhase() === "inHead"
            ? "HeadContentSubset"
            : "DocumentStructure",
        );
      }
      if (
        stack.some((index) => nodes[index]?.tag === "p") &&
        PARAGRAPH_CLOSING_START_TAGS.has(tag)
      ) {
        reject(
          `start tag <${tag}> would implicitly close an open paragraph`,
          "ImplicitRepair",
        );
      }
      if (tag === "a" && stack.some((index) => nodes[index]?.tag === "a")) {
        reject("nested anchors require HTML repair", "ImplicitRepair");
      }

      const attributes: Array<[string, string]> = [];
      const seenAttributes = new Set<string>();
      let selfClosing = false;
      while (true) {
        while (isHtmlWhitespace(source[cursor])) cursor += 1;
        if (source[cursor] === ">") {
          cursor += 1;
          break;
        }
        if (source[cursor] === "/") {
          cursor += 1;
          if (source[cursor] !== ">")
            reject("ambiguous self-closing tag syntax", "TagSyntax");
          cursor += 1;
          selfClosing = true;
          break;
        }
        if (!isAttributeNameStart(source[cursor])) {
          reject(`invalid attribute syntax on <${tag}>`, "AttributeSyntax");
        }

        const attributeStart = cursor;
        cursor += 1;
        while (isAttributeNameCharacter(source[cursor])) cursor += 1;
        const name = source.slice(attributeStart, cursor).toLowerCase();
        while (isHtmlWhitespace(source[cursor])) cursor += 1;

        let rawValue = "";
        if (source[cursor] === "=") {
          cursor += 1;
          while (isHtmlWhitespace(source[cursor])) cursor += 1;
          const quote = source[cursor];
          if (quote === "'" || quote === '"') {
            cursor += 1;
            const valueStart = cursor;
            while (cursor < source.length && source[cursor] !== quote)
              cursor += 1;
            if (cursor === source.length)
              reject(
                `unterminated value for attribute ${name}`,
                "AttributeSyntax",
              );
            rawValue = source.slice(valueStart, cursor);
            cursor += 1;
            if (
              !isHtmlWhitespace(source[cursor]) &&
              source[cursor] !== "/" &&
              source[cursor] !== ">"
            ) {
              reject(
                `missing separator after attribute ${name}`,
                "AttributeSyntax",
              );
            }
          } else if (source[cursor] === ">") {
            rawValue = "";
          } else {
            const valueStart = cursor;
            while (
              cursor < source.length &&
              !isHtmlWhitespace(source[cursor]) &&
              source[cursor] !== ">"
            ) {
              const character = source[cursor];
              if (
                character === '"' ||
                character === "'" ||
                character === "`" ||
                character === "=" ||
                character === "<"
              ) {
                reject(
                  `invalid unquoted value for attribute ${name}`,
                  "AttributeSyntax",
                );
              }
              cursor += 1;
            }
            rawValue = source.slice(valueStart, cursor);
          }
        }

        const value = decodeReferences(rawValue);
        if (value.length > MAX_ATTRIBUTE_VALUE_CHARACTERS) {
          exceed("attributeValueCharacters");
        }
        const nextBytes =
          attributeBytes + utf8ByteLength(name) + utf8ByteLength(value);
        if (nextBytes > MAX_ATTRIBUTE_BYTES) {
          exceed("attributesUtf8Bytes");
        }
        attributeBytes = nextBytes;
        if (!seenAttributes.has(name)) {
          attributes.push([name, value]);
          seenAttributes.add(name);
        }
      }

      if (selfClosing && !isVoid) {
        reject(
          `self-closing syntax for normal element <${tag}> is unsupported`,
          "SelfClosingNormal",
        );
      }
      if (nodes.length >= MAX_ELEMENTS) exceed("elements");

      const parent = stack[stack.length - 1] ?? -1,
        nodeIndex = nodes.length;
      nodes.push({ tag, parent, attributes, textParts: [] });
      if (!isVoid) stack.push(nodeIndex);

      if (mode === "document") {
        if (tag === "html") documentPhase = "beforeHead";
        else if (tag === "head") documentPhase = "inHead";
        else if (tag === "body") documentPhase = "inBody";
      }

      if (tag === "script" || tag === "style") {
        let closing = cursor;
        while (closing < source.length && !rawTextCloseAt(closing, tag)) {
          if (tag === "script" && source.startsWith("<!--", closing)) {
            reject("script escape syntax is unsupported", "RawTextSubset");
          }
          closing += 1;
        }
        if (closing === source.length)
          reject(`unterminated raw-text element <${tag}>`, "RawTextSubset");
        appendText(source.slice(cursor, closing));
        cursor = closing;
        parseEndTag();
      } else if (mode === "document" && tag === "title") {
        let closing = cursor;
        while (closing < source.length && !rawTextCloseAt(closing, "title")) {
          if (source[closing] === "<") {
            reject(
              "literal markup inside title RCDATA is unsupported",
              "TitleRcdataSubset",
            );
          }
          closing += 1;
        }
        if (closing === source.length)
          reject("unterminated title element", "TitleRcdataSubset");
        appendText(decodeReferences(source.slice(cursor, closing)));
        cursor = closing;
        parseEndTag();
      }
    }

    if (mode === "fragment") {
      if (stack.length > 0) {
        reject(
          `unclosed element <${nodes[stack[stack.length - 1] ?? 0]?.tag ?? "?"}>`,
          "ClosingStructure",
        );
      }
    } else if (
      currentPhase() !== "afterHtml" ||
      stack.length !== 1 ||
      nodes[0]?.tag !== "html"
    ) {
      reject("incomplete or repaired HTML document", "DocumentStructure");
    }

    if (mode === "document") {
      const htmlChildren = nodes.filter((node) => node.parent === 0);
      if (
        htmlChildren.length !== 2 ||
        htmlChildren[0]?.tag !== "head" ||
        htmlChildren[1]?.tag !== "body"
      ) {
        reject(
          "document must have exactly one head followed by one body",
          "DocumentStructure",
        );
      }
    }

    return {
      _tag: "Success",
      snapshot: {
        textContent: allText.join(""),
        nodes: nodes.map((node) => ({
          tag: node.tag,
          parent: node.parent,
          attributes: node.attributes.map(
            ([name, value]) => [name, value] as const,
          ),
          textContent: node.textParts.join(""),
        })),
      },
    };
  } catch (error) {
    if (error instanceof ParseAbort) return error.result;
    throw error;
  }
};

/** Parses a strict body-context HTML fragment, rejecting all implicit repair. */
export const parseHtmlSnapshot = (input: string): HtmlSnapshotParseResult =>
  parseHtml(input, "fragment");

/** Parses a complete document with explicit standard doctype, html, head, and body. */
export const parseHtmlDocument = (input: string): HtmlSnapshotParseResult =>
  parseHtml(input, "document");
