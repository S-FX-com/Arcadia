// Ingestion pipeline (§5.3). The order matters:
//
//   capture
//     → content-addressed ID (idempotent)
//     → extraction pass A: full chunk, ~10K chars, 2-message overlap
//     → extraction pass B: detail sweep for concrete values   [MANDATORY]
//     → verification against source transcript
//     → classify: fact | event | instruction | task + topic key
//     → dedupe: vector similarity within profile
//     → conflict check on matching topic key
//         project/person → supersede, keep version chain
//         doctrine       → HALT. Surface both. Human chooses.
//     → write (INSERT OR IGNORE)
//     → background vectorize via Queue
//
// Pass B is mandatory. S-FX doctrine is dense with specific figures — dates,
// rates, term lengths, client counts — and broad extraction reliably loses
// exactly those.

import { ModelRouter, parseJsonBlock } from "../ai/router";
import type { MemoryKind, Message } from "./driver";

export interface Candidate {
  content: string;
  kind: MemoryKind;
  topicKey: string;
  /** Which pass produced it — pass B candidates are the concrete figures. */
  pass: "A" | "B";
  /** Set false by the verification pass when the source doesn't support it. */
  verified?: boolean;
}

const CHUNK_CHARS = 10_000;
const OVERLAP_MESSAGES = 2;

/** Chunk a transcript at ~10K chars with a 2-message overlap. */
export function chunkMessages(messages: Message[]): Message[][] {
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let size = 0;
  for (const message of messages) {
    if (size + message.content.length > CHUNK_CHARS && current.length > 0) {
      chunks.push(current);
      current = current.slice(-OVERLAP_MESSAGES);
      size = current.reduce((n, m) => n + m.content.length, 0);
    }
    current.push(message);
    size += message.content.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function transcriptOf(messages: Message[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

const KINDS: MemoryKind[] = ["fact", "event", "instruction", "task"];

function normalizeCandidate(raw: {
  content?: string;
  kind?: string;
  topicKey?: string;
}, pass: "A" | "B"): Candidate | undefined {
  const content = (raw.content ?? "").trim();
  if (content.length < 8) return undefined;
  const kind = KINDS.includes(raw.kind as MemoryKind) ? (raw.kind as MemoryKind) : "fact";
  const topicKey = (raw.topicKey ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join("-");
  if (!topicKey) return undefined;
  return { content, kind, topicKey, pass };
}

const CANDIDATE_SCHEMA = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          kind: { type: "string", enum: KINDS },
          topicKey: { type: "string" },
        },
        required: ["content", "kind", "topicKey"],
      },
    },
  },
  required: ["memories"],
};

/** Pass A — broad extraction over the whole chunk. */
export async function extractPassA(ai: ModelRouter, chunk: Message[]): Promise<Candidate[]> {
  const raw = await ai.text("extraction", {
    system: `Extract durable, reusable knowledge from this transcript. One memory per distinct point, written as a standalone declarative statement that will still make sense a year from now with no surrounding context.

Classify each: "fact" (how things are), "event" (something that happened), "instruction" (a rule or directive to follow), "task" (work to be done).
Give each a short normalized topicKey in kebab-case naming the subject, e.g. "retainer-discount-policy".

Skip pleasantries, scheduling chatter, and anything already obvious. Return ONLY JSON: {"memories": [{"content", "kind", "topicKey"}]}.`,
    prompt: transcriptOf(chunk),
    metadata: { job: "ingest-pass-a" },
    jsonSchema: CANDIDATE_SCHEMA,
  });
  try {
    const parsed = parseJsonBlock<{ memories: Array<{ content: string; kind: string; topicKey: string }> }>(raw);
    return (parsed.memories ?? [])
      .map((m) => normalizeCandidate(m, "A"))
      .filter((c): c is Candidate => !!c);
  } catch {
    return [];
  }
}

/**
 * Pass B — the detail sweep. Prompted specifically for the concrete values
 * broad extraction loses: names, prices, dates, version numbers, term
 * lengths, counts, entity attributes.
 */
export async function extractPassB(ai: ModelRouter, chunk: Message[]): Promise<Candidate[]> {
  const raw = await ai.text("detail_sweep", {
    system: `You are a detail sweeper. Find every CONCRETE VALUE in this transcript and write it as a standalone statement that keeps the number attached to what it measures.

Sweep specifically for:
- prices, rates, percentages, discounts
- dates, deadlines, term lengths, durations
- names of people, clients, products, tools
- version numbers, counts, quantities, thresholds

Do not summarize and do not generalize — a value without its subject is useless. "The retainer is 12 months minimum" is good; "there is a minimum term" is worthless.
Give each a short kebab-case topicKey. Return ONLY JSON: {"memories": [{"content", "kind", "topicKey"}]}.`,
    prompt: transcriptOf(chunk),
    metadata: { job: "ingest-pass-b" },
    jsonSchema: CANDIDATE_SCHEMA,
  });
  try {
    const parsed = parseJsonBlock<{ memories: Array<{ content: string; kind: string; topicKey: string }> }>(raw);
    return (parsed.memories ?? [])
      .map((m) => normalizeCandidate(m, "B"))
      .filter((c): c is Candidate => !!c);
  } catch {
    return [];
  }
}

/**
 * Verification against the source transcript. A candidate the transcript
 * doesn't support is dropped — a confidently-invented memory is worse than a
 * missing one, and this is the layer that keeps the self-hosted path honest
 * (§11: four verification checks instead of Cloudflare's eight).
 */
export async function verifyCandidates(
  ai: ModelRouter,
  chunk: Message[],
  candidates: Candidate[]
): Promise<Candidate[]> {
  if (candidates.length === 0) return [];
  const numbered = candidates.map((c, i) => `[${i}] ${c.content}`).join("\n");
  const raw = await ai.text("verification", {
    system: `Check each numbered statement against the transcript. A statement is supported only if the transcript actually says it — not if it merely sounds plausible. Pay particular attention to numbers, names, and dates: a wrong figure is worse than no figure.

Return ONLY JSON: {"supported": [<indices that are supported>]}.`,
    prompt: `TRANSCRIPT:\n${transcriptOf(chunk)}\n\nSTATEMENTS:\n${numbered}`,
    metadata: { job: "ingest-verification" },
    jsonSchema: {
      type: "object",
      properties: { supported: { type: "array", items: { type: "number" } } },
      required: ["supported"],
    },
  });
  try {
    const supported = new Set(parseJsonBlock<{ supported: number[] }>(raw).supported ?? []);
    return candidates.filter((_, i) => supported.has(i)).map((c) => ({ ...c, verified: true }));
  } catch {
    // Verification is a filter, not a gate: if it fails to parse, keep the
    // candidates but mark them unverified so the ratification gate sees it.
    return candidates.map((c) => ({ ...c, verified: false }));
  }
}

/** Drop near-duplicate candidates within one batch before they hit the DO. */
export function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = `${c.topicKey}|${c.content.toLowerCase().replace(/\s+/g, " ").slice(0, 120)}`;
    const existing = seen.get(key);
    // Prefer the pass B version — it is the one carrying the concrete value.
    if (!existing || (existing.pass === "A" && c.pass === "B")) seen.set(key, c);
  }
  return [...seen.values()];
}

/** Full extraction for one chunk: A + B, verified, deduped. */
export async function extractChunk(ai: ModelRouter, chunk: Message[]): Promise<Candidate[]> {
  const [passA, passB] = await Promise.all([extractPassA(ai, chunk), extractPassB(ai, chunk)]);
  const verified = await verifyCandidates(ai, chunk, dedupeCandidates([...passA, ...passB]));
  return verified;
}
