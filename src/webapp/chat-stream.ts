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
  const reply = await router.complete({
    system: SYSTEM_PROMPT,
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
  const messages = [
    ...(context
      ? [{ role: "user" as const, content: `Context:\n${context}` }]
      : []),
    { role: "user" as const, content: parsed.message },
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        const iter = provider.stream({
          system: SYSTEM_PROMPT,
          messages,
          maxTokens: 800,
        });
        for await (const chunk of iter) {
          if (chunk.type === "text" && chunk.text) {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`,
              ),
            );
          } else if (chunk.type === "done") {
            controller.enqueue(
              enc.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`),
            );
          } else if (chunk.type === "error") {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ type: "error", error: chunk.error })}\n\n`,
              ),
            );
          }
        }
      } catch (e) {
        const enc2 = new TextEncoder();
        controller.enqueue(
          enc2.encode(
            `data: ${JSON.stringify({ type: "error", error: String(e) })}\n\n`,
          ),
        );
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
  const hits = await memory.recall(req.message, {
    limit: 5,
    viewer: session.aadId,
    tenantId: session.tenantId,
    ...(req.scopeType ? { scopeType: req.scopeType } : {}),
    ...(req.scopeId ? { scopeId: req.scopeId } : {}),
  });
  return hits
    .map((h) => `(${h.memory.kind}) ${h.memory.content}`)
    .join("\n");
}
