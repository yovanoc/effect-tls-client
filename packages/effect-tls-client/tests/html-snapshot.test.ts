import { describe, expect, it } from "vitest";
import {
  parseHtmlDocument,
  parseHtmlSnapshot,
} from "../src/browser/HtmlSnapshot.js";

describe("parseHtmlSnapshot", () => {
  it("preserves element identity, parentage, order, and complete textContent", () => {
    const result = parseHtmlSnapshot(
      'before<div ID="root">A<span>nested</span> tail</div><p>last</p>after',
    );

    expect(result).toEqual({
      _tag: "Success",
      snapshot: {
        textContent: "beforeAnested taillastafter",
        nodes: [
          {
            tag: "div",
            parent: -1,
            attributes: [["id", "root"]],
            textContent: "Anested tail",
          },
          {
            tag: "span",
            parent: 0,
            attributes: [],
            textContent: "nested",
          },
          {
            tag: "p",
            parent: -1,
            attributes: [],
            textContent: "last",
          },
        ],
      },
    });
  });

  it("parses quoted, unquoted, boolean, duplicate, and entity-bearing attributes", () => {
    const result = parseHtmlSnapshot(
      '<DIV title="one &amp; two" DATA-X=\'&lt;tag&gt;\' disabled count=12 TITLE="ignored"></DIV>',
    );

    expect(result).toMatchObject({
      _tag: "Success",
      snapshot: {
        nodes: [
          {
            tag: "div",
            attributes: [
              ["title", "one & two"],
              ["data-x", "<tag>"],
              ["disabled", ""],
              ["count", "12"],
            ],
          },
        ],
      },
    });
  });

  it("decodes the exact supported entity subset in text and attributes", () => {
    const result = parseHtmlSnapshot(
      '<span title="&apos;&quot;">&lt; &gt; &amp; &#65; &#x1F642;</span>',
    );

    expect(result).toMatchObject({
      _tag: "Success",
      snapshot: {
        textContent: "< > & A 🙂",
        nodes: [
          {
            attributes: [["title", "'\""]],
            textContent: "< > & A 🙂",
          },
        ],
      },
    });
  });

  it("keeps comments out of textContent and script/style contents inert and literal", () => {
    const result = parseHtmlSnapshot(
      'a<!-- ignored --><script>if (a < b) "&amp;";</script><style>.x { color: red }</style>z',
    );

    expect(result).toMatchObject({
      _tag: "Success",
      snapshot: {
        textContent: 'aif (a < b) "&amp;";.x { color: red }z',
        nodes: [
          { tag: "script", textContent: 'if (a < b) "&amp;";' },
          { tag: "style", textContent: ".x { color: red }" },
        ],
      },
    });
  });

  it("accepts supported body-context void tags without inventing closing nodes", () => {
    const tags = [
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
    ];
    const result = parseHtmlSnapshot(
      tags.map((tag) => `<${tag}>`).join("") + "<br/>",
    );

    expect(result).toMatchObject({
      _tag: "Success",
      snapshot: {
        nodes: [
          ...tags.map((tag) => ({ tag, parent: -1, attributes: [] })),
          { tag: "br", parent: -1, attributes: [] },
        ],
      },
    });
  });

  it("accepts ASCII uppercase tag names and raw-text closing tags", () => {
    expect(
      parseHtmlSnapshot(
        "<BLOCKQUOTE>x</BLOCKQUOTE><LINK><TRACK><SCRIPT>x</SCRIPT><STYLE>y</STYLE>",
      ),
    ).toMatchObject({
      _tag: "Success",
      snapshot: {
        textContent: "xxy",
        nodes: [
          { tag: "blockquote", textContent: "x" },
          { tag: "link", textContent: "" },
          { tag: "track", textContent: "" },
          { tag: "script", textContent: "x" },
          { tag: "style", textContent: "y" },
        ],
      },
    });
  });

  it("normalizes HTML line endings", () => {
    const result = parseHtmlSnapshot("<div>a\r\nb\rc</div>");
    expect(result).toMatchObject({
      _tag: "Success",
      snapshot: { textContent: "a\nb\nc", nodes: [{ textContent: "a\nb\nc" }] },
    });
  });

  it.each([
    ["document element semantics", "<html><body></body></html>"],
    ["head semantics", "<head></head>"],
    ["body semantics", "<body></body>"],
    ["doctype syntax", "<!doctype html><div></div>"],
    ["table repair", "<table><tr><td>x</td></tr></table>"],
    ["ignored body-context col", "<col>"],
    [
      "double-escaped script data",
      "<script><!--<script></script>x<script></script>",
    ],
    ["escaped script data", "<script><!--x--></script>"],
    ["Unicode-folded blockquote name", "<bloc\u212Aquote>x</bloc\u212Aquote>"],
    ["Unicode-folded end tag", "<blockquote>x</bloc\u212Aquote>"],
    ["Unicode-folded link name", "<lin\u212A>"],
    ["Unicode-folded track name", "<trac\u212A>"],
    ["select semantics", "<select><option>x</option></select>"],
    ["template semantics", "<template><div></div></template>"],
    ["noscript semantics", "<noscript>text</noscript>"],
    ["foreign content", "<svg><circle></circle></svg>"],
    ["unknown elements", "<custom-widget></custom-widget>"],
    ["unrecognized raw-text elements", "<textarea>x</textarea>"],
    ["HTML implied closing", "<p>one<p>two</p>"],
    ["paragraph block repair", "<p><div>x</div></p>"],
    ["misnested adoption-agency markup", "<div><span></div></span>"],
    ["nested anchor repair", "<a><a>x</a></a>"],
    ["missing explicit end tag", "<div><span>x</span>"],
    ["self-closing normal elements", "<div/>"],
    ["end tags for void elements", "<br></br>"],
    ["ambiguous less-than syntax", "text < 4"],
    ["malformed attributes", "<div title='unterminated></div>"],
    ["unterminated comment", "<!-- unfinished"],
    ["invalid comment syntax", "<!--a--b-->"],
    ["unknown named entity", "<p>&copy;</p>"],
    ["inherited object property entity", "<p>&toString;</p>"],
    ["bare ampersand", "<p>fish & chips</p>"],
    ["entity without semicolon", "<p>&amp</p>"],
    ["empty numeric entity", "<p>&#x;</p>"],
    ["zero numeric entity", "<p>&#0;</p>"],
    ["out-of-range numeric entity", "<p>&#x110000;</p>"],
    ["NUL input", "\u0000"],
    ["unpaired high surrogate", "\ud800"],
  ])("rejects %s rather than repairing or truncating it", (_case, html) => {
    const result = parseHtmlSnapshot(html);
    expect(result._tag).toBe("Unsupported");
    if (result._tag === "Unsupported") {
      expect(result.reason).toBeTruthy();
      expect(Object.keys(result)).toEqual(["_tag", "reason"]);
    }
  });

  it("accepts the element budget and reports element and per-attribute overflow", () => {
    expect(parseHtmlSnapshot("<div></div>".repeat(32))._tag).toBe("Success");
    expect(parseHtmlSnapshot("<div></div>".repeat(33))).toEqual({
      _tag: "LimitExceeded",
      limit: "elements",
    });
    expect(parseHtmlSnapshot(`<div a="${"x".repeat(8193)}"></div>`)).toEqual({
      _tag: "LimitExceeded",
      limit: "attributeValueCharacters",
    });
  });

  it("budgets total retained attributes by UTF-8 bytes", () => {
    expect(parseHtmlSnapshot(`<div a="x${"é".repeat(8191)}"></div>`)._tag).toBe(
      "Success",
    );
    expect(parseHtmlSnapshot(`<div a="${"é".repeat(8192)}"></div>`)).toEqual({
      _tag: "LimitExceeded",
      limit: "attributesUtf8Bytes",
    });
  });

  it("checks the complete input against the UTF-8 byte limit before parsing", () => {
    expect(parseHtmlSnapshot("é".repeat(65_536))._tag).toBe("Success");
    expect(parseHtmlSnapshot("<".repeat(131_073))).toEqual({
      _tag: "LimitExceeded",
      limit: "inputBytes",
    });
  });
});

