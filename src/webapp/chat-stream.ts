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
import type { CompleteRequest, StreamChunk } from "../ai/types";
import { injectCharter } from "../charter/inject";
import {
  ClientScopeResolver,
  ClientStore,
  type ClientScope,
} from "../clients";
import {
  delegatedGraphToken as defaultDelegatedGraphToken,
  resolveDelegated as defaultResolveDelegated,
  type DelegatedIdentity,
  type ResolveDelegatedOptions,
} from "../graph/delegated";
import {
  microsoftSearch as defaultMicrosoftSearch,
  type MicrosoftSearchOptions,
  type SearchResultItem,
} from "../graph/search";
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

// ---------------------------------------------------------------------------
// Injectable seam — mirrors SearchDeps in search-api.ts. Integration tests
// substitute a stubbed delegated-auth + Microsoft Search + streamer so no
// live Entra tenant, Graph, or Anthropic endpoint is touched, and so the
// assembled prompt can be captured.
// ---------------------------------------------------------------------------

/** Minimal streaming provider surface used by handleChatStream. */
export interface ChatStreamer {
  stream(req: CompleteRequest): AsyncIterable<StreamChunk>;
}

export interface ChatStreamDeps {
  resolveDelegated: (
    env: Env,
    request: Request,
    opts?: ResolveDelegatedOptions,
  ) => Promise<DelegatedIdentity>;
  delegatedGraphToken: (env: Env, userToken: string) => Promise<string>;
  microsoftSearch: (
    env: Env,
    oboToken: string,
    query: string,
    opts?: MicrosoftSearchOptions,
  ) => Promise<SearchResultItem[]>;
  createStreamer: (env: Env) => ChatStreamer;
  createMemoryStore: (env: Env) => MemoryStore;
}

export const defaultChatStreamDeps: ChatStreamDeps = {
  resolveDelegated: defaultResolveDelegated,
  delegatedGraphToken: defaultDelegatedGraphToken,
  microsoftSearch: defaultMicrosoftSearch,
  createStreamer: (env) => new AnthropicProvider(env, "claude-sonnet-4-6"),
  createMemoryStore: (env) => new MemoryStore(env),
};

export async function handleChat(
  request: Request,
  env: Env,
  session: Session,
  log: Logger,
  deps: ChatStreamDeps = defaultChatStreamDeps,
): Promise<Response> {
  const parsed = await parseChatBody(request);
  if (!parsed) return Response.json({ error: "bad_body" }, { status: 400 });

  const context = await assembleContext(env, request, parsed, session, log, deps);
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
  deps: ChatStreamDeps = defaultChatStreamDeps,
): Promise<Response> {
  const parsed = await parseChatBody(request);
  if (!parsed) return Response.json({ error: "bad_body" }, { status: 400 });

  const context = await assembleContext(env, request, parsed, session, log, deps);
  log.info("webapp_chat_stream", { aadId: session.aadId });

  const provider = deps.createStreamer(env);
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

/**
 * Assemble the full recall context handed to the model: Arcadia's own
 * ACL-bound vector recall, plus — when the request carries a delegated
 * `x-graph-token` (P3 item 3) — a clearly delimited "Live Microsoft 365
 * search results" section from Graph, security-trimmed to the signed-in
 * user. The live hop is best-effort: any OBO/search failure degrades to
 * memory-only rather than breaking chat.
 */
async function assembleContext(
  env: Env,
  request: Request,
  parsed: ParsedChat,
  session: Session,
  log: Logger,
  deps: ChatStreamDeps,
): Promise<string> {
  const memory = deps.createMemoryStore(env);
  const memoryContext = await buildContext(env, memory, parsed, session);
  const liveContext = await liveSearchContext(
    env,
    request,
    parsed.message,
    session,
    log,
    deps,
  );

  const sections: string[] = [];
  if (memoryContext) sections.push(`Recalled memory:\n${memoryContext}`);
  if (liveContext) sections.push(liveContext);
  return sections.join("\n\n");
}

/**
 * Best-effort Microsoft Search recall. Returns "" (memory-only) when no
 * `x-graph-token` is present, when the token identity doesn't match the
 * session, when there are no hits, or on any OBO/search failure — never
 * throws, so the SSE contract and chat itself stay intact.
 */
async function liveSearchContext(
  env: Env,
  request: Request,
  message: string,
  session: Session,
  log: Logger,
  deps: ChatStreamDeps,
): Promise<string> {
  // No delegated token — behave exactly as before (memory-only).
  if (!request.headers.get("x-graph-token")) return "";

  try {
    const identity = await deps.resolveDelegated(env, request);
    // A caller can't pair their session cookie with someone else's Graph
    // token to pivot into that user's Graph-trimmed results — same guard as
    // the standalone /search endpoint, but here we degrade instead of 403.
    if (identity.aadId !== session.aadId) {
      log.warn("webapp_chat_search_identity_mismatch", {
        sessionAadId: session.aadId,
        tokenAadId: identity.aadId,
      });
      return "";
    }

    const oboToken = await deps.delegatedGraphToken(env, identity.userToken);
    const hits = await deps.microsoftSearch(env, oboToken, message);
    if (hits.length === 0) return "";

    log.info("webapp_chat_search", {
      aadId: session.aadId,
      hits: hits.length,
    });
    return `Live Microsoft 365 search results:\n${hits
      .map(formatSearchHit)
      .join("\n")}`;
  } catch (e) {
    log.warn("webapp_chat_search_failed", {
      error: String(e),
      aadId: session.aadId,
    });
    return "";
  }
}

function formatSearchHit(item: SearchResultItem): string {
  const title = item.title ?? "(untitled)";
  const summary = item.summary ? ` — ${item.summary}` : "";
  const url = item.webUrl ? ` (${item.webUrl})` : "";
  return `- [${item.type}] ${title}${summary}${url}`;
}

async function buildContext(
  env: Env,
  memory: MemoryStore,
  req: ParsedChat,
  session: Session,
): Promise<string> {
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
