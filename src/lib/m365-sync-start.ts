// Start a repository sync without waiting for Microsoft 365 when the agent
// can take the job. The schedule call returns once the alarm is stored.
// If that call cannot be made, the sync runs inline so the page still fills.

import { getAgentByName } from "agents";
import type { Arcadia } from "../agents/arcadia";

export async function startM365Job(
  env: Env,
  job: "directory" | "plans",
  inline: () => Promise<void>
): Promise<"scheduled" | "inline"> {
  try {
    if (!env.Arcadia) throw new Error("Arcadia agent is not bound");
    const agent = await getAgentByName<Env, Arcadia>(env.Arcadia, "main");
    await agent.kickRepositorySync(job);
    return "scheduled";
  } catch (err) {
    console.error("m365 sync schedule", err);
    await inline();
    return "inline";
  }
}
