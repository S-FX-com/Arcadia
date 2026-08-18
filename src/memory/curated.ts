// Curated doctrine import (§5.5 capture channel C, curated variant).
//
// The §5.3 pipeline exists to turn conversation and prose into standalone
// statements: extract, sweep for figures, verify against the source. A curated
// doctrine document has already been through that — by a human, deliberately,
// one numbered statement at a time. Running it through extraction would
// paraphrase Shane's wording back at him, drop the [HARD] markers that carry
// the enforcement level, and invent conflicts between entries that were
// written to sit side by side.
//
// So this path does not use a model at all. It reads the document's own
// structure — numbered items under headings — and each item becomes exactly
// one entry, verbatim. What the author wrote is what gets stored, and what
// gets cited.
//
// Free of Cloudflare imports so the parsing stays directly testable: a curated
// import replaces canonical doctrine wholesale, and an entry silently dropped
// here is a rule Arcadia will not know exists.

import type { MemoryKind } from "./driver";

export type DoctrineMarker = "HARD" | "JUDGMENT" | "VERIFY";

export interface CuratedEntry {
  /** The document's own item number, or 0 for a section note. */
  number: number;
  /** The statement exactly as written, plus any block that belongs to it. */
  text: string;
  /** Heading path, outermost first. */
  section: string[];
  markers: DoctrineMarker[];
  topicKey: string;
  kind: MemoryKind;
}

