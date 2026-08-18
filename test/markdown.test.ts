import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkMessages } from "../src/memory/ingest";
import { breadcrumb, isMarkdown, sectionsOf, splitFrontMatter } from "../src/memory/markdown";
import { markdownMessages, MESSAGE_CHARS, partsOf } from "../src/memory/seed-parts";
import {
  dedupeDocumentNames,
  documentNameOf,
  looksBinary,
  MAX_FILE_BYTES,
  rejectUpload,
} from "../src/memory/upload";

describe("isMarkdown", () => {
  it("recognizes the extensions the uploader accepts, case-insensitively", () => {
    for (const name of ["pricing.md", "PRICING.MD", "notes.markdown", "post.mdx"]) {
      expect(isMarkdown(name), name).toBe(true);
    }
    for (const name of ["notes.txt", "deck.pdf", "md", "readme"]) {
      expect(isMarkdown(name), name).toBe(false);
    }
  });
});

describe("splitFrontMatter", () => {
  it("keeps the title and drops the rest of the plumbing", () => {
    const { fields, body } = splitFrontMatter(
      ['---', 'title: "Pricing history"', "layout: post", "draft: true", "---", "", "Rate locks yes."].join("\n")
    );
    expect(fields.title).toBe("Pricing history");
    expect(fields.layout).toBe("post");
    expect(body.trim()).toBe("Rate locks yes.");
  });

  it("treats an unterminated block as body rather than losing the document", () => {
    const doc = "---\ntitle: half a document\n\nRate locks yes, discounts no.";
    const { fields, body } = splitFrontMatter(doc);
    expect(fields).toEqual({});
    expect(body).toBe(doc);
  });

  it("leaves a document that merely opens with a horizontal rule alone", () => {
    // A leading "---" with no closing delimiter is not front matter.
    const doc = "Retainers are 12 months minimum.\n\n---\n\nDiscounts are never quoted.";
    expect(splitFrontMatter(doc).body).toBe(doc);
  });

  it("does not eat prose sitting between two horizontal rules", () => {
    // The shape is identical to front matter. Reading it as YAML would delete
    // the opening section of the document with nothing to show for it.
    const doc = ["---", "", "Retainers are 12 months minimum.", "", "---", "", "The rest."].join("\n");
    expect(splitFrontMatter(doc).body).toBe(doc);
    expect(splitFrontMatter("---\n---\n\nBody.").body).toBe("---\n---\n\nBody.");
  });
});

describe("sectionsOf", () => {
  it("carries the heading path down to each section", () => {
    const doc = ["# Pricing", "", "The floor.", "", "## Retainers", "", "Twelve months minimum."].join("\n");
    expect(sectionsOf(doc)).toEqual([
      { path: ["Pricing"], body: "The floor." },
      { path: ["Pricing", "Retainers"], body: "Twelve months minimum." },
    ]);
  });

  it("pops back out to the right level on the next heading", () => {
    const doc = ["# A", "", "a", "", "## B", "", "b", "", "# C", "", "c"].join("\n");
    expect(sectionsOf(doc).map((s) => s.path)).toEqual([["A"], ["A", "B"], ["C"]]);
  });

  it("does not read a shell comment inside a code fence as a heading", () => {
    const doc = ["# Setup", "", "```bash", "# create the database", "wrangler d1 create arcadia-ops", "```"].join("\n");
    const sections = sectionsOf(doc);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.path).toEqual(["Setup"]);
    expect(sections[0]?.body).toContain("wrangler d1 create arcadia-ops");
  });

  it("emits no section for a heading with nothing under it", () => {
    expect(sectionsOf("# Empty\n\n## Also empty")).toEqual([]);
  });

  it("keeps prose that appears before the first heading", () => {
    expect(sectionsOf("A preamble.\n\n# Later")).toEqual([{ path: [], body: "A preamble." }]);
  });

  it("loses no body line", () => {
    const doc = readFileSync("CLAUDE.md", "utf8");
    const bodyLines = doc
      .split("\n")
      .filter((line) => line.trim() && !/^ {0,3}#{1,6}\s/.test(line))
      .map((line) => line.trim());
    const seen = sectionsOf(doc)
      .flatMap((s) => s.body.split("\n"))
      .filter((line) => line.trim())
      .map((line) => line.trim());
    // Fenced code can contain "#" lines, which the filter above treats as
    // headings; every other line must survive, in order.
    expect(seen.filter((line) => !line.startsWith("#"))).toEqual(
      bodyLines.filter((line) => !line.startsWith("#"))
    );
  });
});

describe("breadcrumb", () => {
  it("names the document and the headings above the text", () => {
    expect(breadcrumb("pricing.md", ["Pricing", "Retainers"], 200)).toBe("pricing.md › Pricing › Retainers");
  });

  it("drops the outermost headings first — the nearest one names the subject", () => {
    const crumb = breadcrumb("d.md", ["Outer", "Middle", "Inner"], 20);
    expect(crumb).toContain("d.md");
    expect(crumb).toContain("Inner");
    expect(crumb.length).toBeLessThanOrEqual(20);
  });

  it("skips the blanks a heading-level jump leaves behind", () => {
    expect(breadcrumb("d.md", ["A", "", "C"], 200)).toBe("d.md › A › C");
  });
});

