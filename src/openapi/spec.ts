// Publishes the OpenAPI 3.1 spec for Arcadia's public HTTP API.
//
// This spec is the source of truth for:
//   - The Copilot Connector item adapter (src/openapi/connector.ts)
//   - A future Power Automate custom connector
//   - The MCP tool list (kept in sync with this spec)
//
// Spec entries are added as routes are implemented. This stub returns
// a minimal placeholder so /api/openapi.json is reachable from day one.

import type { Env } from "../env";

export function openApiSpec(_env: Env) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Arcadia",
      version: "2.0.0",
      description: "Microsoft 365 AI operations layer.",
    },
    servers: [{ url: "/api" }],
    paths: {
      "/healthz": {
        get: {
          summary: "Liveness probe",
          responses: { "200": { description: "ok" } },
        },
      },
      "/webapp/health": {
        get: {
          summary: "Web app health",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}