const ITEM = /^(\d+)\.\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const MARKER = /\[(HARD|JUDGMENT|VERIFY)\b/g;

/**
 * Words that carry no subject. Negations stay in — "never described as an
 * agency" is the whole point of that entry, and a key without the "never"
 * would collide with the entry that says the opposite.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "do", "does", "for", "from",
  "had", "has", "have", "in", "into", "is", "it", "its", "of", "on", "or", "than", "that", "the",
  "their", "them", "then", "there", "they", "this", "to", "was", "were", "when", "which", "who",
  "whom", "will", "with",
]);

/** Strip the markup so a topic key reads as words, not punctuation. */
function plain(text: string): string {
  return text
    .replace(/[\u2019']s\b/g, "")
    .replace(/[\u2019']/g, "")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[(HARD|JUDGMENT|VERIFY)[^\]]*\]/g, " ")
    .replace(/[*_`>|#]/g, " ")
    .replace(/\[|\]/g, " ")
    .replace(/[—–·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A heading without its numbering: "1.3 What S-FX is never called" → the words. */
function headingWords(heading: string): string {
  return plain(heading.replace(/^SECTION\s+\d+\s*[—–-]?\s*/i, "").replace(/^\d+(\.\d+)*\s+/, ""));
}

function markersOf(text: string): DoctrineMarker[] {
  const found = new Set<DoctrineMarker>();
  for (const match of text.matchAll(MARKER)) found.add(match[1] as DoctrineMarker);
  return [...found];
}

function kindOf(text: string, section: string[], markers: DoctrineMarker[]): MemoryKind {
  // An open question is work to be settled, not a fact Arcadia may assert.
  if (section.some((s) => /OPEN QUESTIONS/i.test(s))) return "task";
  if (markers.includes("HARD") || markers.includes("JUDGMENT")) return "instruction";
  if (/^(never|always|do not|don't|use |avoid|request |read |flag |run |replace |confirm |check )/i.test(plain(text))) {
    return "instruction";
  }
  return "fact";
}

/**
 * A topic key is the highest-weighted retrieval channel (§5.4) and the key a
 * conflict check matches on, so it is built from the statement's own subject
 * rather than from its position in the document.
 */
function topicKeyFor(text: string, section: string[], taken: Set<string>): string {
  const words = plain(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));

  let base = words.slice(0, 6).join("-");
  if (!base) base = (headingWords(section[section.length - 1] ?? "note") || "entry").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  base = base.replace(/^-+|-+$/g, "").slice(0, 80) || "entry";

  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/**
 * Parse a curated doctrine document into entries.
 *
 * Structure the parser relies on, all of it visible in the document itself:
 *
 *   - A numbered item (`42. …`) is one entry.
 *   - Unnumbered prose *after* an item belongs to that item — the service-name
 *     table under item 27 is part of item 27, not an orphan.
 *   - Unnumbered prose *before* a section's first item is that section's note,
 *     and becomes its own entry. Those paragraphs carry real rules ("[HARD]
 *     for persuasion contexts"), and dropping them would strand the items
 *     underneath them.
 *   - A horizontal rule ends whatever block is open. It does not discard the
 *     note above it: every section here is separated by one, and a section
 *     whose prose carries rules but no numbered items — the marker legend at
 *     the top — would otherwise vanish silently.
 *   - The document's own title never produces a note, and a note written
 *     entirely in italics is an editorial aside about the document rather
 *     than doctrine, so it is skipped.
 */
export function parseCuratedDoctrine(markdown: string): CuratedEntry[] {
  const lines = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const entries: CuratedEntry[] = [];
  const taken = new Set<string>();

  let path: string[] = [];
  let sawTitle = false;
  /** The item currently collecting trailing lines. */
  let open: { number: number; lines: string[]; section: string[] } | undefined;
  /** Prose seen under the current heading before its first item. */
  let note: string[] = [];
  let noteSection: string[] = [];

  const push = (number: number, body: string, section: string[]) => {
    const text = body.trim();
    if (!text) return;
    const markers = markersOf(text);
    entries.push({
      number,
      text,
      section: [...section],
      markers,
      topicKey: topicKeyFor(text, section, taken),
      kind: kindOf(text, section, markers),
    });
  };

  const closeItem = () => {
    if (open) push(open.number, open.lines.join("\n"), open.section);
    open = undefined;
  };

  const closeNote = () => {
    // Depth 1 is the document title; a note needs a real section above it.
    const text = note.join("\n").trim();
    note = [];
    if (noteSection.length <= 1 || !text) return;
    // "*Compiled for seeding into Arcadia staging…*" is about the document,
    // not about S-FX. An aside is italic end to end; a rule never is.
    if (/^\*[^*]/.test(text) && /[^*]\*$/.test(text) && !text.includes("\n\n")) return;
    push(0, text, noteSection);
  };

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      closeItem();
      closeNote();
      const level = (heading[1] ?? "#").length;
      const title = (heading[2] ?? "").trim();
      if (!sawTitle) {
        sawTitle = true;
        path = [title];
      } else {
        path = [...path.slice(0, level), title];
      }
      noteSection = [...path];
      continue;
    }

    if (RULE.test(line)) {
      closeItem();
      closeNote();
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      closeItem();
      closeNote();
      open = { number: Number(item[1]), lines: [item[2] ?? ""], section: [...path] };
      continue;
    }

    if (open) {
      open.lines.push(line);
      continue;
    }
    if (line.trim() || note.length) note.push(line);
  }

  closeItem();
  closeNote();
  return entries;
}

/**
 * Counts a human reads before running an import, so the numbers are checkable
 * against the document itself.
 *
 * Markers are counted over numbered statements only. The marker legend is a
 * section note that spells out what [HARD] and [VERIFY] mean, so it matches
 * every marker pattern while carrying none of them — counting it would put a
 * phantom entry on the list of things a ratifier has to go confirm.
 */
export function summarize(entries: CuratedEntry[]) {
  const statements = entries.filter((e) => e.number > 0);
  const marker = (m: DoctrineMarker) => statements.filter((e) => e.markers.includes(m));
  return {
    total: entries.length,
    numbered: entries.filter((e) => e.number > 0).length,
    notes: entries.filter((e) => e.number === 0).length,
    hard: marker("HARD").length,
    judgment: marker("JUDGMENT").length,
    verify: marker("VERIFY"),
  };
}
