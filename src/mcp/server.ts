// Arcadia-as-MCP-server.
//
// Exposes Arcadia's tool surface (summarize_thread, find_owner,
// list_stale_threads, recall_memory, query_customer, assign_task,
// query_routines, draft_message) to any MCP client: Claude Desktop,
// Microsoft 365 Copilot, Foundry agents, Copilot Studio agents.
//
// Transport: streamable HTTP with SSE for tool calls.
// Real implementation lands in the MCP commit.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";

export async function handleMcp(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
  log: Logger,
): Promise<Response> {
  log.warn("mcp_unimplemented");
  return new Response("not implemented", { status: 501 });
}
