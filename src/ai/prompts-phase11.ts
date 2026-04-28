// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Phase 11: Self-Learning Loop Prompts
//
// Three prompt builders for the Hermes-inspired learning loop:
//
//   buildProcedureExtractionPrompt   — Decide if an interaction yields a reusable procedure
//   buildProcedureEvolutionPrompt    — Rewrite a procedure that's underperforming
//   buildUserIntelligencePrompt      — Refresh the active user intelligence profile
// ─────────────────────────────────────────────────────────────────────────────

import type { Procedure, UserIntelligence } from "../types.js";

// ─── Procedure extraction ────────────────────────────────────────────────────

export interface ExtractedProcedureCandidate {
  found: true;
  name: string;
  description: string;
  trigger_pattern: string;
  content: string;
}

export type ExtractedProcedureResult =
  | ExtractedProcedureCandidate
  | { found: false };

/**
 * Build the prompt that asks the model whether the given interaction contains
 * a reusable procedure worth extracting.
 */
export function buildProcedureExtractionPrompt(
  userMessage: string,
  assistantResponse: string,
  existingProcedures: string[],
): { system: string; user: string } {
  const system = `You are a pattern recognition system for an AI assistant called Arcadia.
Your job: determine if this interaction contains a reusable procedure — a
specific, repeatable approach to a recurring task type that would make
Arcadia better at future similar requests.

A procedure is worth extracting ONLY when:
- The task type is likely to recur (not a one-off)
- The response contains specific domain logic, not generic advice
- The approach is non-obvious and would improve future responses

A procedure is NOT worth extracting when:
- It's a simple factual lookup
- It's a generic response with no domain specificity
- A similar procedure already exists (check existing list)

Output ONLY a JSON object. No prose.`;

  const existing = existingProcedures.length > 0
    ? existingProcedures.join(", ")
    : "(none)";
  const responseSnippet = assistantResponse.slice(0, 400);

  const user = `Existing procedures (check for duplicates): ${existing}

User asked: ${userMessage}
Arcadia responded: ${responseSnippet}

If a reusable procedure exists, output:
{
  "found": true,
  "name": "kebab-case-identifier",
  "description": "one sentence: when to apply this",
  "trigger_pattern": "comma,separated,keywords",
  "content": "the specific instruction to inject (2-4 sentences, imperative)"
}

If no procedure worth extracting:
{ "found": false }`;

  return { system, user };
}

/**
 * Robust JSON parser for the extraction prompt response. Returns null if the
 * output isn't usable.
 */
export function parseProcedureExtractionResponse(
  text: string,
): ExtractedProcedureResult | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (parsed.found !== true) return { found: false };

    const name = String(parsed.name ?? "").trim();
    const description = String(parsed.description ?? "").trim();
    const triggerPattern = String(parsed.trigger_pattern ?? "").trim();
    const content = String(parsed.content ?? "").trim();

    if (!name || !description || !triggerPattern || !content) return null;

    return {
      found: true,
      name: name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60),
      description: description.slice(0, 240),
      trigger_pattern: triggerPattern.slice(0, 240),
      content: content.slice(0, 800),
    };
  } catch {
    return null;
  }
}

// ─── Procedure evolution ─────────────────────────────────────────────────────

/**
 * Build the prompt that rewrites a procedure whose feedback indicates it
 * isn't working. Returns just the new content text — no prose, no JSON.
 */
export function buildProcedureEvolutionPrompt(
  procedure: Procedure,
  negativeExamples: string[],
): { system: string; user: string } {
  const system = `You are improving an AI assistant's learned procedures based on user feedback.
A procedure is a specific instruction injected into the assistant's system prompt.
The current version has received negative signals — improve it.
Output ONLY the improved procedure content. No prose, no explanation.`;

  const examples = negativeExamples.length > 0
    ? negativeExamples.map((s) => `- ${s}`).join("\n")
    : "(no specific examples — improve clarity and specificity)";

  const user = `Current procedure: ${procedure.name}
Current content: ${procedure.content}

User corrections/follow-ups that indicate it's not working:
${examples}

Write an improved version of the procedure content that addresses these issues.
Keep it 2-4 sentences, imperative voice, specific to the domain.`;

  return { system, user };
}