describe("parseHtmlDocument", () => {
  it("preserves document roots, attributes, parentage, preorder, and textContent", () => {
    expect(
      parseHtmlDocument(
        '<!DoCtYpE hTmL><HTML LANG="en"><HEAD data-head=x><meta charset=utf-8><link rel=icon><title>Hi &amp; &#x1F642;</title><script>if (a < b) "&amp;";</script><style>h1 { color: red }</style></HEAD><BODY class=main>Hi <strong>there</strong>!</BODY></HTML>',
      ),
    ).toEqual({
      _tag: "Success",
      snapshot: {
        textContent: 'Hi & 🙂if (a < b) "&amp;";h1 { color: red }Hi there!',
        nodes: [
          {
            tag: "html",
            parent: -1,
            attributes: [["lang", "en"]],
            textContent: 'Hi & 🙂if (a < b) "&amp;";h1 { color: red }Hi there!',
          },
          {
            tag: "head",
            parent: 0,
            attributes: [["data-head", "x"]],
            textContent: 'Hi & 🙂if (a < b) "&amp;";h1 { color: red }',
          },
          {
            tag: "meta",
            parent: 1,
            attributes: [["charset", "utf-8"]],
            textContent: "",
          },
          {
            tag: "link",
            parent: 1,
            attributes: [["rel", "icon"]],
            textContent: "",
          },
          {
            tag: "title",
            parent: 1,
            attributes: [],
            textContent: "Hi & 🙂",
          },
          {
            tag: "script",
            parent: 1,
            attributes: [],
            textContent: 'if (a < b) "&amp;";',
          },
          {
            tag: "style",
            parent: 1,
            attributes: [],
            textContent: "h1 { color: red }",
          },
          {
            tag: "body",
            parent: 0,
            attributes: [["class", "main"]],
            textContent: "Hi there!",
          },
          {
            tag: "strong",
            parent: 7,
            attributes: [],
            textContent: "there",
          },
        ],
      },
    });
  });

  it("places whitespace according to document insertion mode and ignores comments", () => {
    const result = parseHtmlDocument(
      " \n<!--before doctype--> <!doctype html>\n<!--before html--> \n<html> \n<!--before head--><head>\n<title>x</title>\n</head> \n<!--between head and body--><body>y</body> \t</html>\r\n",
    );

    expect(result).toMatchObject({
      _tag: "Success",
      snapshot: {
        textContent: "\nx\n \ny \t\n",
        nodes: [
          { tag: "html", parent: -1, textContent: "\nx\n \ny \t\n" },
          { tag: "head", parent: 0, textContent: "\nx\n" },
          { tag: "title", parent: 1, textContent: "x" },
          { tag: "body", parent: 0, textContent: "y \t\n" },
        ],
      },
    });
  });

  it("reprocesses post-body and post-html whitespace in body", () => {
    expect(
      parseHtmlDocument(
        "<!doctype html><html><head></head><body>y</body>\n</html>\n",
      ),
    ).toEqual({
      _tag: "Success",
      snapshot: {
        textContent: "y\n\n",
        nodes: [
          {
            tag: "html",
            parent: -1,
            attributes: [],
            textContent: "y\n\n",
          },
          { tag: "head", parent: 0, attributes: [], textContent: "" },
          { tag: "body", parent: 0, attributes: [], textContent: "y\n\n" },
        ],
      },
    });
  });

  it("reprocesses CRLF whitespace and ignores comments after body and html", () => {
    expect(
      parseHtmlDocument(
        "<!doctype html><html><head></head><body>y</body>\r\n<!-- body -->\t</html>\r\n<!-- html -->\r\n",
      ),
    ).toEqual({
      _tag: "Success",
      snapshot: {
        textContent: "y\n\t\n\n",
        nodes: [
          {
            tag: "html",
            parent: -1,
            attributes: [],
            textContent: "y\n\t\n\n",
          },
          { tag: "head", parent: 0, attributes: [], textContent: "" },
          {
            tag: "body",
            parent: 0,
            attributes: [],
            textContent: "y\n\t\n\n",
          },
        ],
      },
    });
  });

  it.each([
    ["missing doctype", "<html><head></head><body></body></html>"],
    [
      "legacy doctype",
      '<!doctype html PUBLIC "legacy"><html><head></head><body></body></html>',
    ],
    [
      "leading BOM",
      "\uFEFF<!doctype html><html><head></head><body></body></html>",
    ],
    ["missing html root", "<!doctype html><head></head><body></body>"],
    ["missing head root", "<!doctype html><html><body></body></html>"],
    ["missing body root", "<!doctype html><html><head></head></html>"],
    [
      "duplicate body",
      "<!doctype html><html><head></head><body></body><body></body></html>",
    ],
    [
      "duplicate head",
      "<!doctype html><html><head></head><head></head><body></body></html>",
    ],
    [
      "base in head",
      "<!doctype html><html><head><base href=/></head><body></body></html>",
    ],
    [
      "unsupported head element",
      "<!doctype html><html><head><div></div></head><body></body></html>",
    ],
    [
      "head text implying repair",
      "<!doctype html><html><head>metadata</head><body></body></html>",
    ],
    [
      "body before head close",
      "<!doctype html><html><head><body></body></head></html>",
    ],
    [
      "after-body content",
      "<!doctype html><html><head></head><body></body><p>tail</p></html>",
    ],
    [
      "after-html content",
      "<!doctype html><html><head></head><body></body></html>tail",
    ],
    [
      "literal title markup",
      "<!doctype html><html><head><title>a <b>x</b></title></head><body></body></html>",
    ],
    [
      "body table repair",
      "<!doctype html><html><head></head><body><table><tr><td>x</td></tr></table></body></html>",
    ],
    [
      "body foreign content",
      "<!doctype html><html><head></head><body><svg></svg></body></html>",
    ],
    [
      "body form semantics",
      "<!doctype html><html><head></head><body><form></form></body></html>",
    ],
    [
      "script escape syntax",
      "<!doctype html><html><head><script><!--x--></script></head><body></body></html>",
    ],
  ])(
    "rejects %s without repairing or returning a partial document",
    (_case, html) => {
      const result = parseHtmlDocument(html);
      expect(result._tag).toBe("Unsupported");
      if (result._tag === "Unsupported") {
        expect(result.reason).toBeTruthy();
        expect(result.rule).toBeDefined();
      }
    },
  );

  it("counts structural roots toward the element limit", () => {
    const prefix = "<!doctype html><html><head></head><body>";
    const suffix = "</body></html>";
    expect(
      parseHtmlDocument(`${prefix}${"<br>".repeat(29)}${suffix}`)._tag,
    ).toBe("Success");
    expect(parseHtmlDocument(`${prefix}${"<br>".repeat(30)}${suffix}`)).toEqual(
      {
        _tag: "LimitExceeded",
        limit: "elements",
      },
    );
  });

  it("shares per-value, aggregate-attribute, and complete-input limits", () => {
    expect(
      parseHtmlDocument(
        `<!doctype html><html a="${"x".repeat(8193)}"><head></head><body></body></html>`,
      ),
    ).toEqual({ _tag: "LimitExceeded", limit: "attributeValueCharacters" });
    expect(
      parseHtmlDocument(
        `<!doctype html><html a="${"é".repeat(4096)}"><head b="${"é".repeat(4096)}"></head><body></body></html>`,
      ),
    ).toEqual({ _tag: "LimitExceeded", limit: "attributesUtf8Bytes" });

    const prefix = "<!doctype html><html><head></head><body>";
    const suffix = "</body></html>";
    const text = "x".repeat(131_072 - prefix.length - suffix.length);
    expect(parseHtmlDocument(`${prefix}${text}${suffix}`)._tag).toBe("Success");
    expect(parseHtmlDocument(`${prefix}${text}x${suffix}`)).toEqual({
      _tag: "LimitExceeded",
      limit: "inputBytes",
    });
  });
});

