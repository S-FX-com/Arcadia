// Weekly self-model (SOUL.md §Heartbeat + §Consolidation).
//
// "Weekly, she updates her self-model: a procedural memory that captures
//  what she has learned about this team, how they work, and where she
//  should focus. It is replaced each week with a more refined version."
//
// The self-model is a single ACTIVE procedural memory (kind='procedural',
// scope tenant, source_resource_type='self_model'). Each regeneration
// reads the week's high-signal memories, asks the deep tier to distil a
// concise self-model, RETIRES the previous active row, and writes the new
// one — so there is exactly one active self-model at any time.
//
// Retirement note: we do NOT retire via `expires_at`. The light
// consolidation cycle hard-DELETEs rows whose expires_at is in the past
// (MemoryStore.prune), which would destroy the history SOUL.md wants kept.
// Instead we re-tag the superseded row's source_resource_type to
// 'self_model_superseded'. It stays in the table (retrievable), and
// current() only ever returns the single 'self_model'-tagged row.
//
// Persistence goes through raw D1 (not MemoryStore.add) — the same pattern
// customer profiles use (src/memory/profiles.ts): these rows are looked up
// by an exact source_resource_type marker, not by vector similarity, so
// they are deliberately not Vectorize-indexed (and are therefore testable
// under miniflare, which cannot simulate Vectorize / Workers AI).
//
// Injection note (P4 close-out): inject() is exposed + unit-tested here but
// is intentionally NOT wired into the shared prompt builders
// (activity-handler / chat-stream). P4a adds injectProcedures to prompt
// assembly; the orchestrator wires self-model + procedures together after
// both land, to avoid a merge collision.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import type { CompleteRequest, CompleteResponse } from "../ai/types";
import { injectCharter } from "../charter/inject";

const SOURCE_ACTIVE = "self_model";
const SOURCE_SUPERSEDED = "self_model_superseded";
const WINDOW_DAYS = 7;
const MAX_INPUT_MEMORIES = 60;

const SYSTEM_PROMPT = `You are Arcadia, writing your own self-model: a concise, procedural note capturing what you have learned about THIS team and your role serving them.

You receive a sample of the week's higher-signal memories (semantic facts and behavioural observations). From them, write a tight self-model covering, only where the evidence supports it:
- What this team is working on and what matters most to them right now.
- Who drives what (roles, decision-makers, rhythms).
- Where you should focus to be most useful.
- An honest read on your own effectiveness — where you are helping, where you are not.

Rules:
- Write in your own voice, first person, as durable process knowledge ("This team...", "I should...").
- Be concrete and specific; name people and workstreams when the evidence names them.
- Do not invent facts not supported by the memories. Where you are inferring, say so.
- No preamble, no headings, no JSON. Return the self-model prose only, under 250 words.`;

export interface SelfModelDeps {
  /** Injectable router seam — tests pass a fake to avoid a live provider. */
  router?: Pick<Router, "complete">;
  /** Tenant scope id. Defaults to env.GRAPH_TENANT_ID. */
  tenantId?: string;
}

export interface RegenerateResult {
  regenerated: boolean;
  supersededCount: number;
  id?: string;
}

interface InputRow {
  content: string;
  kind: string;
  confidence: number;
}

/**
 * Weekly self-model lifecycle. Static methods so cron paths can call
 * `SelfModel.regenerate(env, log)` directly.
 */
