// A curated import replaces canonical doctrine wholesale and runs no model
// over it, so the parser is the only thing standing between the document and
// what Arcadia will cite. These tests are about loss: an entry the parser drops
// is a rule nobody knows is missing, and a marker it strips is an enforcement
// level Arcadia will get wrong.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCuratedDoctrine, summarize } from "../src/memory/curated";

const FOUNDATION = readFileSync("doctrine/sfx-doctrine-foundation.md", "utf8");
const foundation = parseCuratedDoctrine(FOUNDATION);

describe("parseCuratedDoctrine", () => {
  it("keeps one entry per numbered statement, and loses none of them", () => {
    const numbered = foundation.filter((e) => e.number > 0).map((e) => e.number);
    const inDocument = [...FOUNDATION.matchAll(/^(\d+)\.\s+/gm)].map((m) => Number(m[1]));
    expect(numbered).toEqual(inDocument);
    expect(new Set(numbered).size).toBe(numbered.length);
  });

  it("reads the document's numbering rather than assuming it is contiguous", () => {
    // A retired statement leaves its number behind rather than renumbering the
    // 150 below it: the numbers are how the document cross-references itself
    // ("see item 10", "Section 14, item 162"), so they are identifiers.
    const numbered = foundation.filter((e) => e.number > 0).map((e) => e.number);
    expect(numbered).toEqual([...numbered].sort((a, b) => a - b));
    expect(numbered.at(-1)).toBe(198);
  });

  it("stores the statement verbatim — a curated document is not paraphrased", () => {
    const legalName = foundation.find((e) => e.number === 1);
    expect(legalName?.text).toBe(
      "The company's legal name is **S-FX.com Small Business Solutions, LLC**. All bids, contracts, insurance certificates, and public filings use the full legal name. **[HARD]**"
    );
  });

  it("carries the heading path so an entry can be traced back to its section", () => {
    const entry = foundation.find((e) => e.number === 54);
    expect(entry?.section).toContain("SECTION 6 — COMMERCIAL POLICY");
    expect(entry?.section.at(-1)).toBe("6.2 Pricing behavior");
  });

  it("attaches the block that belongs to an item rather than orphaning it", () => {
    // The service-name mapping table sits under item 27 and is the substance
    // of that entry — item 27 alone says only that the names differ.
    const naming = foundation.find((e) => e.number === 27);
    expect(naming?.text).toContain("| Homepage card | Service page name |");
    expect(naming?.text).toContain("Advisory & Coaching");
  });

  it("keeps section prose that carries rules of its own", () => {
    // 7.2's preamble is what makes the seven directives [HARD] in persuasion
    // contexts and relaxed in contract language. Dropped, the items beneath it
    // read as absolute.
    const preamble = foundation.find(
      (e) => e.number === 0 && e.section.at(-1) === "7.2 The seven communication directives"
    );
    expect(preamble?.text).toContain("[HARD for persuasion contexts");
    expect(preamble?.markers).toContain("HARD");
  });

  it("keeps the marker legend, which has prose but no numbered items", () => {
    const legend = foundation.find((e) => e.section.at(-1) === "HOW TO READ THIS DOCUMENT");
    expect(legend?.text).toContain("A rule with no exceptions");
  });

  it("drops the front matter and the closing note — both are about the document", () => {
    const text = foundation.map((e) => e.text).join("\n");
    expect(text).not.toContain("Prepared for:");
    expect(text).not.toContain("Compiled for seeding into Arcadia staging");
  });

  it("reads every marker off the statement that carries it", () => {
    expect(foundation.find((e) => e.number === 9)?.markers).toEqual(["HARD"]);
    expect(foundation.find((e) => e.number === 23)?.markers).toEqual(["JUDGMENT"]);
    expect(foundation.find((e) => e.number === 45)?.markers).toEqual(["VERIFY"]);
    expect(foundation.find((e) => e.number === 2)?.markers).toEqual([]);
  });

  it("classifies a rule as an instruction and an open question as a task", () => {
    expect(foundation.find((e) => e.number === 54)?.kind).toBe("instruction"); // [HARD] rate locks
    expect(foundation.find((e) => e.number === 2)?.kind).toBe("fact"); // founded 2006
    expect(foundation.find((e) => e.number === 193)?.kind).toBe("task"); // open question
  });

  it("gives every entry a unique topic key, since the key is a conflict check", () => {
    const keys = foundation.map((e) => e.topicKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => /^[a-z0-9][a-z0-9-]*$/.test(k))).toBe(true);
  });

  it("builds a topic key out of the statement's own subject", () => {
    expect(foundation.find((e) => e.number === 2)?.topicKey).toBe("s-fx-founded-2006");
  });
});

/** Marker counts belong to the statements, never to the note that defines them. */
function statementsWith(entries: typeof foundation, marker: "HARD" | "JUDGMENT" | "VERIFY"): number {
  return entries.filter((e) => e.number > 0 && e.markers.includes(marker)).length;
}

describe("summarize", () => {
  it("counts what a ratifier needs to check before running the import", () => {
    const s = summarize(foundation);
    expect(s.total).toBe(foundation.length);
    expect(s.numbered).toBe(197);
    expect(s.notes).toBeGreaterThan(0);
    expect(s.hard).toBeGreaterThan(40);
    expect(s.hard).toBe(statementsWith(foundation, "HARD"));
    // The document asks that [VERIFY] entries be confirmed; the surface names
    // them by number after an import, so this must not silently reach zero.
    expect(s.verify.map((e) => e.number)).toEqual([42, 43, 45, 104, 189]);
  });
});

describe("parseCuratedDoctrine on hand-built input", () => {
  it("ignores prose under the document title, so front matter never becomes doctrine", () => {
    const entries = parseCuratedDoctrine("# Title\n\nSome metadata about this file.\n\n# S\n\n1. A rule.");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.number).toBe(1);
  });

  it("closes an item at a horizontal rule rather than swallowing the next section", () => {
    const entries = parseCuratedDoctrine("# T\n\n# S\n\n1. A rule.\n\n---\n\n# S2\n\n2. Another.");
    expect(entries.map((e) => e.text)).toEqual(["A rule.", "Another."]);
  });

  it("returns nothing for a document with no statements in it", () => {
    expect(parseCuratedDoctrine("# Title\n\nJust prose.\n")).toEqual([]);
  });

  it("de-collides topic keys when two statements open the same way", () => {
    const entries = parseCuratedDoctrine(
      "# T\n\n# S\n\n1. S-FX is never called an agency.\n2. S-FX is never called a vendor either."
    );
    expect(new Set(entries.map((e) => e.topicKey)).size).toBe(2);
  });
});
