// Ask Arcadia — Cited vs Inferred (doctrine §12.3).
//
// Cited: ratified doctrine covers the question; quote those entries.
// Inferred: doctrine does not cover it; give a usable Shane-style read so
// the Specialist keeps moving. Speech is not an autonomous action.
//
// The confidence floor decides the *mode*. It no longer decides whether she
// answers. Refusing a workable request because doctrine is thin is a defect.

import type { RecallResult } from "../memory/driver";
import type { ChatTurn } from "./ask-types";
import { ARCADIA_SYSTEM_CORE } from "../integrations/anthropic";
import { VOICE_RULES } from "./brand";

export type AnswerMode = "cited" | "inferred";

export function decideAskMode(recalled: RecallResult): AnswerMode {
  if (recalled.belowConfidenceFloor || recalled.memories.length === 0) return "inferred";
  return "cited";
}

export function askSystemPrompt(mode: AnswerMode): string {
  const modeRules =
    mode === "cited"
      ? `Mode: Cited.
Start the answer with exactly: "Cited — "
Answer from the doctrine entries provided. Name the bracket numbers you used.
Do not invent figures, titles, or client facts that are not in the entries or the work snapshot.
If the entries are adjacent but do not actually settle the request, still help — draft, coach, prioritize — and add one sentence that the policy part is inferred from voice, not cited.`
      : `Mode: Inferred.
Start the answer with exactly: "Inferred — "
Doctrine does not cover this yet. Give a usable read on how Shane would handle it, from adjacent doctrine, voice, and the Specialist's work snapshot.
Never invent a number, date, EIN, price, or client fact. If you do not have it, say so and ask for it.
Do not refuse the request. Drafts, coaching, and next actions are allowed.
Label any policy claim as your read, not as ratified doctrine.`;

  return `${ARCADIA_SYSTEM_CORE}

${VOICE_RULES}

${modeRules}

Action boundaries (do not do these; you may still talk about them):
- never send to a client
- never publish to a live site
- never modify or delete a file
- never write canonical doctrine
- never take an HR or compensation action
- never overrule a human

S-FX is an outsourced technology department. Staff are S-FX Specialists.
Close with one specific next action.`;
}

export function askUserPrompt(input: {
  question: string;
  history: ChatTurn[];
  recalled: RecallResult;
  workContext: string;
}): string {
  const transcript = input.history
    .map((t) => `${t.role === "user" ? "Staff" : "Arcadia"}: ${t.content}`)
    .join("\n");
  const doctrineBlock =
    input.recalled.memories.length === 0
      ? "(none cleared the floor)"
      : input.recalled.memories.map((m, i) => `[${i + 1}] (${m.id}) ${m.content}`).join("\n");

  return `${transcript ? `Conversation so far:\n${transcript}\n\n` : ""}Question: ${input.question}

Doctrine entries (gravity, not a prison):
${doctrineBlock}

Specialist's live M365 snapshot (only what they can already see; empty if Graph is not connected):
${input.workContext || "(not connected)"}`;
}

export interface CitationPayload {
  mode?: AnswerMode;
  ids: string[];
}

/** Stored in chat_messages.citations. Accepts the old bare string[] rows. */
export function parseCitationPayload(raw: string): CitationPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { ids: parsed.map(String) };
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { mode?: string; ids?: unknown };
      const ids = Array.isArray(obj.ids) ? obj.ids.map(String) : [];
      const mode = obj.mode === "cited" || obj.mode === "inferred" ? obj.mode : undefined;
      return { ...(mode ? { mode } : {}), ids };
    }
  } catch {
    /* fall through */
  }
  return { ids: [] };
}

export function serializeCitationPayload(mode: AnswerMode, ids: string[]): string {
  return JSON.stringify({ mode, ids });
}