describe("document-only rejection families", () => {
  const wrap = (body: string) =>
    "<!doctype html><html><head></head><body>" + body + "</body></html>";
  it.each([
    ["InputEncoding", wrap("\u0000")],
    ["Doctype", "<html><head></head><body></body></html>"],
    ["DocumentStructure", "<!doctype html><head></head><body></body>"],
    [
      "HeadContentSubset",
      "<!doctype html><html><head><table></table></head><body></body></html>",
    ],
    ["CommentSyntax", wrap("<!--unfinished")],
    ["MarkupSyntax", wrap("<?instruction>")],
    ["CharacterReference", wrap("&copy;")],
    ["TagSyntax", wrap("<custom-widget></custom-widget>")],
    ["ClosingStructure", wrap("<div></span>")],
    ["ImplicitRepair", wrap("<p><div></div></p>")],
    ["AttributeSyntax", wrap('<div a="x"b="y"></div>')],
    ["SelfClosingNormal", wrap("<div/>")],
    ["RawTextSubset", wrap("<script><!--x--></script>")],
    [
      "TitleRcdataSubset",
      "<!doctype html><html><head><title><b>x</b></title></head><body></body></html>",
    ],
    ["DocumentElementSubset", wrap("<html></html>")],
    ["TableSubset", wrap("<table></table>")],
    ["SelectSubset", wrap("<select></select>")],
    ["TemplateSubset", wrap("<template></template>")],
    ["ForeignContentSubset", wrap("<svg></svg>")],
    ["ElementSubset", wrap("<form></form>")],
  ])("labels %s without accepting or repairing the document", (rule, input) => {
    const result = parseHtmlDocument(input);
    expect(result).toMatchObject({ _tag: "Unsupported", rule });
    expect(Object.keys(result)).toEqual(["_tag", "reason", "rule"]);
  });
  it("keeps the first rejection and exact fragment shapes", () => {
    expect(parseHtmlDocument(wrap("&copy;<table>"))).toMatchObject({
      _tag: "Unsupported",
      rule: "CharacterReference",
    });
    expect(parseHtmlSnapshot("<div/>")).toEqual({
      _tag: "Unsupported",
      reason: "self-closing syntax for normal element <div> is unsupported",
    });
    expect(parseHtmlSnapshot("")).toEqual({
      _tag: "Success",
      snapshot: { nodes: [], textContent: "" },
    });
    expect(parseHtmlSnapshot("x".repeat(131073))).toEqual({
      _tag: "LimitExceeded",
      limit: "inputBytes",
    });
  });
});

