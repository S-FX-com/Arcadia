// Is this actually a doctrine question?
//
// Capture channel D is the highest-value channel (§5.5): every question
// Arcadia cannot answer becomes a question for Shane, and his answer becomes
// permanent doctrine. Its ranking by times_asked only tells him what costs the
// most to leave open if what is in the queue is real. Left unfiltered, every
// "hi", "test" and "thanks" becomes a permanent gap and the ranking degrades
// into noise — the §11 failure mode where Arcadia automates noticing and
// changes nothing.
//
// Two stages, cheapest first: a deterministic reject for the obvious cases,
// then one fast-tier classification for everything else.

import { parseJsonBlock, type ModelRouter } from "../ai/router";

/**
 * Whole-input pleasantries. Matched against the full normalized string, never
 * as substrings — "hi" must not reject "What are hi-touch clients billed at?".
 */
const PLEASANTRIES = new Set([
  "hi",
  "hii",
  "hey",
  "heya",
  "hello",
  "helo",
  "yo",
  "sup",
  "wassup",
  "hola",
  "buenas",
  "buenos dias",
  "buenas tardes",
  "buenas noches",
  "gracias",
  "test",
  "testing",
  "tests",
  "ping",
  "pong",
  "ok",
  "okay",
  "k",
  "cool",
  "nice",
  "great",
  "thanks",
  "thank you",
  "ty",
  "thx",
  "cheers",
  "good morning",
  "good afternoon",
  "good evening",
  "morning",
  "bye",
  "goodbye",
  "hi arcadia",
  "hey arcadia",
  "hello arcadia",
  "arcadia",
  "you there",
  "are you there",
  "anyone there",
  "who are you",
  "what can you do",
]);

/** Lowercase, strip punctuation and accents, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic reject: too short to carry a question, or the entire input is
 * a pleasantry. Deliberately narrow — a false reject silently loses a real gap,
 * which is worse than one greeting slipping through to the classifier.
 */
export function isPleasantry(text: string): boolean {
  const normalized = normalize(text);
  if (normalized.length < 3) return true;
  return PLEASANTRIES.has(normalized);
}

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    isQuestion: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["isQuestion"],
};

/**
 * Second stage. Only reached when recall already failed, so it runs rarely and
 * its cost is bounded by how often Arcadia cannot answer.
 *
 * Fails OPEN: if the classifier errors or returns garbage, the input counts as
 * a question. A missed gap is a permanent hole in doctrine; an extra gap is one
 * row Shane declines.
 */
export async function looksLikeDoctrineQuestion(
  ai: ModelRouter,
  text: string
): Promise<{ isQuestion: boolean; reason?: string }> {
  if (isPleasantry(text)) return { isQuestion: false, reason: "pleasantry" };

  try {
    const raw = await ai.text("classification", {
      system: `Decide whether the input is a genuine question or request about how a company operates — its pricing, positioning, policies, process, staffing, clients, tools, or past decisions.

Answer false for: greetings, small talk, thanks, tests, single words with no request, and anything addressed to no purpose.
Answer true for anything a new employee could reasonably need an answer to, even if it is phrased casually or incompletely.

Return ONLY JSON: {"isQuestion": true|false, "reason": "<a few words>"}.`,
      prompt: text,
      metadata: { job: "gap-question-filter" },
      jsonSchema: CLASSIFY_SCHEMA,
    });
    const parsed = parseJsonBlock<{ isQuestion?: boolean; reason?: string }>(raw);
    if (typeof parsed.isQuestion !== "boolean") return { isQuestion: true, reason: "unparsed" };
    return {
      isQuestion: parsed.isQuestion,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
  } catch {
    return { isQuestion: true, reason: "classifier unavailable" };
  }
}
