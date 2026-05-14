// Agent 365 capability manifest.
//
// Published at GET /api/agent365/manifest. Agent 365 administrators
// in the tenant read this manifest to:
//   - Register Arcadia and mint her an Entra Agent identity.
//   - Apply governance / observability / DLP policies.
//   - Surface her capabilities + dependencies into the tenant catalogue.
//
// The manifest is intentionally pure JSON — Agent 365 doesn't poll the
// runtime, it ingests the document. Fields below mirror what the
// platform documents as the manifest contract; we publish stable
// shapes that map to the actual module surface in src/*.

import type { Env } from "../env";

export function agent365Manifest(env: Env) {
  return {
    schemaVersion: "1.0",
    agent: {
      id: env.AGENT_365_AGENT_ID ?? "arcadia",
      name: "Arcadia",
      description:
        "Microsoft 365 AI operations layer. Memory-driven assistant " +
        "with strict ACL, Universal Action cards, and a declarative " +
        "routine engine.",
      vendor: "S-FX.com",
      version: "2.0.0",
      icon: "/static/arcadia.png",
      surface: ["teams_bot", "web_app", "mcp_server", "copilot_connector"],
    },

    identity: {
      // The webapp's Entra app (delegated). Used for NAA + OBO + MGT.
      delegated: {
        appId: env.WEBAPP_CLIENT_ID,
        redirectUris: ["/api/webapp/auth/exchange"],
        scopes: [
          "openid",
          "profile",
          "offline_access",
          "User.Read",
          "People.Read",
          "Calendars.Read",
          "Files.Read.All",
          "Sites.Read.All",
          "ChannelMessage.Read",
          "ChannelMessage.Send",
          "Chat.ReadWrite",
        ],
      },
      // The Graph app-only registration. Used for cron-driven Graph reads.
      appOnly: {
        appId: env.GRAPH_CLIENT_ID,
        tenantId: env.GRAPH_TENANT_ID,
      },
      // The Bot Framework registration. Used by /api/messages.
      bot: {
        appId: env.TEAMS_APP_ID,
        channels: ["msteams", "webchat"],
      },
    },

    capabilities: [
      {
        id: "chat",
        name: "Conversational answers",
        kind: "chat",
        description: "Memory-grounded answers with strict ACL recall.",
        endpoints: [
          "POST /api/messages",
          "POST /api/webapp/chat",
          "POST /api/webapp/chat/stream",
        ],
      },
      {
        id: "intelligence",
        name: "Always-on intelligence",
        kind: "scheduled",
        description:
          "Daily digest, stale-thread detection, at-risk nudges, " +
          "morning + evening briefs, weekly operational roll-up.",
        cron: [
          "0 8 * * *",
          "0 8 * * 1",
          "0 12 * * 1-5",
          "0 21 * * 1-5",
        ],
      },
      {
        id: "tasks",
        name: "Task tracking + Planner sync",
        kind: "data",
        description:
          "Tasks with append-only ownership history. Bi-directional " +
          "Microsoft Planner sync.",
        endpoints: ["/api/webapp/dashboard", "/api/webapp/routines/{id}/run"],
      },
      {
        id: "routines",
        name: "Declarative routine engine",
        kind: "automation",
        description:
          "User-defined workflows: cron / event / manual triggers; " +
          "step kinds = recall_memory | ai_complete | tool_call | " +
          "post_text | create_task.",
        endpoints: [
          "GET /api/webapp/routines",
          "POST /api/webapp/routines",
          "POST /api/webapp/routines/{id}/run",
        ],
      },
      {
        id: "mcp",
        name: "Model Context Protocol surface",
        kind: "tool_server",
        description:
          "Arcadia-as-MCP-server. Tool surface available to Claude " +
          "Desktop, Copilot, Foundry, Copilot Studio.",
        endpoint: "POST /api/mcp",
        tools: [
          "summarize_thread",
          "recall_memory",
          "draft_message",
          "find_owner",
          "list_stale_threads",
          "query_customer",
          "assign_task",
          "query_routines",
        ],
      },
      {
        id: "copilot_connector",
        name: "Microsoft Search ingestion",
        kind: "ingestion",
        description:
          "Publishes digests, tasks, briefs, memories, and ownership " +
          "events as Connector items with ACL-faithful permissions.",
        schemes: ["task", "digest", "brief", "memory", "ownership_event"],
      },
    ],

    governance: {
      memory: {
        strictAcl: true,
        sensitivityLabelsHonoured: true,
        labelPolicy: ["public", "restricted", "confidential", "redact"],
        retentionPolicy: "soft-delete via memories.expires_at; prune cron",
      },
      data: {
        regions: ["cloudflare:auto"],
        storage: [
          "Cloudflare D1 (durable)",
          "Cloudflare KV (ephemeral)",
          "Cloudflare Vectorize (embeddings)",
          "Cloudflare Queues (ingest)",
        ],
        pii: "treated as restricted by default; redacted at recall if labelled",
      },
      observability: {
        logFormat: "newline-delimited JSON",
        cron: "logged per-step with safe() wrapper",
        feedbackLoop: "feedback table — positive/negative/correction",
      },
    },

    dependencies: {
      graph: {
        appOnly: [
          "ChannelMessage.Read.All",
          "Chat.Read.All",
          "User.Read.All",
          "Group.Read.All",
          "Sites.Read.All",
          "Calendars.Read.All",
          "Mail.Read.All",
          "Presence.Read.All",
          "Tasks.ReadWrite.All",
        ],
        delegated: [
          "User.Read",
          "People.Read",
          "Calendars.Read",
          "Files.Read.All",
          "Chat.ReadWrite",
          "ChannelMessage.Send",
        ],
        subscriptions: {
          notificationUrl: "/api/graph/notify",
          clientStateHmac: true,
        },
      },
      ai: {
        providers: [
          { id: "anthropic", model: "claude-haiku-4-5-20251001", tier: "balanced" },
          { id: "anthropic", model: "claude-sonnet-4-6", tier: "deep" },
          { id: "cloudflare", model: env.CF_AI_DEFAULT_MODEL, tier: "fast" },
        ],
        gateway: env.AI_GATEWAY_ID ?? null,
      },
      mcp: { endpoint: "/api/mcp" },
    },

    surfaces: {
      teams: { messageEndpoint: "/api/messages" },
      web: { baseUrl: "/" },
      copilotConnector: { itemEndpoint: "see src/openapi/connector.ts" },
    },

    contact: {
      operator: env.ADMIN_USER_AAD_ID ?? null,
      docs: "/api/openapi.json",
    },
  };
}
