import { describe, expect, it } from "vitest";
import { parseHtmlSnapshot } from "../src/browser/HtmlSnapshot.js";

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
    if (result._tag === "Unsupported") expect(result.reason).toBeTruthy();
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
