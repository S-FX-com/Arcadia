// Non-streaming + streaming chat endpoints for the web frontend.
//
//   POST /api/webapp/chat
//     Body: { message: string, scopeType?: string, scopeId?: string }
//     200: { reply: string, model: string, tier: string }
//
//   POST /api/webapp/chat/stream
//     Body: same shape
//     200: text/event-stream of {"type":"text","text":"..."} chunks,
//          terminating with {"type":"done"}.
//
// Both endpoints recall memory ACL-scoped to the session.aadId, then
// run the request through the AI router. Stream uses Anthropic SSE via
// the provider's stream() generator.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { AnthropicProvider } from "../ai/providers/anthropic";
import { injectCharter } from "../charter/inject";
import {
  ClientScopeResolver,
  ClientStore,
  type ClientScope,
} from "../clients";
import { MemoryStore } from "../memory/store";
import type { Scope } from "../memory/types";
import type { Session } from "./auth";

interface ChatRequest {
  message?: unknown;
  scopeType?: unknown;
  scopeId?: unknown;
}

const SYSTEM_PROMPT =
  "You are Arcadia, a Microsoft 365 AI operations layer. Reply in your own voice — direct, specific, no filler. Cite ownership signals when relevant. Use the recalled context only when it actually answers the question.";

const CLIENT_PROMPT_SUFFIX =
  "\n\nThe operator has an active Client selected. When you draw on context, treat that Client's assets — its Teams channels and chats, Planner plans, SharePoint site, Loop workspace, Enque team — as one bundle. Mention assets by name when it sharpens the answer.";

export async function handleChat(
  request: Request,
  env: Env,
  session: Session,
  log: Logger,
): Promise<Response> {
  const parsed = await parseChatBody(request);
  if (!parsed) return Response.json({ error: "bad_body" }, { status: 400 });

  const context = await buildContext(env, parsed, session);
  const router = new Router(env);
  const system = await injectCharter(env, basePrompt(session));
  const reply = await router.complete({
    system,
    messages: [
      ...(context
        ? [{ role: "user" as const, content: `Context:\n${context}` }]
        : []),
      { role: "user" as const, content: parsed.message },
    ],
    maxTokens: 600,
  });

  log.info("webapp_chat", { aadId: session.aadId, tier: reply.tier });
  return Response.json({
    reply: reply.text,
    model: reply.model,
    tier: reply.tier,
  });
}

