// Ask Arcadia as a Cloudflare OS skill.
// Same code path as the dashboard: Cited vs Inferred, labeled answers,
// gap candidates on Inferred operating questions. The bridge only attributes
// the question to the OS-side human and describes the read.

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
  const mode = result.mode === "inferred" ? "Inferred" : "Cited";
  return {
    result,
    observation: {
      title: `Asked Arcadia: "${question.slice(0, 80)}"`,
      description: result.gapId
        ? `${mode} — logged as gap ${result.gapId} (capture channel D)`
        : `${mode} from ${result.citations.length} doctrine entr${result.citations.length === 1 ? "y" : "ies"}: ${result.citations.join(", ") || "none"}`,
    },
  };
}
