// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Research Directives (program.md analog)
//
// Shane's control interface for steering what Arcadia researches.
// Directives are stored in KV as a JSON blob keyed "research:directives".
// Shane updates them via DM commands; the research loop reads them each cycle.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, ResearchDirectives } from "../types.js";

const KV_DIRECTIVES_KEY = "research:directives";

/** Default directives — used when none have been set yet. */
const DEFAULT_DIRECTIVES: ResearchDirectives = {
  focus: ["all"],
  priorities: [
    "Map all active projects and their owners",
    "Identify decisions made in chats that should be in channels",
    "Build a complete org chart from communication patterns",
    "Track customer-related conversations across all surfaces",
  ],
  excludeChats: [],
  questionThrottle: { perCycle: 3, perDay: 5 },
  enabled: true,
};

/**
 * Load the current research directives from KV.
 * Returns default directives if none have been saved.
 */
export async function loadDirectives(env: Env): Promise<ResearchDirectives> {
  const raw = await env.ARCADIA_CACHE.get(KV_DIRECTIVES_KEY);
  if (!raw) return { ...DEFAULT_DIRECTIVES };

  try {
    const parsed = JSON.parse(raw) as Partial<ResearchDirectives>;
    return {
      focus: parsed.focus ?? DEFAULT_DIRECTIVES.focus,
      priorities: parsed.priorities ?? DEFAULT_DIRECTIVES.priorities,
      excludeChats: parsed.excludeChats ?? DEFAULT_DIRECTIVES.excludeChats,
      questionThrottle: parsed.questionThrottle ?? DEFAULT_DIRECTIVES.questionThrottle,
      enabled: parsed.enabled ?? DEFAULT_DIRECTIVES.enabled,
    };
  } catch {
    return { ...DEFAULT_DIRECTIVES };
  }
}

/**
 * Save updated research directives to KV.
 */
export async function saveDirectives(
  directives: ResearchDirectives,
  env: Env
): Promise<void> {
  await env.ARCADIA_CACHE.put(KV_DIRECTIVES_KEY, JSON.stringify(directives));
}

/**
 * Add a priority to the current directives.
 * Returns the updated directives.
 */
export async function addPriority(
  priority: string,
  env: Env
): Promise<ResearchDirectives> {
  const directives = await loadDirectives(env);
  if (!directives.priorities.includes(priority)) {
    directives.priorities.push(priority);
    await saveDirectives(directives, env);
  }
  return directives;
}

/**
 * Remove a priority by index or matching text.
 * Returns the updated directives.
 */
export async function removePriority(
  match: string,
  env: Env
): Promise<ResearchDirectives> {
  const directives = await loadDirectives(env);
  const lower = match.toLowerCase();
  directives.priorities = directives.priorities.filter(
    (p) => !p.toLowerCase().includes(lower)
  );
  await saveDirectives(directives, env);
  return directives;
}

/**
 * Set focus areas (replace existing).
 */
export async function setFocus(
  focus: string[],
  env: Env
): Promise<ResearchDirectives> {
  const directives = await loadDirectives(env);
  directives.focus = focus;
  await saveDirectives(directives, env);
  return directives;
}

/**
 * Pause or resume autoresearch.
 */
export async function setEnabled(
  enabled: boolean,
  env: Env
): Promise<ResearchDirectives> {
  const directives = await loadDirectives(env);
  directives.enabled = enabled;
  await saveDirectives(directives, env);
  return directives;
}

/**
 * Format directives as a readable string for Teams display.
 */
export function formatDirectives(directives: ResearchDirectives): string {
  const status = directives.enabled ? "**Active**" : "**Paused**";
  const focus = directives.focus.join(", ");
  const priorities = directives.priorities.length > 0
    ? directives.priorities.map((p, i) => `${i + 1}. ${p}`).join("\n")
    : "(none set)";
  const throttle = `${directives.questionThrottle.perCycle}/cycle, ${directives.questionThrottle.perDay}/day`;

  return [
    `**Research Directives** — ${status}`,
    "",
    `**Focus:** ${focus}`,
    "",
    "**Priorities:**",
    priorities,
    "",
    `**Question throttle:** ${throttle}`,
    directives.excludeChats.length > 0
      ? `**Excluded chats:** ${directives.excludeChats.length}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
