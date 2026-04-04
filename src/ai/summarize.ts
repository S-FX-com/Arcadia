// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Thread Summarization Pipeline
// ─────────────────────────────────────────────────────────────────────────────

import { callAI } from "./router.js";
import {
  buildSummarizePrompt,
  buildDecisionsPrompt,
  buildNextStepsPrompt,
} from "./prompts.js";
import { cacheMessages, loadCachedMessages, todayUTC, cacheSummary } from "../memory/kv.js";
import { getChannelMessages } from "../graph/messages.js";
import type { ChannelMessage, Env, ParsedSummary } from "../types.js";

/**
 * Loosely parse the structured summary output from the AI.
 * This is best-effort — the full text is always preserved.
 */
function parseSummaryOutput(raw: string): ParsedSummary {
  const bullets: string[] = [];
  const decisions: string[] = [];
  const openItems: string[] = [];
  const owners: { task: string; owner: string }[] = [];

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  let section: "summary" | "decisions" | "open" | "owners" | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.includes("summary:")) {
      section = "summary";
      const content = line.replace(/\*\*summary:\*\*/i, "").trim();
      if (content) bullets.push(content);
    } else if (lower.includes("key decision")) {
      section = "decisions";
    } else if (lower.includes("open item")) {
      section = "open";
    } else if (lower.includes("owner")) {
      section = "owners";
    } else if (line.startsWith("-") || line.startsWith("•")) {
      const content = line.replace(/^[-•]\s*/, "").trim();
      if (!content || content.toLowerCase() === "none") continue;
      if (section === "decisions") decisions.push(content);
      else if (section === "open") openItems.push(content);
      else if (section === "owners") {
        const arrowIdx = content.indexOf("→");
        if (arrowIdx > -1) {
          owners.push({
            owner: content.slice(0, arrowIdx).trim(),
            task: content.slice(arrowIdx + 1).trim(),
          });
        } else {
          owners.push({ owner: content, task: "unspecified" });
        }
      } else if (section === "summary") {
        bullets.push(content);
      }
    } else if (section === "summary") {
      bullets.push(line);
    }
  }

  return { bullets, decisions, openItems, owners };
}

/**
 * Full summarization pipeline:
 * 1. Fetch fresh messages from Graph + merge with KV cache
 * 2. Call AI to generate summary
 * 3. Store summary in KV
 * 4. Return structured + raw output
 */
export async function summarizeChannel(
  teamId: string,
  channelId: string,
  language: string,
  env: Env,
  limit = 50
): Promise<{ raw: string; parsed: ParsedSummary; messages: ChannelMessage[] }> {
  // Fetch fresh messages
  let messages: ChannelMessage[] = [];
  try {
    messages = await getChannelMessages(teamId, channelId, env, limit);
    await cacheMessages(teamId, channelId, messages, env);
  } catch {
    // Fall back to KV cache if Graph is unavailable
    messages = await loadCachedMessages(teamId, channelId, env);
  }

  if (messages.length === 0) {
    const empty = "No recent messages found in this channel.";
    return {
      raw: empty,
      parsed: { bullets: [empty], decisions: [], openItems: [], owners: [] },
      messages,
    };
  }

  const { system, user } = buildSummarizePrompt(messages, language);
  const response = await callAI(system, user, env);
  const parsed = parseSummaryOutput(response.text);

  // Cache summary
  await cacheSummary(teamId, channelId, todayUTC(), response.text, env);

  return { raw: response.text, parsed, messages };
}

/**
 * Extract decisions from a set of messages.
 */
export async function extractDecisions(
  messages: ChannelMessage[],
  language: string,
  env: Env
): Promise<string> {
  const { system, user } = buildDecisionsPrompt(messages, language);
  const response = await callAI(system, user, env);
  return response.text;
}

/**
 * Extract next steps / action items from a set of messages.
 */
export async function extractNextSteps(
  messages: ChannelMessage[],
  language: string,
  env: Env
): Promise<string> {
  const { system, user } = buildNextStepsPrompt(messages, language);
  const response = await callAI(system, user, env);
  return response.text;
}
