import { describe, expect, it } from "vitest";
import { parseHtml } from "../../src/ingest/parsers/html";
import { parseOneNote } from "../../src/ingest/parsers/onenote";
import { parsePlain } from "../../src/ingest/parsers/plain";

describe("parsePlain", () => {
  it("normalises whitespace and CRLF", () => {
    const out = parsePlain("a\r\nb\r\n\r\nc");
    expect(out.text).toBe("a\nb\n\nc");
  });
});

describe("parseHtml", () => {
  it("drops script/style/head", () => {
    const out = parseHtml(`
      <html>
        <head><title>X</title><style>.a{}</style></head>
        <body><script>alert(1)</script><p>Hello</p></body>
      </html>
    `);
    expect(out.text).not.toContain("alert");
    expect(out.text).toContain("Hello");
    expect(out.title).toBe("X");
  });

  it("converts <br>/<li> to plain text", () => {
    const out = parseHtml("<p>line1<br>line2</p><ul><li>one</li><li>two</li></ul>");
    expect(out.text).toContain("line1");
    expect(out.text).toContain("line2");
    expect(out.text).toContain("- one");
    expect(out.text).toContain("- two");
  });

  it("decodes the common entity set", () => {
    const out = parseHtml("<p>Tom &amp; Jerry &lt;b&gt;</p>");
    expect(out.text).toBe("Tom & Jerry <b>");
  });

  it("lifts headings into sections", () => {
    const out = parseHtml(
      "<h2>Intro</h2><p>hello</p><h2>Body</h2><p>world</p>",
    );
    expect(out.sections?.length).toBe(2);
    expect(out.sections?.[0]?.heading).toBe("Intro");
    expect(out.sections?.[1]?.text).toContain("world");
  });
});

describe("parseOneNote", () => {
  it("strips data-* attributes before delegating", () => {
    const out = parseOneNote(
      `<p data-id="abc" style="color:red">hello <span data-index="1">world</span></p>`,
    );
    expect(out.text).toContain("hello");
    expect(out.text).toContain("world");
    expect(out.text).not.toContain("data-id");
  });

  it("replaces images with alt text markers", () => {
    const out = parseOneNote('<img src="x" alt="chart of revenue">');
    expect(out.text).toContain("[image: chart of revenue]");
  });
});
