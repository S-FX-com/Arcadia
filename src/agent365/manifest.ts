// Agent 365 capability manifest.
//
// Published at GET /api/agent365/manifest so tenant Agent 365
// administrators can register Arcadia, assign her an Entra Agent ID,
// and apply identity / governance / observability policies.
//
// Real manifest fills in capabilities, dependencies, and tool surface
// once those modules land.

import type { Env } from "../env";

export function agent365Manifest(env: Env) {
  return {
    schemaVersion: "1.0",
    agent: {
      id: env.AGENT_365_AGENT_ID ?? "arcadia",
      name: "Arcadia",
      description: "Microsoft 365 AI operations layer for staff.",
      vendor: "S-FX.com",
      version: "2.0.0",
    },
    capabilities: [],
    dependencies: {
      graph: [
        "ChannelMessage.Read.All",
        "User.Read.All",
        "Sites.Read.All",
        "Calendars.Read.All",
        "Mail.Read.All",
        "Presence.Read.All",
      ],
      mcpServer: "/api/mcp",
      anthropic: true,
    },
  };
}
