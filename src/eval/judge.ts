// LLM judge.
//
// Asks the deep tier (Sonnet) to score an assistant reply against the
// case's expected-points checklist. The prompt is `evals/judge-prompt.md`
// — kept verbatim so a separate review can adjust the scoring rubric
// without touching code.

import type { Env } from "../env";
import { Router } from "../ai/router";
import type { JudgeVerdict } from "./types";

const SYSTEM_PROMPT = `You are a strict but fair grader of an internal AI assistant's answers.

You will be given:
1. The user's question.
2. An "expected answer" — the high-level points a correct response MUST cover. Wording does not need to match; only meaning.
3. The assistant's actual answer.

Score the actual answer 0.0–1.0:
- 1.0 — covers every expected point clearly and adds no factually wrong claims.
- 0.7–0.9 — covers most expected points; minor gaps or paraphrase weaker than ideal.
- 0.4–0.6 — partially correct; missing important expected points or includes unrelated material.
- 0.0–0.3 — wrong, evasive, or contradicts the expected answer.

Output STRICT JSON only:
{ "score": <0.0-1.0>, "rationale": "<one or two sentences explaining the score>" }`;

export async function judge(
  env: Env,
  prompt: string,
  expected: string,
  reply: string,
): Promise<JudgeVerdict> {
  const router = new Router(env);
  const result = await router.complete({
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Question:\n${prompt}\n\nExpected:\n${expected}\n\nActual:\n${reply}`,
      },
    ],
    tier: "deep",
    temperature: 0,
    maxTokens: 400,
  });
  return parseVerdict(result.text);
}

function parseVerdict(text: string): JudgeVerdict {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { score: 0, rationale: "judge_unparsable" };
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
      score?: unknown;
      rationale?: unknown;
    };
    const score =
      typeof parsed.score === "number"
        ? Math.max(0, Math.min(1, parsed.score))
        : 0;
    const rationale =
      typeof parsed.rationale === "string"
        ? parsed.rationale.slice(0, 400)
        : "no_rationale";
    return { score, rationale };
  } catch {
    return { score: 0, rationale: "judge_parse_error" };
  }
}
