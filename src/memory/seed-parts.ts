// Document cutting for the bulk seed (capture channel C, §5.5).
//
// Deliberately free of Cloudflare imports: this is the part with the sharp
// edges — content loss, mis-ordered parts, a chunk so large it defeats §5.3's
// chunking — and it stays directly unit-testable.

/**
 * Target size of one extracted message. The §5.3 chunker groups messages up to
 * ~10K chars with a 2-message overlap, and it only splits *between* messages —
 * so handing it one giant message would defeat the chunking entirely.
 */
export const MESSAGE_CHARS = 8_000;
/** Messages per durable workflow step. Bounds one step at roughly five chunks. */
export const MESSAGES_PER_PART = 5;
/** Refuse absurd inputs loudly rather than burning a long run on a bad paste. */
export const MAX_DOCUMENT_CHARS = 2_000_000;

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
    if (paragraph.length > maxChars) {
      flush();
      for (let i = 0; i < paragraph.length; i += maxChars) {
        const slice = paragraph.slice(i, i + maxChars).trim();
        if (slice) messages.push(slice);
      }
      continue;
    }
    if (current.length + paragraph.length + 2 > maxChars) flush();
    current += (current ? "\n\n" : "") + paragraph;
  }
  flush();
  return messages;
}

/** Group messages into parts, one part per durable step. */
export function partsOf(document: string, content: string): SeedPart[] {
  const messages = splitIntoMessages(content);
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

/** R2 keys sort lexicographically, so the index is zero-padded — part 10 must not come before part 2. */
export function partKey(runPrefix: string, runId: string, document: string, index: number): string {
  const safe = document.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `${runPrefix}/${runId}/${safe}/${String(index).padStart(4, "0")}.json`;
}
