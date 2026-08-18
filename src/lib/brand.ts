// Brand doctrine (§7). S-FX is a fractional technology department — never
// "MSP," "agency," "IT company," or "vendor." The rules travel as prose to
// anything that writes (Arcadia's answers, the os-bridge brand context); the
// regex below is the machine-checkable form of the same doctrine.

const BANNED: Array<{ term: string; pattern: RegExp }> = [
  { term: "MSP", pattern: /\bMSPs?\b/ },
  { term: "managed service provider", pattern: /\bmanaged services? providers?\b/i },
  { term: "agency", pattern: /\bagenc(?:y|ies)\b/i },
  { term: "IT company", pattern: /\bIT company\b/i },
  { term: "vendor", pattern: /\bvendors?\b/i },
];

/** Returns the banned terms present in the text (empty array = clean). */
export function brandViolations(text: string): string[] {
  return BANNED.filter(({ pattern }) => pattern.test(text)).map(({ term }) => term);
}

export const BRAND_RULES = `S-FX is a fractional technology department. Never describe S-FX (or let copy imply it) as an "MSP," "managed service provider," "agency," "IT company," or "vendor." Staff are "S-FX Specialists."`;

/** Voice rules applied to every staff- and public-facing output (§7). */
export const VOICE_RULES = `Write in Shane's register:
- Direct, short declarative sentences. No hedging, no softening qualifiers.
- Specific numbers, dates, and names instead of vague adjectives. If the real figure isn't available, say so — never invent one.
- Sixth-grade clarity. No jargon unless the recipient works in that register and the term is load-bearing.
- Vary sentence length. Strongest line lands at the end.
- Close with a specific next action, never an open question.
- Never explain someone's own work back to them.
- ${BRAND_RULES}`;
