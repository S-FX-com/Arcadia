// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Command Intent Detection
//
// Classifies incoming text into a CommandIntent using keyword/pattern matching.
// No ML required — fast, predictable, zero latency.
// ─────────────────────────────────────────────────────────────────────────────

import { detectLanguage, getLanguageName, resolveOutputLanguage } from "../intelligence/context.js";
import type { CommandIntent, DateRange, ParsedCommand, TeamsActivity } from "../types.js";

// Patterns per intent (order matters — more specific first)
const INTENT_PATTERNS: Array<{ intent: CommandIntent; patterns: RegExp[] }> = [
  {
    intent: "summarize",
    patterns: [
      /\bsummar(ize|ise|y)\b/i,
      /\bkey\s+(points?|takeaways?)\b/i,
      /\bwhat.s\s+been\s+(said|discussed)\b/i,
      /\bgive\s+me\s+(an?\s+)?(overview|recap|rundown)\b/i,
      /\btl;?dr\b/i,
      /\bcatch\s+me\s+up\b/i,
    ],
  },
  {
    intent: "decisions",
    patterns: [
      /\bwhat\s+(did\s+we|was)\s+decid(e|ed)\b/i,
      /\bdecision(s)?\b/i,
      /\bwhat.s\s+been\s+(agreed|settled|resolved)\b/i,
      /\bwhat\s+did\s+we\s+agree\b/i,
    ],
  },
  {
    intent: "who-owns",
    patterns: [
      /\bwho\s+(owns?|is\s+responsible|is\s+leading|is\s+in\s+charge)\b/i,
      /\bwho.s\s+(?:handling|on\s+point\s+for|running)\b/i,
      /\bresponsib(le|ility)\b/i,
      /\bowner(ship)?\b/i,
    ],
  },
  {
    intent: "next-steps",
    patterns: [
      /\bnext\s+steps?\b/i,
      /\bwhat\s+(do\s+we\s+do|should\s+we\s+do|needs?\s+to\s+(happen|be\s+done))\b/i,
      /\baction\s+items?\b/i,
      /\bwhat.s\s+(left|remaining|outstanding)\b/i,
      /\bwhat\s+are\s+we\s+missing\b/i,
    ],
  },
  {
    intent: "status",
    patterns: [
      /\bwhat.s\s+(going\s+on|the\s+status|happening|the\s+update)\b/i,
      /\bstatus\s+(update|check|of)?\b/i,
      /\bwhere\s+are\s+we\b/i,
      /\bhow.s\s+(it\s+going|this\s+going|the\s+project)\b/i,
      /\bwhat.s\s+the\s+situation\b/i,
      /\bprogress\b/i,
    ],
  },
  // ─── Phase 3 intents ─────────────────────────────────────────────────────────
  {
    intent: "exec-summary",
    patterns: [
      /\bexec(utive)?\s+summary\b/i,
      /\bboard\s+summary\b/i,
      /\bexec\s+report\b/i,
      /\bexecutive\s+report\b/i,
    ],
  },
  // ─── Phase 2 intents ─────────────────────────────────────────────────────────
  {
    intent: "assign",
    patterns: [
      /\bassign\b.+?\bto\b/i,
      /\b(give|hand)\s+.+?\bto\b/i,
      /\b.+?\bshould\s+be\s+(owned|assigned|handled)\s+by\b/i,
    ],
  },
  {
    intent: "draft",
    patterns: [
      /\bdraft\b/i,
      /\bwrite\s+a\s+(message|follow.?up|note)\b/i,
      /\bcompose\b/i,
      /\bhelp\s+me\s+(say|write|respond)\b/i,
    ],
  },
  {
    intent: "tasks",
    patterns: [
      /\b(show|list|what are|give me)\s+(the\s+)?open\s+tasks?\b/i,
      /\bmy\s+tasks?\b/i,
      /\bwhat.s\s+(on\s+(my|our)\s+plate|outstanding)\b/i,
      /\btask\s+(list|board|tracker)\b/i,
      /\bopen\s+items?\b/i,
    ],
  },
  // ─── Phase 5 intents ─────────────────────────────────────────────────────────
  {
    intent: "research",
    patterns: [
      /\bresearch\s+(status|report|focus|priorities|pause|resume|bridges)\b/i,
      /\bresearch\s+add\s+priority\b/i,
      /\bresearch\s+focus\s+on\b/i,
      /\bwhat\s+are\s+you\s+research(ing)?\b/i,
      /\bshow\s+research\b/i,
      /\bresearch\s+findings?\b/i,
    ],
  },
];

/**
 * Strip @mention text from incoming message.
 * Teams includes the bot's display name in the message text.
 */
export function stripMention(text: string): string {
  return text
    .replace(/<at>[^<]+<\/at>/gi, "") // XML-style mention tags
    .replace(/@\w[\w\s]*/g, "")        // @Name mentions
    .trim();
}

/**
 * Detect if the bot was @mentioned in this activity.
 */
export function isBotMentioned(activity: TeamsActivity, botId: string): boolean {
  const entities = activity.entities ?? [];
  return entities.some(
    (e) =>
      e.type === "mention" &&
      (e.mentioned?.id === botId || e.mentioned?.id === `28:${botId}`)
  );
}

