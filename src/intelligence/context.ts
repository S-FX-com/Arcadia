// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Thread Context Builder + Language Detection
// ─────────────────────────────────────────────────────────────────────────────

import type { ChannelMessage, OwnerAssignment, ThreadContext } from "../types.js";

/**
 * Detect the primary language of a text string.
 * Uses Unicode block analysis for a lightweight, dependency-free approach.
 * Returns BCP-47 language tag (e.g. "en", "fr", "es", "ar", "zh", "ja").
 */
export function detectLanguage(text: string): string {
  if (!text || text.trim().length < 5) return "en";

  // Count characters in key Unicode blocks
  let arabic = 0, cjk = 0, cyrillic = 0, latin = 0, hebrew = 0;
  let devanagari = 0;

  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 0x0600 && cp <= 0x06FF) arabic++;
    else if (
      (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified
      (cp >= 0x3040 && cp <= 0x309F) || // Hiragana
      (cp >= 0x30A0 && cp <= 0x30FF) || // Katakana
      (cp >= 0xAC00 && cp <= 0xD7AF)    // Hangul
    ) cjk++;
    else if (cp >= 0x0400 && cp <= 0x04FF) cyrillic++;
    else if (cp >= 0x0590 && cp <= 0x05FF) hebrew++;
    else if (cp >= 0x0900 && cp <= 0x097F) devanagari++;
    else if ((cp >= 0x0041 && cp <= 0x007A) || (cp >= 0x00C0 && cp <= 0x024F)) latin++;
  }

  const total = text.replace(/\s/g, "").length || 1;
  const dominant = Math.max(arabic, cjk, cyrillic, latin, hebrew, devanagari);

  if (dominant === arabic && arabic / total > 0.1) return "ar";
  if (dominant === cjk && cjk / total > 0.1) {
    // Rough Japanese vs Korean vs Chinese detection
    let hiragana = 0;
    for (const char of text) {
      const cp = char.codePointAt(0) ?? 0;
      if (cp >= 0x3040 && cp <= 0x309F) hiragana++;
    }
    return hiragana > 2 ? "ja" : "zh";
  }
  if (dominant === cyrillic && cyrillic / total > 0.1) return "ru";
  if (dominant === hebrew && hebrew / total > 0.1) return "he";
  if (dominant === devanagari && devanagari / total > 0.1) return "hi";

  // For Latin scripts, use common French/Spanish/German indicators
  const lower = text.toLowerCase();
  if (/\b(le|la|les|un|une|des|et|est|avec|pour|dans|je|nous|vous)\b/.test(lower)) return "fr";
  if (/\b(el|la|los|las|un|una|es|con|para|en|yo|nosotros|vosotros)\b/.test(lower)) return "es";
  if (/\b(der|die|das|ein|eine|und|ist|mit|für|in|ich|wir|sie)\b/.test(lower)) return "de";
  if (/\b(il|lo|la|gli|le|un|una|e|è|con|per|in|io|noi|voi)\b/.test(lower)) return "it";

  return "en";
}

/**
 * Resolve a detected BCP-47 language tag to one of Arcadia's allowed output
 * languages: English ("en") or Spanish ("es").
 *
 * Any language other than Spanish is mapped to English so that the bot never
 * produces output in unsupported languages.
 */
export function resolveOutputLanguage(detected: string): "en" | "es" {
  return detected === "es" ? "es" : "en";
}

/**
 * Return a human-readable English name for a BCP-47 language code.
 * Used when constructing translation-context notes for the AI.
 */
export function getLanguageName(code: string): string {
  const names: Record<string, string> = {
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    ar: "Arabic",
    zh: "Chinese",
    ja: "Japanese",
    ru: "Russian",
    he: "Hebrew",
    hi: "Hindi",
  };
  return names[code] ?? code;
}

/**
 * Extract the primary language from a list of messages.
 * Uses the most recent non-bot, non-trivial messages.
 */
export function detectConversationLanguage(messages: ChannelMessage[]): string {
  const sample = messages
    .filter((m) => !m.isBot && m.text.length > 10)
    .slice(0, 5)
    .map((m) => m.text)
    .join(" ");

  return detectLanguage(sample);
}

/**
 * Heuristic: scan messages for ownership mentions.
 * Patterns like "X will handle", "X is responsible", "X owns", "@X assigned".
 */
export function extractOwners(messages: ChannelMessage[]): OwnerAssignment[] {
  const owners: OwnerAssignment[] = [];
  const ownershipPatterns = [
    /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:will|is going to|shall)\s+(?:handle|take care of|do|own|lead)\s+(.+?)(?:\.|$)/gi,
    /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:is|are)\s+responsible\s+for\s+(.+?)(?:\.|$)/gi,
    /assigning\s+(.+?)\s+to\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/gi,
    /@([A-Za-z]+)\s+(?:please|can you|could you)\s+(.+?)(?:\?|$)/gi,
  ];

  for (const msg of messages) {
    for (const pattern of ownershipPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(msg.text);
      if (match && match[1] && match[2]) {
        owners.push({
          owner: match[1].trim(),
          task: match[2].trim(),
        });
      }
    }
  }

  // Deduplicate by owner+task
  const seen = new Set<string>();
  return owners.filter((o) => {
    const key = `${o.owner}:${o.task}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build a structured ThreadContext from raw messages.
 * This is a fast, heuristic pass — AI pipelines provide deeper analysis.
 */
export function buildThreadContext(messages: ChannelMessage[]): ThreadContext {
  if (messages.length === 0) {
    return {
      decisions: [],
      openItems: [],
      owners: [],
      summary: "No messages available.",
      language: "en",
      messageCount: 0,
      timespan: { from: "", to: "" },
    };
  }

  const sorted = [...messages].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : 1
  );

  const language = detectConversationLanguage(messages);
  const owners = extractOwners(messages);

  // Heuristic open items: messages ending with ? or containing "need to", "TODO"
  const openItems: string[] = [];
  for (const msg of sorted) {
    if (msg.isBot) continue;
    if (
      msg.text.trim().endsWith("?") ||
      /\b(need to|needs to|TODO|action item|follow up|pending)\b/i.test(msg.text)
    ) {
      openItems.push(`${msg.authorName}: ${msg.text.slice(0, 100)}`);
    }
  }

  const timespan = {
    from: sorted[0]?.timestamp ?? "",
    to: sorted[sorted.length - 1]?.timestamp ?? "",
  };

  return {
    decisions: [], // populated by AI summarize pipeline
    openItems: openItems.slice(0, 5),
    owners,
    summary: `${messages.length} messages between ${timespan.from.slice(0, 10)} and ${timespan.to.slice(0, 10)}.`,
    language,
    messageCount: messages.length,
    timespan,
  };
}