export class SelfModel {
  /**
   * Rebuild the active self-model from the week's high-signal memories.
   * Returns { regenerated:false } when there is nothing to build from (the
   * prior active model, if any, is left untouched).
   */
  static async regenerate(
    env: Env,
    log: Logger,
    deps?: SelfModelDeps,
  ): Promise<RegenerateResult> {
    const router = deps?.router ?? new Router(env);
    const tenantId = deps?.tenantId ?? env.GRAPH_TENANT_ID;
    const nowIso = new Date().toISOString();
    const since = new Date(
      Date.now() - WINDOW_DAYS * 24 * 3600 * 1000,
    ).toISOString();

    // Read the week's higher-signal cross-scope memories. Arcadia is
    // single-tenant per deployment, so "across the tenant" == all memories.
    const rows = await env.ARCADIA_DB.prepare(
      `SELECT content, kind, confidence
         FROM memories
        WHERE kind IN ('semantic','observation')
          AND created_at >= ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY confidence DESC, created_at DESC
        LIMIT ?`,
    )
      .bind(since, nowIso, MAX_INPUT_MEMORIES)
      .all<InputRow>();

    if (rows.results.length === 0) {
      log.info("self_model_skipped", { reason: "no_material", tenantId });
      return { regenerated: false, supersededCount: 0 };
    }

    const block = rows.results
      .map((r) => `- (${r.kind}, conf ${r.confidence.toFixed(2)}) ${r.content}`)
      .join("\n");

    let text: string;
    try {
      const system = await injectCharter(env, SYSTEM_PROMPT);
      const req: CompleteRequest = {
        system,
        messages: [
          {
            role: "user",
            content: `This week's memories:\n\n${block}`,
          },
        ],
        tier: "deep",
        maxTokens: 700,
        temperature: 0.2,
      };
      const reply: CompleteResponse = await router.complete(req);
      text = reply.text.trim();
    } catch (e) {
      log.warn("self_model_router_failed", { error: String(e), tenantId });
      return { regenerated: false, supersededCount: 0 };
    }

    if (text.length === 0) {
      log.warn("self_model_empty", { tenantId });
      return { regenerated: false, supersededCount: 0 };
    }

    // Retire the previous active self-model(s) by re-tagging — never via
    // expires_at, which prune() would hard-delete (history must survive).
    const superseded = await env.ARCADIA_DB.prepare(
      `UPDATE memories
          SET source_resource_type = ?, updated_at = ?
        WHERE scope_type = 'tenant' AND scope_id = ?
          AND source_resource_type = ?`,
    )
      .bind(SOURCE_SUPERSEDED, nowIso, tenantId, SOURCE_ACTIVE)
      .run();

    const id = crypto.randomUUID();
    await env.ARCADIA_DB.prepare(
      `INSERT INTO memories
         (id, kind, scope_type, scope_id, content, source_resource_type,
          confidence, occurred_at, created_at, updated_at)
       VALUES (?, 'procedural', 'tenant', ?, ?, ?, 1.0, ?, ?, ?)`,
    )
      .bind(id, tenantId, text, SOURCE_ACTIVE, nowIso, nowIso, nowIso)
      .run();

    const supersededCount = superseded.meta.changes ?? 0;
    log.info("self_model_regenerated", {
      tenantId,
      id,
      supersededCount,
      inputMemories: rows.results.length,
    });
    return { regenerated: true, supersededCount, id };
  }

  /** The active self-model text, or null if none has been generated. */
  static async current(env: Env, deps?: SelfModelDeps): Promise<string | null> {
    const tenantId = deps?.tenantId ?? env.GRAPH_TENANT_ID;
    const row = await env.ARCADIA_DB.prepare(
      `SELECT content FROM memories
        WHERE scope_type = 'tenant' AND scope_id = ?
          AND source_resource_type = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC
        LIMIT 1`,
    )
      .bind(tenantId, SOURCE_ACTIVE, new Date().toISOString())
      .first<{ content: string }>();
    return row?.content ?? null;
  }

  /**
   * Returns `base` with the active self-model prepended as a
   * "What I've learned about this team:" block (mirrors injectCharter).
   * If no self-model exists, returns `base` unchanged.
   */
  static async inject(
    env: Env,
    base: string,
    deps?: SelfModelDeps,
  ): Promise<string> {
    const body = await SelfModel.current(env, deps);
    if (!body) return base;
    return `${preamble(body)}\n\n${base}`;
  }
}

function preamble(body: string): string {
  return `What I've learned about this team:\n${body.trim()}`;
}
