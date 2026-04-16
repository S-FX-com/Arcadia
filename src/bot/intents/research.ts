import { buildResearchStatus } from "../../research/autoresearch.js";
import {
  loadDirectives,
  setEnabled,
  setFocus,
  addPriority,
  removePriority,
  formatDirectives,
} from "../../research/directives.js";
import { getRecentBridges, formatBridges } from "../../research/bridge.js";
import type { Env } from "../../types.js";
import type { IntentHandler } from "./types.js";

/**
 * Parse and execute a research command from the admin user.
 * Exported so DM flow (tryHandleResearchDM) can reuse it without going through
 * the mentioned-in-channel dispatcher.
 */
export async function runResearchCommand(rawText: string, env: Env): Promise<string> {
  const lower = rawText.toLowerCase();

  if (/research\s+status\b/i.test(lower) || /show\s+research\b/i.test(lower) || /what\s+are\s+you\s+research/i.test(lower)) {
    return buildResearchStatus(env);
  }

  if (/research\s+bridges?\b/i.test(lower)) {
    const bridges = await getRecentBridges(env, 10);
    return formatBridges(bridges);
  }

  if (/research\s+pause\b/i.test(lower)) {
    await setEnabled(false, env);
    return "Research paused. I'll stop running autonomous research cycles until you resume.";
  }

  if (/research\s+resume\b/i.test(lower)) {
    await setEnabled(true, env);
    return "Research resumed. I'll start running autonomous research cycles again on the next scheduled cron.";
  }

  if (/research\s+priorities\b/i.test(lower) || /research\s+findings?\b/i.test(lower)) {
    const directives = await loadDirectives(env);
    return formatDirectives(directives);
  }

  const focusMatch = /research\s+focus\s+(?:on\s+)?(.+)/i.exec(rawText);
  if (focusMatch && focusMatch[1]) {
    const focus = focusMatch[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    await setFocus(focus, env);
    return `Research focus updated to: ${focus.join(", ")}`;
  }

  const addMatch = /research\s+add\s+priority[:\s]+(.+)/i.exec(rawText);
  if (addMatch && addMatch[1]) {
    const directives = await addPriority(addMatch[1].trim(), env);
    return `Priority added. Current priorities:\n${directives.priorities.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
  }

  const removeMatch = /research\s+(?:remove|drop)\s+priority[:\s]+(.+)/i.exec(rawText);
  if (removeMatch && removeMatch[1]) {
    const directives = await removePriority(removeMatch[1].trim(), env);
    return `Priority removed. Remaining:\n${directives.priorities.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
  }

  return buildResearchStatus(env);
}

export const handle: IntentHandler = async (ctx) => {
  if (!ctx.isAdmin) {
    return { text: "Research commands are available to administrators only." };
  }
  const text = await runResearchCommand(ctx.command.rawText, ctx.env);
  return { text };
};
