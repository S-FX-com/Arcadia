// OpenAPI 3.1 spec for Arcadia's public HTTP API.
//
// Source of truth for:
//   - The Copilot Connector item adapter (src/openapi/connector.ts)
//   - A future Power Automate custom connector
//   - Documentation surfaces (/api/openapi.json)
//
// Routes mirror src/webapp/* (the user-facing surface) plus the
// publicly addressable infrastructure (/api/messages, /api/mcp,
// /api/graph/notify). Internal-only routes (cron, queue consumers)
// are intentionally omitted — they aren't HTTP from the caller's
// perspective.

import type { Env } from "../env";

export function openApiSpec(env: Env) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Arcadia",
      version: "2.0.0",
      description:
        "Microsoft 365 AI operations layer. Memory-driven assistant with strict ACL, Universal Action cards, and a small declarative routine engine.",
      contact: { name: "S-FX", url: "https://s-fx.com" },
    },
    servers: [
      {
        url: "/api",
        description: "This worker (relative)",
      },
    ],
    tags: [
      { name: "Auth", description: "Session + OBO." },
      { name: "Chat", description: "Memory-grounded conversation." },
      { name: "Dashboard", description: "Single-fetch home rollup." },
      { name: "Routines", description: "Declarative automations." },
      { name: "Memory", description: "ACL-filtered memory recall." },
      { name: "Bot", description: "Bot Framework activity endpoint." },
      { name: "MCP", description: "Model Context Protocol surface." },
      { name: "Graph", description: "Change notification webhook." },
      { name: "Agent 365", description: "Tenant governance manifest." },
    ],
    paths: {
      "/webapp/health": {
        get: {
          tags: ["Auth"],
          summary: "Web app liveness",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Health" },
                },
              },
            },
          },
        },
      },
      "/webapp/auth/exchange": {
        post: {
          tags: ["Auth"],
          summary: "Exchange an Entra access token for a session cookie.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["token"],
                  properties: { token: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Session created. Cookie set via Set-Cookie.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      session: { $ref: "#/components/schemas/Session" },
                    },
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/Error" },
            "401": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/webapp/auth/logout": {
        post: {
          tags: ["Auth"],
          summary: "Clear the session cookie.",
          security: [{ sessionCookie: [] }],
          responses: { "204": { description: "Logged out." } },
        },
      },
      "/webapp/me": {
        get: {
          tags: ["Auth"],
          summary: "Current session.",
          security: [{ sessionCookie: [] }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      session: { $ref: "#/components/schemas/Session" },
                    },
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/webapp/chat": {
        post: {
          tags: ["Chat"],
          summary: "Non-streaming chat with memory recall.",
          security: [{ sessionCookie: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Assistant reply.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ChatReply" },
                },
              },
            },
          },
        },
      },
      "/webapp/chat/stream": {
        post: {
          tags: ["Chat"],
          summary: "Server-sent-events chat stream.",
          security: [{ sessionCookie: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatRequest" },
              },
            },
          },
          responses: {
            "200": {
              description:
                "text/event-stream. Named events: text { text }, done {}, error { message }.",
              content: { "text/event-stream": {} },
            },
          },
        },
      },
      "/webapp/dashboard": {
        get: {
          tags: ["Dashboard"],
          summary: "Single-fetch rollup for the dashboard surface.",
          security: [{ sessionCookie: [] }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DashboardData" },
                },
              },
            },
          },
        },
      },
      "/webapp/routines": {
        get: {
          tags: ["Routines"],
          summary: "List routines owned by the caller.",
          security: [{ sessionCookie: [] }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      routines: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Routine" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ["Routines"],
          summary: "Create a routine from a definition.",
          security: [{ sessionCookie: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    definition: { type: "object" },
                    enabled: { type: "boolean", default: true },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      routine: { $ref: "#/components/schemas/Routine" },
                    },
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/webapp/routines/{id}": {
        parameters: [{ $ref: "#/components/parameters/RoutineId" }],
        get: {
          tags: ["Routines"],
          summary: "Fetch a routine.",
          security: [{ sessionCookie: [] }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      routine: { $ref: "#/components/schemas/Routine" },
                    },
                  },
                },
              },
            },
            "404": { $ref: "#/components/responses/Error" },
          },
        },
        patch: {
          tags: ["Routines"],
          summary: "Update routine definition or enabled flag.",
          security: [{ sessionCookie: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    definition: { type: "object" },
                    enabled: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      routine: { $ref: "#/components/schemas/Routine" },
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          tags: ["Routines"],
          summary: "Remove a routine.",
          security: [{ sessionCookie: [] }],
          responses: { "204": { description: "Removed." } },
        },
      },
      "/webapp/routines/{id}/run": {
        parameters: [{ $ref: "#/components/parameters/RoutineId" }],
        post: {
          tags: ["Routines"],
          summary: "Run a routine immediately (manual trigger).",
          security: [{ sessionCookie: [] }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      routineId: { type: "string" },
                      runId: { type: "string" },
                      status: { type: "string", enum: ["succeeded", "failed"] },
                      output: { type: "object" },
                      error: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/webapp/memory": {
        get: {
          tags: ["Memory"],
          summary: "Semantic recall.",
          security: [{ sessionCookie: [] }],
          parameters: [
            {
              name: "query",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "scopeType",
              in: "query",
              schema: { $ref: "#/components/schemas/MemoryScope" },
            },
            { name: "scopeId", in: "query", schema: { type: "string" } },
            {
              name: "kind",
              in: "query",
              schema: { $ref: "#/components/schemas/MemoryKind" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 50 },
            },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      hits: {
                        type: "array",
                        items: { $ref: "#/components/schemas/MemoryHit" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/webapp/memory/recent": {
        get: {
          tags: ["Memory"],
          summary: "Time-ordered recent memories.",
          security: [{ sessionCookie: [] }],
          parameters: [
            {
              name: "scopeType",
              in: "query",
              required: true,
              schema: { $ref: "#/components/schemas/MemoryScope" },
            },
            {
              name: "scopeId",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "kind",
              in: "query",
              schema: { $ref: "#/components/schemas/MemoryKind" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200 },
            },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/webapp/memory/{id}/forget": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        post: {
          tags: ["Memory"],
          summary: "Soft-delete a memory.",
          security: [{ sessionCookie: [] }],
          responses: { "204": { description: "ok" } },
        },
      },
      "/messages": {
        post: {
          tags: ["Bot"],
          summary: "Bot Framework activity ingest (Teams + Webchat).",
          security: [{ botFrameworkJwt: [] }],
          responses: { "200": { description: "ack" } },
        },
      },
      "/mcp": {
        post: {
          tags: ["MCP"],
          summary: "Model Context Protocol JSON-RPC endpoint.",
          responses: { "200": { description: "rpc result" } },
        },
      },
      "/graph/notify": {
        post: {
          tags: ["Graph"],
          summary: "Microsoft Graph change-notification webhook.",
          responses: { "202": { description: "ack" } },
        },
      },
      "/agent365/manifest": {
        get: {
          tags: ["Agent 365"],
          summary: "Tenant-facing capability manifest.",
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": {} },
            },
          },
        },
      },
    },
    components: {
      parameters: {
        RoutineId: {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Routine UUID.",
        },
      },
      responses: {
        Error: {
          description: "Structured error.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string" },
                  detail: { type: "string" },
                },
              },
            },
          },
        },
      },
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "arcadia_session",
          description: "Sealed session issued by /webapp/auth/exchange.",
        },
        botFrameworkJwt: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Bot Framework channel-issued JWT.",
        },
      },
      schemas: {
        Health: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            ts: { type: "string", format: "date-time" },
          },
        },
        Session: {
          type: "object",
          required: ["aadId", "tenantId", "exp"],
          properties: {
            aadId: { type: "string" },
            tenantId: { type: "string" },
            upn: { type: "string" },
            name: { type: "string" },
            exp: { type: "integer" },
          },
        },
        ChatRequest: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string" },
            scopeType: { $ref: "#/components/schemas/MemoryScope" },
            scopeId: { type: "string" },
          },
        },
        ChatReply: {
          type: "object",
          properties: {
            reply: { type: "string" },
            model: { type: "string" },
            tier: { type: "string", enum: ["fast", "balanced", "deep"] },
          },
        },
        DashboardData: {
          type: "object",
          properties: {
            me: { $ref: "#/components/schemas/Session" },
            tasks: {
              type: "object",
              properties: {
                open: { type: "integer" },
                inProgress: { type: "integer" },
                blocked: { type: "integer" },
                total: { type: "integer" },
              },
            },
            dueToday: {
              type: "array",
              items: { $ref: "#/components/schemas/Task" },
            },
            overdue: {
              type: "array",
              items: { $ref: "#/components/schemas/Task" },
            },
            recentDigests: { type: "array" },
            latestBrief: { type: ["object", "null"] },
            activeRoutines: { type: "array" },
          },
        },
        Routine: {
          type: "object",
          properties: {
            id: { type: "string" },
            ownerAadId: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            enabled: { type: "boolean" },
            trigger: { type: "object" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
          },
        },
        Task: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            ownerAadId: { type: "string" },
            deadlineAt: { type: "string" },
            priority: {
              type: "string",
              enum: ["low", "normal", "high", "urgent"],
            },
            status: {
              type: "string",
              enum: ["open", "in_progress", "blocked", "done", "cancelled"],
            },
          },
        },
        MemoryHit: {
          type: "object",
          properties: {
            score: { type: "number" },
            memory: {
              type: "object",
              properties: {
                id: { type: "string" },
                kind: { $ref: "#/components/schemas/MemoryKind" },
                scopeType: { $ref: "#/components/schemas/MemoryScope" },
                scopeId: { type: "string" },
                content: { type: "string" },
                subjectAadId: { type: "string" },
                occurredAt: { type: "string" },
                createdAt: { type: "string" },
              },
            },
          },
        },
        MemoryKind: {
          type: "string",
          enum: ["episodic", "semantic", "procedural", "observation"],
        },
        MemoryScope: {
          type: "string",
          enum: ["tenant", "channel", "chat", "user", "project", "customer"],
        },
      },
    },
    "x-arcadia": {
      agent365AgentId: env.AGENT_365_AGENT_ID ?? null,
      mcpEndpoint: "/api/mcp",
      botEndpoint: "/api/messages",
    },
  };
}
