// Ask Arcadia as a Cloudflare OS skill (integration plan, workstream B).
// Same code path as the dashboard surface — the Arcadia agent recalls from
// canonical only, answers with citations, and below the confidence floor
// escalates into the gap queue instead of inventing a Shane opinion (§5.6.7).
// The bridge adds nothing to that behavior; it only attributes the question
// to the OS-side human and describes the read for observation logging.

import { getAgentByName } from "agents";
import type { AskResult } from "../agents/arcadia";
import type { ObservationDescription } from "../gatekeepers/types";

export async function askArcadia(
  env: Env,
  question: string,
  askedBy: string
): Promise<{ result: AskResult; observation: ObservationDescription }> {
  const arcadia = await getAgentByName(env.Arcadia, "main");
  const result = await arcadia.ask(question, askedBy);
  return {
    result,
    observation: {
      title: `Asked Arcadia: "${question.slice(0, 80)}"`,
      description: result.escalated
        ? `No confident doctrine — escalated to gap ${result.gapId ?? "?"} for Shane (capture channel D)`
        : `Answered from ${result.citations.length} doctrine entr${result.citations.length === 1 ? "y" : "ies"}: ${result.citations.join(", ")}`,
    },
  };
}
