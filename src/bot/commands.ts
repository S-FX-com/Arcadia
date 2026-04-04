// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Command Intent Detection
//
// Classifies incoming text into a CommandIntent using keyword/pattern matching.
// No ML required — fast, predictable, zero latency.
// ─────────────────────────────────────────────────────────────────────────────

import { detectLanguage } from "../intelligence/context.js";
import type { CommandIntent, ParsedCommand, TeamsActivity } from "../types.js";

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
      e.mentioned?.id === botId
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
  const language = detectLanguage(cleanText || (activity.locale ?? "en"));
  const mentionedBot = isBotMentioned(activity, botId);

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
    rawText: cleanText,
    language,
    mentionedBot,
  };
}