describe("markdownMessages", () => {
  it("stamps every message with the heading it came from", () => {
    const doc = ["# Pricing", "", "## Retainers", "", "Twelve months minimum."].join("\n");
    const messages = markdownMessages("pricing.md", doc);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe("[pricing.md › Pricing › Retainers]\nTwelve months minimum.");
  });

  it("repeats the stamp on every piece of a section too long to hold together", () => {
    const doc = ["## Retainers", "", "x".repeat(400), "", "y".repeat(400)].join("\n");
    const messages = markdownMessages("pricing.md", doc, 300);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.startsWith("[pricing.md › Retainers]")).toBe(true);
      expect(message.length).toBeLessThanOrEqual(300);
    }
  });

  it("uses the front-matter title, and never doubles it up with the filename", () => {
    const withTitle = markdownMessages("post.md", "---\ntitle: Blueprint\n---\n\n# Rates\n\nA figure.");
    expect(withTitle[0]).toContain("[post.md — Blueprint › Rates]");
    const sameTitle = markdownMessages("post.md", "---\ntitle: post.md\n---\n\nA figure.");
    expect(sameTitle[0]).toBe("[post.md]\nA figure.");
  });

  it("packs small sections together rather than emitting a message per heading", () => {
    const doc = Array.from({ length: 12 }, (_, i) => `## H${i}\n\nline ${i}`).join("\n\n");
    const messages = markdownMessages("small.md", doc);
    expect(messages).toHaveLength(1);
    for (let i = 0; i < 12; i++) expect(messages[0]).toContain(`line ${i}`);
  });

  it("terminates on a budget too small to hold its own context line", () => {
    // Nothing asks for this; a splitter that never advances hangs the Worker.
    expect(markdownMessages("d.md", `# H\n\n${"x".repeat(50)}`, 5).join("")).toContain("x");
  });

  it("holds the §5.3 chunk budget on a real document", () => {
    const doc = readFileSync("CLAUDE.md", "utf8");
    const messages = markdownMessages("CLAUDE.md", doc);
    expect(Math.max(...messages.map((m) => m.length))).toBeLessThanOrEqual(MESSAGE_CHARS);
    const sizes = chunkMessages(messages.map((content) => ({ role: "user" as const, content }))).map((chunk) =>
      chunk.reduce((n, m) => n + m.content.length, 0)
    );
    expect(Math.max(...sizes)).toBeLessThanOrEqual(10_000);
  });

  it("loses no prose", () => {
    const doc = readFileSync("CLAUDE.md", "utf8");
    const joined = markdownMessages("CLAUDE.md", doc).join("\n");
    for (const line of ["fractional technology department", "@cf/baai/bge-base-en-v1.5", "Draft-first for 60 days."]) {
      expect(joined).toContain(line);
    }
  });
});

describe("partsOf dispatch", () => {
  it("gives a markdown document its heading context and leaves plain text alone", () => {
    const doc = "# Pricing\n\nTwelve months minimum.";
    expect(partsOf("pricing.md", doc)[0]?.messages[0]).toContain("[pricing.md › Pricing]");
    expect(partsOf("pricing.txt", doc)[0]?.messages[0]).toBe(doc);
  });
});

describe("upload rules", () => {
  it("reduces a name that arrived as a path to its filename", () => {
    expect(documentNameOf("doctrine/2026/pricing.md")).toBe("pricing.md");
    expect(documentNameOf("C:\\Users\\shane\\pricing.md")).toBe("pricing.md");
    expect(documentNameOf("  spaced   name.md ")).toBe("spaced name.md");
  });

  it("refuses what the pipeline cannot read, and says why", () => {
    expect(rejectUpload("deck.pdf", 10)).toContain("not a markdown or text file");
    expect(rejectUpload("empty.md", 0)).toBe("empty file");
    expect(rejectUpload("huge.md", MAX_FILE_BYTES + 1)).toContain("the limit is");
    expect(rejectUpload("", 10)).toBe("no filename");
    expect(rejectUpload("pricing.md", 4_000)).toBeUndefined();
    expect(rejectUpload("notes.TXT", 4_000)).toBeUndefined();
  });

  it("catches a binary a correct extension would have let through", () => {
    expect(looksBinary("%PDF-1.7\u0000\u0000 stream")).toBe(true);
    expect(looksBinary("\uFFFD".repeat(50))).toBe(true);
    expect(looksBinary("Rate locks yes, discounts no. — em dash, ✓ tick")).toBe(false);
    expect(looksBinary("")).toBe(false);
  });

  it("de-collides names that reduce to the same R2 key segment", () => {
    // Both sanitize to "pricing_2026.md"; without this the second silently
    // overwrites the first's parts.
    expect(dedupeDocumentNames(["pricing 2026.md", "pricing_2026.md", "pricing 2026.md"])).toEqual([
      "pricing 2026.md",
      "pricing_2026-2.md",
      "pricing 2026-3.md",
    ]);
    expect(dedupeDocumentNames(["a.md", "b.md"])).toEqual(["a.md", "b.md"]);
  });
});
