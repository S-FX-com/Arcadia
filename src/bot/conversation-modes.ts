// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Conversation modes
//
// Strategy objects that encapsulate the per-surface behaviour of the bot:
//   - DMMode        → 1:1 personal chat, per-user history, always responds
//   - GroupChatMode → private group chat, shared history, always responds
//   - ChannelMode   → public team channel, no conversational history,
//                     responds only when @mentioned
//
// handler.ts picks a mode from the Teams activity's conversationType and
// delegates history I/O and response gating to it, instead of branching
// inline on conversationType everywhere.
// ─────────────────────────────────────────────────────────────────────────────

import {
  loadDMHistory,
  saveDMHistory,
  loadGroupChatHistory,
  saveGroupChatHistory,
} from "../memory/kv.js";
import { AI, TEAMS } from "../constants.js";
import type { ConversationTurn, Env, TeamsActivity } from "../types.js";

export type ConversationModeName = "dm" | "groupChat" | "channel";

export interface ConversationMode {
  readonly name: ConversationModeName;

  /** Load prior conversational turns for this surface. Channels have none. */
  fetchHistory(activity: TeamsActivity, env: Env): Promise<ConversationTurn[]>;

  /** Persist updated turns. No-op for surfaces without conversational history. */
  saveHistory(
    activity: TeamsActivity,
    turns: ConversationTurn[],
    env: Env
  ): Promise<void>;

  /**
   * Whether Arcadia should produce a reply for this activity.
   * DMs and group chats always respond; channels require an @mention.
   */
  shouldRespond(activity: TeamsActivity, mentionedBot: boolean): boolean;

  /** Max number of prior turns to feed into the AI context. */
  getContextLimit(): number;
}

// ─── DM (personal) ───────────────────────────────────────────────────────────

export const DMMode: ConversationMode = {
  name: "dm",

  async fetchHistory(activity, env) {
    const userId = activity.from.aadObjectId ?? activity.from.id;
    return loadDMHistory(userId, env);
  },

  async saveHistory(activity, turns, env) {
    const userId = activity.from.aadObjectId ?? activity.from.id;
    await saveDMHistory(userId, turns, env);
  },

  shouldRespond() {
    return true;
  },

  getContextLimit() {
    return AI.HISTORY_MAX_TURNS;
  },
};

// ─── Group chat ──────────────────────────────────────────────────────────────

export const GroupChatMode: ConversationMode = {
  name: "groupChat",

  async fetchHistory(activity, env) {
    return loadGroupChatHistory(activity.conversation.id, env);
  },

  async saveHistory(activity, turns, env) {
    await saveGroupChatHistory(activity.conversation.id, turns, env);
  },

  shouldRespond() {
    return true;
  },

  getContextLimit() {
    return AI.HISTORY_MAX_TURNS;
  },
};

// ─── Channel ─────────────────────────────────────────────────────────────────
//
// Channels don't keep a conversational turn history — the bot operates on the
// rolling message cache instead. fetchHistory/saveHistory are intentionally
// inert so the strategy interface stays uniform across modes.

export const ChannelMode: ConversationMode = {
  name: "channel",

  async fetchHistory() {
    return [];
  },

  async saveHistory() {
    // intentionally empty
  },

  shouldRespond(_activity, mentionedBot) {
    return mentionedBot;
  },

  getContextLimit() {
    return AI.HISTORY_MAX_TURNS;
  },
};

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Pick the conversation mode for an incoming Teams activity.
 * Falls back to ChannelMode for unknown conversationType values.
 */
export function resolveConversationMode(activity: TeamsActivity): ConversationMode {
  const t = activity.conversation.conversationType;
  if (t === TEAMS.CONVERSATION_TYPES.PERSONAL) return DMMode;
  if (t === TEAMS.CONVERSATION_TYPES.GROUP_CHAT) return GroupChatMode;
  return ChannelMode;
}