// ─── User intelligence update ────────────────────────────────────────────────

/**
 * Build the prompt that refreshes the active intelligence profile for a user
 * from a slice of recent interactions. Output is a JSON object.
 */
export function buildUserIntelligencePrompt(
  userId: string,
  recentInteractions: Array<{ user: string; assistant: string }>,
  currentIntelligence: UserIntelligence | null,
): { system: string; user: string } {
  const system = `You build an active "user intelligence" profile for an AI assistant.
You will receive a small sample of recent interactions and the current profile.
Your job: refresh the profile with what these interactions reveal about the user
— their communication style, preferences, focus areas, recurring clients, and
patterns of correction.

Rules:
- Be specific. Avoid generic descriptors ("smart", "professional").
- Don't drop existing intelligence unless it is clearly contradicted.
- correction_patterns should capture *things to avoid* (e.g. "do not pad executive summaries").
- Output ONLY a JSON object — no prose, no markdown.`;

  const interactionSample = recentInteractions
    .slice(-10)
    .map(
      (t, i) =>
        `[${i + 1}]
USER: ${t.user.slice(0, 300)}
ASSISTANT: ${t.assistant.slice(0, 300)}`,
    )
    .join("\n\n");

  const current = currentIntelligence
    ? JSON.stringify(
        {
          preferredResponseLength: currentIntelligence.preferredResponseLength,
          preferredFormat: currentIntelligence.preferredFormat,
          communicationStyle: currentIntelligence.communicationStyle,
          peakHours: currentIntelligence.peakHours,
          timezone: currentIntelligence.timezone,
          expertiseAreas: currentIntelligence.expertiseAreas,
          recurringClients: currentIntelligence.recurringClients,
          correctionPatterns: currentIntelligence.correctionPatterns,
        },
        null,
        2,
      )
    : "(no existing profile)";

  const user = `User ID: ${userId}
Current profile:
${current}

Recent interactions:
${interactionSample}

Return ONLY a JSON object with the same shape as the current profile:
{
  "preferredResponseLength": "brief"|"medium"|"detailed",
  "preferredFormat": "markdown"|"plain"|"structured",
  "communicationStyle": "...",
  "peakHours": "...",
  "timezone": "America/New_York",
  "expertiseAreas": ["..."],
  "recurringClients": ["..."],
  "correctionPatterns": ["..."]
}`;

  return { system, user };
}

export interface ParsedUserIntelligence {
  preferredResponseLength: "brief" | "medium" | "detailed";
  preferredFormat: "markdown" | "plain" | "structured";
  communicationStyle: string | null;
  peakHours: string | null;
  timezone: string;
  expertiseAreas: string[];
  recurringClients: string[];
  correctionPatterns: string[];
}

export function parseUserIntelligenceResponse(
  text: string,
): ParsedUserIntelligence | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;

    const lengths: Array<"brief" | "medium" | "detailed"> = ["brief", "medium", "detailed"];
    const formats: Array<"markdown" | "plain" | "structured"> = ["markdown", "plain", "structured"];

    const respLen = lengths.includes(parsed.preferredResponseLength as "brief" | "medium" | "detailed")
      ? (parsed.preferredResponseLength as "brief" | "medium" | "detailed")
      : "medium";
    const format = formats.includes(parsed.preferredFormat as "markdown" | "plain" | "structured")
      ? (parsed.preferredFormat as "markdown" | "plain" | "structured")
      : "markdown";

    const ensureStringArray = (v: unknown): string[] =>
      Array.isArray(v)
        ? (v.filter((x) => typeof x === "string") as string[]).slice(0, 20)
        : [];

    return {
      preferredResponseLength: respLen,
      preferredFormat: format,
      communicationStyle: typeof parsed.communicationStyle === "string" ? parsed.communicationStyle : null,
      peakHours: typeof parsed.peakHours === "string" ? parsed.peakHours : null,
      timezone: typeof parsed.timezone === "string" && parsed.timezone.length > 0
        ? parsed.timezone
        : "America/New_York",
      expertiseAreas: ensureStringArray(parsed.expertiseAreas),
      recurringClients: ensureStringArray(parsed.recurringClients),
      correctionPatterns: ensureStringArray(parsed.correctionPatterns),
    };
  } catch {
    return null;
  }
}
