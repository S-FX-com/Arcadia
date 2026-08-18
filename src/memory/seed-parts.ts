// Document cutting for the bulk seed (capture channel C, §5.5).
//
// Deliberately free of Cloudflare imports: this is the part with the sharp
// edges — content loss, mis-ordered parts, a chunk so large it defeats §5.3's
// chunking — and it stays directly unit-testable.

import { breadcrumb, isMarkdown, sectionsOf, splitFrontMatter } from "./markdown";

/**
 * Target size of one extracted message.
 *
 * Tied to the §5.3 chunker, which groups messages up to CHUNK_CHARS (10K) with
 * an OVERLAP_MESSAGES (2) carry-over and only ever splits *between* messages.
 * A chunk therefore holds up to (overlap + 1) messages, so messages must stay
 * near CHUNK_CHARS / 3 or the overlap alone blows the budget: at 8K each, the
 * real chunks came out at 23K — more than double the intended span, which is
 * exactly the condition pass B exists to compensate for. Raising this without
 * raising CHUNK_CHARS silently degrades extraction quality.
 */
export const MESSAGE_CHARS = 3_000;
/** Messages per durable workflow step. Bounds one step at roughly five chunks. */
export const MESSAGES_PER_PART = 5;
/** Refuse absurd inputs loudly rather than burning a long run on a bad paste. */
export const MAX_DOCUMENT_CHARS = 2_000_000;
/**
 * Share of a message the heading path may take. A crumb is context, never the
 * payload: capping it as a fraction of the budget is what keeps a message
 * within maxChars no matter how deeply a document nests its headings.
 */
const CRUMB_SHARE = 3;

export interface SeedPart {
  document: string;
  index: number;
  total: number;
  messages: string[];
}

/**
 * Cut a document into messages at paragraph boundaries. Splitting mid-sentence
 * costs the extractor the context that makes a statement standalone, which is
 * the whole point of §5.3's "still makes sense a year from now".
 */
export function splitIntoMessages(content: string, maxChars = MESSAGE_CHARS): string[] {
  // A budget below one character would make the hard split below never
  // advance. Nothing sane asks for it; a hung Worker is too high a price.
  const limit = Math.max(1, Math.floor(maxChars));
  const paragraphs = content.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const messages: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) messages.push(trimmed);
    current = "";
  };

  for (const paragraph of paragraphs) {
    // A single paragraph over the budget (a long table, a minified block) is
    // hard-split rather than dropped.
    if (paragraph.length > limit) {
      flush();
      for (let i = 0; i < paragraph.length; i += limit) {
        const slice = paragraph.slice(i, i + limit).trim();
        if (slice) messages.push(slice);
      }
      continue;
    }
    if (current.length + paragraph.length + 2 > limit) flush();
    current += (current ? "\n\n" : "") + paragraph;
  }
  flush();
  return messages;
}

/**
 * Cut a markdown document into messages, each stamped with the heading path it
 * came from.
 *
 * The stamp is the point. Extraction reads one message at a time, so a rate
 * under "## Retainers" arrives as a rate about retainers rather than a naked
 * figure, and the verification pass can still check it against the same text.
 * Sections are packed together up to the budget so a document of one-line
 * headings does not become a hundred tiny messages.
 */
export function markdownMessages(document: string, content: string, maxChars = MESSAGE_CHARS): string[] {
  const { fields, body } = splitFrontMatter(content);
  // Front matter is dropped except the title, which is usually the best name
  // the document has for its own subject.
  const root = fields.title && fields.title !== document ? `${document} — ${fields.title}` : document;
  const crumbLimit = Math.max(Math.floor(maxChars / CRUMB_SHARE), 1);

  const blocks: string[] = [];
  for (const section of sectionsOf(body)) {
    const crumb = breadcrumb(root, section.path, crumbLimit);
    const header = crumb ? `[${crumb}]\n` : "";
    for (const piece of splitIntoMessages(section.body, Math.max(maxChars - header.length, 1))) {
      blocks.push(header + piece);
    }
  }

  const messages: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > maxChars) {
      messages.push(current);
      current = "";
    }
    current += (current ? "\n\n" : "") + block;
  }
  if (current) messages.push(current);
  return messages;
}

/** Group messages into parts, one part per durable step. */
export function partsOf(document: string, content: string): SeedPart[] {
  const messages = isMarkdown(document)
    ? markdownMessages(document, content)
    : splitIntoMessages(content);
  const grouped: string[][] = [];
  for (let i = 0; i < messages.length; i += MESSAGES_PER_PART) {
    grouped.push(messages.slice(i, i + MESSAGES_PER_PART));
  }
  return grouped.map((slice, index) => ({
    document,
    index,
    total: grouped.length,
    messages: slice,
  }));
}

/**
 * A document name reduced to one safe R2 key segment. Two documents that
 * reduce to the same segment would overwrite each other's parts, so intake
 * dedupes on this, not on the display name.
 */
export function documentSegment(document: string): string {
  return document.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "document";
}

/** R2 keys sort lexicographically, so the index is zero-padded — part 10 must not come before part 2. */
export function partKey(runPrefix: string, runId: string, document: string, index: number): string {
  return `${runPrefix}/${runId}/${documentSegment(document)}/${String(index).padStart(4, "0")}.json`;
}
