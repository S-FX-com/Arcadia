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

import type { JWTVerifyGetKey } from "jose";
import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { readSession } from "../webapp/auth";
import { verifyEntraToken } from "../lib/entra-verify";
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
  status = 200,
): Response {
  return jsonResponse(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, data },
    },
    status,
  );
}

export interface HandleMcpOptions {
  /** Test seam: local key resolver threaded into verifyEntraToken. */
  keyResolver?: JWTVerifyGetKey;
}

interface Caller {
  aadId: string;
  tenantId: string;
  isAdmin: boolean;
}

async function callerIsAdmin(env: Env, aadId: string): Promise<boolean> {
  if (env.ADMIN_USER_AAD_ID && aadId === env.ADMIN_USER_AAD_ID) return true;
  const row = await env.ARCADIA_DB.prepare(
    `SELECT is_admin FROM users WHERE aad_id = ?`,
  )
    .bind(aadId)
    .first<{ is_admin: number }>();
  return row?.is_admin === 1;
}

/**
 * Resolve the caller identity from EITHER the sealed session cookie OR a
 * verified Entra bearer token. Returns null when neither establishes a
 * real identity — the endpoint then answers 401.
 */
async function resolveCaller(
  request: Request,
  env: Env,
  log: Logger,
  opts: HandleMcpOptions,
): Promise<Caller | null> {
  const session = await readSession(env, request);
  if (session) {
    return {
      aadId: session.aadId,
      tenantId: session.tenantId,
      isAdmin: await callerIsAdmin(env, session.aadId),
    };
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    try {
      const verified = await verifyEntraToken(
        env,
        token,
        opts.keyResolver ? { keyResolver: opts.keyResolver } : {},
      );
      return {
        aadId: verified.aadId,
        tenantId: verified.tenantId,
        isAdmin: await callerIsAdmin(env, verified.aadId),
      };
    } catch (e) {
      log.warn("mcp_bearer_rejected", { error: String(e) });
      return null;
    }
  }

  return null;
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  log: Logger,
  opts: HandleMcpOptions = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const caller = await resolveCaller(request, env, log, opts);
  if (!caller) {
    return errorResponse(null, -32001, "unauthorized", undefined, 401);
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
          { env, ctx, log, caller },
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
