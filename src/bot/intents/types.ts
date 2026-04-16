// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Intent handler contract
//
// Each bot intent (summarize, decisions, draft, …) lives in its own file and
// exports a handler matching the IntentHandler signature below. handler.ts
// resolves an intent from ParsedCommand and delegates to the registry.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, ParsedCommand, TeamsActivity } from "../../types.js";

export interface IntentContext {
  activity: TeamsActivity;
  command: ParsedCommand;
  teamId: string;
  channelId: string;
  channelName: string;
  conversationType: string | undefined;
  isAdmin: boolean;
  env: Env;
}

export interface IntentResult {
  text: string;
}

export type IntentHandler = (ctx: IntentContext) => Promise<IntentResult>;
