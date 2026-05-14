// Arcadia-as-MCP-server.
//
// Implements the MCP JSON-RPC protocol over HTTP. Exposes Arcadia's
// tool surface (memory recall, thread summarization, owner lookup,
// task assignment, routines, message drafting) to any MCP client:
// Claude Desktop, Microsoft 365 Copilot, Foundry agents, Copilot Studio
// agents.
//
// Transport: streamable HTTP — each request is a JSON-RPC envelope.
// SSE response streaming will land when individual tools start to
// stream their output.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { tools } from "./tools";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SERVER_INFO = { name: "arcadia", version: "2.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

function jsonResponse(payload: JsonRpcResponse, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, data },
  });
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  log: Logger,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let req: JsonRpcRequest;
  try {
    req = (await request.json()) as JsonRpcRequest;
  } catch {
    return errorResponse(null, -32700, "parse_error");
  }

  log.info("mcp_request", { method: req.method, id: req.id });

  switch (req.method) {
    case "initialize":
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });

    case "tools/list":
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });

    case "tools/call": {
      const params = req.params as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const name = params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return errorResponse(req.id, -32601, `unknown_tool: ${name}`);
      }
      try {
        const result = await tool.handler(
          { env, ctx, log },
          params?.arguments ?? {},
        );
        return jsonResponse({
          jsonrpc: "2.0",
          id: req.id ?? null,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: false,
          },
        });
      } catch (e) {
        log.error("mcp_tool_failed", { tool: name, error: String(e) });
        return jsonResponse({
          jsonrpc: "2.0",
          id: req.id ?? null,
          result: {
            content: [{ type: "text", text: String(e) }],
            isError: true,
          },
        });
      }
    }

    case "ping":
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {},
      });

    default:
      return errorResponse(
        req.id,
        -32601,
        `method_not_found: ${req.method}`,
      );
  }
}