export async function handleChatStream(
  request: Request,
  env: Env,
  session: Session,
  log: Logger,
): Promise<Response> {
  const parsed = await parseChatBody(request);
  if (!parsed) return Response.json({ error: "bad_body" }, { status: 400 });

  const context = await buildContext(env, parsed, session);
  log.info("webapp_chat_stream", { aadId: session.aadId });

  const provider = new AnthropicProvider(env, "claude-sonnet-4-6");
  const system = await injectCharter(env, basePrompt(session));
  const messages = [
    ...(context
      ? [{ role: "user" as const, content: `Context:\n${context}` }]
      : []),
    { role: "user" as const, content: parsed.message },
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      try {
        const iter = provider.stream({
          system,
          messages,
          maxTokens: 800,
        });
        for await (const chunk of iter) {
          if (chunk.type === "text" && chunk.text) {
            send("text", { text: chunk.text });
          } else if (chunk.type === "done") {
            send("done", {});
          } else if (chunk.type === "error") {
            send("error", { message: chunk.error ?? "stream_error" });
          }
        }
      } catch (e) {
        send("error", { message: String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

interface ParsedChat {
  message: string;
  scopeType?: Scope;
  scopeId?: string;
}

async function parseChatBody(request: Request): Promise<ParsedChat | null> {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return null;
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return null;
  }
  const parsed: ParsedChat = { message: body.message };
  if (typeof body.scopeType === "string" && isScope(body.scopeType)) {
    parsed.scopeType = body.scopeType;
  }
  if (typeof body.scopeId === "string" && body.scopeId.length > 0) {
    parsed.scopeId = body.scopeId;
  }
  return parsed;
}

function isScope(s: string): s is Scope {
  return [
    "tenant",
    "channel",
    "chat",
    "user",
    "project",
    "customer",
  ].includes(s);
}

async function buildContext(
  env: Env,
  req: ParsedChat,
  session: Session,
): Promise<string> {
  const memory = new MemoryStore(env);

  // Explicit scope from the request wins over the session's active
  // Client — the chat UI can pass {scopeType:"channel", scopeId:"…"}
  // to drill into a single asset.
  if (req.scopeType && req.scopeId) {
    const hits = await memory.recall(req.message, {
      limit: 5,
      viewer: session.aadId,
      tenantId: session.tenantId,
      scopeType: req.scopeType,
      scopeId: req.scopeId,
    });
    return hits.map(formatHit).join("\n");
  }

  // Active Client scoping: union recall across the federated asset
  // set, plus the Client-scoped memories themselves. Cap each pass at
  // 5 and dedupe by memory id so the prompt budget stays small.
  if (session.activeClientId) {
    const clientCtx = await buildClientContext(env, memory, req.message, session);
    if (clientCtx !== null) return clientCtx;
  }

  // No scope at all — unfiltered ACL-bound recall.
  const hits = await memory.recall(req.message, {
    limit: 5,
    viewer: session.aadId,
    tenantId: session.tenantId,
  });
  return hits.map(formatHit).join("\n");
}

async function buildClientContext(
  env: Env,
  memory: MemoryStore,
  message: string,
  session: Session,
): Promise<string | null> {
  if (!session.activeClientId) return null;

  const store = new ClientStore(env);
  const client = await store.byId(session.activeClientId);
  if (!client) return null;

  const resolver = new ClientScopeResolver(env);
  const scope = await resolver.resolve(session.activeClientId);

  const sources: { scopeType: Scope; scopeId: string }[] = [
    { scopeType: "customer", scopeId: session.activeClientId },
  ];
  for (const id of scope.channelIds) sources.push({ scopeType: "channel", scopeId: id });
  for (const id of scope.chatIds) sources.push({ scopeType: "chat", scopeId: id });

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const src of sources) {
    const hits = await memory.recall(message, {
      limit: 3,
      viewer: session.aadId,
      tenantId: session.tenantId,
      scopeType: src.scopeType,
      scopeId: src.scopeId,
    });
    for (const h of hits) {
      if (seen.has(h.memory.id)) continue;
      seen.add(h.memory.id);
      merged.push(formatHit(h));
      if (merged.length >= 8) break;
    }
    if (merged.length >= 8) break;
  }

  const header = `Active Client: ${client.displayName} (${client.slug}).
${describeScope(scope)}`;
  if (merged.length === 0) return header;
  return `${header}\n${merged.join("\n")}`;
}

function basePrompt(session: Session): string {
  return session.activeClientId
    ? `${SYSTEM_PROMPT}${CLIENT_PROMPT_SUFFIX}`
    : SYSTEM_PROMPT;
}

function formatHit(h: {
  memory: { kind: string; content: string };
}): string {
  return `(${h.memory.kind}) ${h.memory.content}`;
}

function describeScope(scope: ClientScope): string {
  const parts: string[] = [];
  if (scope.teamIds.length) parts.push(`${scope.teamIds.length} team(s)`);
  if (scope.channelIds.length) parts.push(`${scope.channelIds.length} channel(s)`);
  if (scope.chatIds.length) parts.push(`${scope.chatIds.length} chat(s)`);
  if (scope.plannerPlanIds.length) parts.push(`${scope.plannerPlanIds.length} Planner plan(s)`);
  if (scope.sharepointSiteIds.length) parts.push(`${scope.sharepointSiteIds.length} SharePoint site(s)`);
  if (scope.loopWorkspaceIds.length) parts.push(`${scope.loopWorkspaceIds.length} Loop workspace(s)`);
  if (scope.enqueTeamIds.length) parts.push(`${scope.enqueTeamIds.length} Enque team(s)`);
  return parts.length === 0
    ? "No assets attached yet."
    : `Assets: ${parts.join(", ")}.`;
}