describe("document body noscript RAWTEXT", () => {
  const wrap = (body: string) =>
    "<!doctype html><html><head></head><body>" + body + "</body></html>";
  it.each([false, true])(
    "retains literal text and preorder under an ordinary parent: %s",
    (nested) => {
      const raw = '<div id="raw">&amp;<script>authored()</script>';
      const markup =
        '<noscript ID="fallback" CLASS="fixture">' + raw + "</noscript>";
      const result = parseHtmlDocument(
        wrap(nested ? "<div>before" + markup + "after</div>" : markup),
      );
      const text = nested ? "before" + raw + "after" : raw;
      expect(result).toEqual({
        _tag: "Success",
        snapshot: {
          textContent: text,
          nodes: [
            { tag: "html", parent: -1, attributes: [], textContent: text },
            { tag: "head", parent: 0, attributes: [], textContent: "" },
            { tag: "body", parent: 0, attributes: [], textContent: text },
            ...(nested
              ? [{ tag: "div", parent: 2, attributes: [], textContent: text }]
              : []),
            {
              tag: "noscript",
              parent: nested ? 3 : 2,
              attributes: [
                ["id", "fallback"],
                ["class", "fixture"],
              ],
              textContent: raw,
            },
          ],
        },
      });
    },
  );
  it.each([
    ["", ""],
    ["a\r\nb\rc", "a\nb\nc"],
    [
      "</noscriptx>&unknown;<!--<script><!--x--></script>--><!declaration><?instruction>",
      "</noscriptx>&unknown;<!--<script><!--x--></script>--><!declaration><?instruction>",
    ],
  ])("keeps all RAWTEXT %j", (raw, text) => {
    const result = parseHtmlDocument(
      wrap("<NoScRiPt>" + raw + "</NoScRiPt \t>"),
    );
    expect(result).toMatchObject({
      _tag: "Success",
      snapshot: {
        textContent: text,
        nodes: [
          { textContent: text },
          {},
          { textContent: text },
          { tag: "noscript", textContent: text },
        ],
      },
    });
    if (result._tag === "Success")
      expect(result.snapshot.nodes).toHaveLength(4);
  });
  it.each([
    ["<noscript>x", "RawTextSubset"],
    ["<noscript>x</noscript", "RawTextSubset"],
    ["<noscript>x</noscript/>", "TagSyntax"],
    ["<noscript>x</noscript attr>", "TagSyntax"],
    ["<noscript>x</noscript/>later</noscript>", "TagSyntax"],
    ["<noscript>x</noscript ", "TagSyntax"],
    ["<noscript/>", "SelfClosingNormal"],
  ])("rejects unrepaired %s", (body, rule) => {
    expect(parseHtmlDocument(wrap(body))).toMatchObject({
      _tag: "Unsupported",
      rule,
    });
  });
  it("keeps head, fragment and first-failure contracts unchanged", () => {
    expect(
      parseHtmlDocument(
        "<!doctype html><html><head><noscript>x</noscript></head><body></body></html>",
      ),
    ).toEqual({
      _tag: "Unsupported",
      reason: "unexpected <noscript> in document structure",
      rule: "HeadContentSubset",
    });
    expect(parseHtmlSnapshot("<noscript>x</noscript>")).toEqual({
      _tag: "Unsupported",
      reason: "scripting-dependent noscript parsing is unsupported",
    });
    expect(
      parseHtmlDocument(wrap("<noscript>&unknown;</noscript><table><form>")),
    ).toMatchObject({ _tag: "Unsupported", rule: "TableSubset" });
    expect(
      parseHtmlDocument(wrap("&unknown;<noscript></noscript>")),
    ).toMatchObject({ _tag: "Unsupported", rule: "CharacterReference" });
  });
  it("preserves all quotas without charging parsed text as mutable text", () => {
    expect(
      parseHtmlDocument(wrap("<noscript></noscript>" + "<br>".repeat(28)))._tag,
    ).toBe("Success");
    expect(
      parseHtmlDocument(wrap("<noscript></noscript>" + "<br>".repeat(29))),
    ).toEqual({ _tag: "LimitExceeded", limit: "elements" });
    expect(
      parseHtmlDocument(
        wrap('<noscript a="' + "x".repeat(8192) + '"></noscript>'),
      )._tag,
    ).toBe("Success");
    expect(
      parseHtmlDocument(
        wrap('<noscript a="' + "x".repeat(8193) + '"></noscript>'),
      ),
    ).toEqual({ _tag: "LimitExceeded", limit: "attributeValueCharacters" });
    expect(
      parseHtmlDocument(
        wrap('<noscript a="x' + "é".repeat(8191) + '"></noscript>'),
      )._tag,
    ).toBe("Success");
    expect(
      parseHtmlDocument(
        wrap('<noscript a="' + "é".repeat(8192) + '"></noscript>'),
      ),
    ).toEqual({ _tag: "LimitExceeded", limit: "attributesUtf8Bytes" });
    const raw = "x".repeat(131072 - wrap("<noscript></noscript>").length);
    expect(
      parseHtmlDocument(wrap("<noscript>" + raw + "</noscript>"))._tag,
    ).toBe("Success");
    expect(
      parseHtmlDocument(wrap("<noscript>" + raw + "x</noscript>")),
    ).toEqual({ _tag: "LimitExceeded", limit: "inputBytes" });
    for (const raw of ["\0", "\ud800"])
      expect(
        parseHtmlDocument(wrap("<noscript>" + raw + "</noscript>")),
      ).toMatchObject({ _tag: "Unsupported", rule: "InputEncoding" });
  });
});
