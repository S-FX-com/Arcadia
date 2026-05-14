// Semantic chunking.
//
// Strategy:
//   1. Split on paragraph boundaries (blank lines).
//   2. Within each paragraph, split on sentence boundaries.
//   3. Greedy-pack sentences into chunks of CHUNK_TARGET_CHARS.
//   4. Carry CHUNK_OVERLAP_CHARS from the tail of chunk N into the
//      head of chunk N+1 so retrieval doesn't miss content split
//      across a boundary.
//
// Chunk size matches the embedding model's effective context window
// (768-dim BGE base ≈ 512 tokens ≈ ~1.8k chars works well).

import type { Chunk } from "./types";

const CHUNK_TARGET_CHARS = 1500;
const CHUNK_MAX_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 200;
const MIN_CHUNK_CHARS = 80;

export function chunk(text: string): Chunk[] {
  const cleaned = normalise(text);
  if (cleaned.length === 0) return [];

  const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const p of paragraphs) {
    for (const s of splitSentences(p)) {
      sentences.push(s);
    }
    sentences.push("\n");
  }

  const chunks: string[] = [];
  let buffer = "";

  for (const s of sentences) {
    if (s === "\n") {
      if (buffer.trim().length >= CHUNK_TARGET_CHARS) {
        chunks.push(buffer.trim());
        buffer = tailFor(buffer);
      } else if (buffer.length > 0) {
        buffer += "\n\n";
      }
      continue;
    }
    if (buffer.length + s.length + 1 > CHUNK_MAX_CHARS) {
      if (buffer.trim().length >= MIN_CHUNK_CHARS) {
        chunks.push(buffer.trim());
        buffer = tailFor(buffer) + s + " ";
      } else {
        // Single oversized sentence — hard-split.
        for (const piece of hardSplit(s, CHUNK_MAX_CHARS)) {
          chunks.push(piece);
        }
        buffer = "";
      }
      continue;
    }
    buffer += s + " ";
  }

  if (buffer.trim().length >= MIN_CHUNK_CHARS) {
    chunks.push(buffer.trim());
  } else if (buffer.trim().length > 0 && chunks.length === 0) {
    chunks.push(buffer.trim());
  }

  return chunks.map((text, ordinal) => ({ ordinal, text }));
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSentences(paragraph: string): string[] {
  // Conservative — splits on .!?  followed by whitespace + uppercase.
  // Preserves abbreviations imperfectly but well enough for ingest.
  const out: string[] = [];
  const re = /([.!?])\s+(?=[A-Z(])/g;
  let last = 0;
  for (const m of paragraph.matchAll(re)) {
    const end = (m.index ?? 0) + 1;
    out.push(paragraph.slice(last, end).trim());
    last = end;
  }
  const tail = paragraph.slice(last).trim();
  if (tail) out.push(tail);
  return out;
}

function tailFor(buffer: string): string {
  const trimmed = buffer.trimEnd();
  if (trimmed.length <= CHUNK_OVERLAP_CHARS) return trimmed + " ";
  return trimmed.slice(-CHUNK_OVERLAP_CHARS) + " ";
}

function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size).trim());
  }
  return out;
}
