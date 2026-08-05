// Radar — stall detection sub-agent. Ships in Phase 1b (M1, §4).
//
// Ground-truth signals only — self-reported status is the mechanism that
// already failed. Signals: SharePoint/OneDrive file mtime, Planner task
// transitions, Teams channel velocity, git commit activity, staging HTTP
// diff. Escalation is public at pod level: day 3 DM to the named owner,
// day 5 pod channel naming owner AND lead, day 7 founder digest filed under
// the LEAD's name. The publicness is the mechanism.

import { Agent } from "agents";

export class Radar extends Agent<Env> {
  ping(): string {
    return "ok";
  }

  override async onRequest(_request: Request): Promise<Response> {
    return Response.json(
      { error: "Stall Radar ships in Phase 1b — see CLAUDE.md §4. Blocked on open question §10.1 (where does project work tracking actually live?)" },
      { status: 501 }
    );
  }
}
