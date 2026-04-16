// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Intent registry
//
// Maps each CommandIntent to its handler. handler.ts uses dispatchIntent to
// pick the right handler (falling back to the QA handler for who-owns / status
// / general-qa, plus any unknown intent).
// ─────────────────────────────────────────────────────────────────────────────

import type { CommandIntent } from "../../types.js";
import type { IntentContext, IntentHandler, IntentResult } from "./types.js";

import { handle as summarize } from "./summarize.js";
import { handle as decisions } from "./decisions.js";
import { handle as nextSteps } from "./next-steps.js";
import { handle as execSummary } from "./exec-summary.js";
import { handle as assign } from "./assign.js";
import { handle as tasks } from "./tasks.js";
import { handle as draft } from "./draft.js";
import { handle as research } from "./research.js";
import { handle as knowledge } from "./knowledge.js";
import { handle as qa } from "./qa.js";

export const intentRegistry: Partial<Record<CommandIntent, IntentHandler>> = {
  summarize,
  decisions,
  "next-steps": nextSteps,
  "exec-summary": execSummary,
  assign,
  tasks,
  draft,
  research,
  knowledge,
  // who-owns, status, general-qa all route to the QA handler below as default.
};

export async function dispatchIntent(ctx: IntentContext): Promise<IntentResult> {
  const handler = intentRegistry[ctx.command.intent] ?? qa;
  return handler(ctx);
}

export { runResearchCommand } from "./research.js";
export { runKnowledgeCommand } from "./knowledge.js";
export type { IntentContext, IntentHandler, IntentResult } from "./types.js";