/**
 * Parse an incoming Teams message into a structured command.
 */
export function parseCommand(
  activity: TeamsActivity,
  botId: string
): ParsedCommand {
  const rawText = activity.text ?? "";
  const cleanText = stripMention(rawText);
  const detectedLanguage = detectLanguage(cleanText || (activity.locale ?? "en"));
  const language = resolveOutputLanguage(detectedLanguage);
  const mentionedBot = isBotMentioned(activity, botId);

  // When the user writes in a language other than English or Spanish, prepend a
  // translation note so the AI knows to translate the request and respond in English.
  let processedText = cleanText;
  if (detectedLanguage !== "en" && detectedLanguage !== "es" && cleanText.trim().length > 0) {
    const langName = getLanguageName(detectedLanguage);
    processedText = `[Note: The user wrote in ${langName}. Translate their request to English and respond in English.]\n${cleanText}`;
  }

  // Match intent
  let intent: CommandIntent = "general-qa";
  for (const { intent: candidate, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => p.test(cleanText))) {
      intent = candidate;
      break;
    }
  }

  return {
    intent,
    rawText: processedText,
    language,
    mentionedBot,
  };
}

// ─── Phase 2: Draft command parsing ──────────────────────────────────────────

import type { DraftType } from "../ai/prompts.js";

export interface ParsedDraftCommand {
  type: DraftType;
  targetName: string | null;
}

/**
 * Parse a draft command to determine type and target person.
 * e.g. "draft a follow-up to John" → { type: "follow-up", targetName: "John" }
 */
export function parseDraftCommand(text: string): ParsedDraftCommand {
  const lower = text.toLowerCase();

  // Determine draft type
  let type: DraftType = "general";
  if (/follow.?up/i.test(text)) type = "follow-up";
  else if (/\b(unblock|escalat|remov(e|ing)\s+blocker)\b/i.test(text)) type = "unblock";
  else if (/\b(update|status\s+update|progress\s+update)\b/i.test(text)) type = "update";

  // Extract "to [Name]"
  const toMatch = /\bto\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i.exec(text);
  const targetName = toMatch?.[1]?.trim() ?? null;

  return { type, targetName };
}

// ─── Phase 3: Date range extraction for exec summaries ───────────────────────

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, oct: 9, nov: 10, dec: 11,
};

function isoDate(y: number, m: number, d: number): string {
  return new Date(y, m, d).toISOString().slice(0, 10);
}

/**
 * Extract a DateRange from natural language text.
 * Returns null if no date reference is found — the handler will ask for one.
 */
export function extractDateRange(text: string): DateRange | null {
  const lower = text.toLowerCase();
  const today = new Date();
  const y = today.getFullYear();
  const todayStr = today.toISOString().slice(0, 10);

  if (/\btoday\b/.test(lower)) {
    return { from: todayStr, to: todayStr, label: "today" };
  }

  if (/\byesterday\b/.test(lower)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    const s = d.toISOString().slice(0, 10);
    return { from: s, to: s, label: "yesterday" };
  }

  if (/\bthis\s+week\b/.test(lower)) {
    const mon = new Date(today);
    mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    return { from: mon.toISOString().slice(0, 10), to: todayStr, label: "this week" };
  }

  if (/\blast\s+week\b/.test(lower)) {
    const mon = new Date(today);
    mon.setDate(today.getDate() - ((today.getDay() + 6) % 7) - 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10), label: "last week" };
  }

  if (/\bthis\s+month\b/.test(lower)) {
    const from = isoDate(y, today.getMonth(), 1);
    return { from, to: todayStr, label: "this month" };
  }

  // "Month Day [to Month] Day" — e.g. "April 1 to April 10" or "April 1 to 10"
  const monthPattern = new RegExp(
    `\\b(${Object.keys(MONTHS).join("|")})\\s+(\\d{1,2})(?:\\s+(?:to|through|-)\\s+(?:(${Object.keys(MONTHS).join("|")})\\s+)?(\\d{1,2}))?\\b`,
    "i"
  );
  const m = monthPattern.exec(lower);
  if (m) {
    const startMonth = MONTHS[m[1]];
    const startDay = parseInt(m[2]);
    const endMonth = m[3] ? MONTHS[m[3]] : startMonth;
    const endDay = m[4] ? parseInt(m[4]) : startDay;
    return {
      from: isoDate(y, startMonth, startDay),
      to: isoDate(y, endMonth, endDay),
      label: m[4]
        ? `${m[1]} ${startDay} to ${m[3] ?? m[1]} ${endDay}`
        : `${m[1]} ${startDay}`,
    };
  }

  // YYYY-MM-DD range
  const isoPattern = /(\d{4}-\d{2}-\d{2})(?:\s+(?:to|through|-)\s+(\d{4}-\d{2}-\d{2}))?/;
  const iso = isoPattern.exec(text);
  if (iso) {
    const from = iso[1];
    const to = iso[2] ?? iso[1];
    return { from, to, label: iso[2] ? `${from} to ${to}` : from };
  }

  return null;
}
