// Memory consolidation cycles.
//
// Inspired by the human light / deep / REM model:
//
//   light  — every 15 minutes. Cheap. Prune expired memories +
//            dedupe near-identical recent memories within the same
//            scope.
//
//   deep   — daily. For each "hot" scope (channel with recent
//            activity), pulls 30 most-recent episodic memories and
//            asks the AI router to distill them into higher-confidence
//            semantic memories. Originating episodics are linked to
//            the new semantic memory via memory_edges of kind
//            'derived_from'.
//
//   rem    — weekly. Samples ~50 weakly-linked memories and asks the
//            deep tier for refines / contradicts / supersedes /
//            supports pairings, persisting them as edges.
//
// Per-cycle errors are bounded with try/catch so one bad scope never
// aborts the rest.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { MemoryStore } from "./store";
import { ProcedureStore } from "./procedures";
import { runFeedbackConsolidation } from "./feedback";
import type { Kind, Scope } from "./types";

export type Cycle = "light" | "deep" | "rem";

export interface ConsolidationResult {
  cycle: Cycle;
  scopesScanned: number;
  duplicatesMerged: number;
  expiredPruned: number;
  semanticDerived: number;
  remLinksCreated: number;
  proceduresPromoted: number;
  proceduresRetired: number;
  feedbackProcessed: number;
  failures: number;
}

export async function consolidate(
  env: Env,
  cycle: Cycle,
  log: Logger,
  router?: Router,
): Promise<ConsolidationResult> {
  switch (cycle) {
    case "light":
      return runLight(env, log);
    case "deep":
      return runDeep(env, log, router);
    case "rem":
      return runRem(env, log, router);
  }
}

// ---------------------------------------------------------------------------
// Light cycle
// ---------------------------------------------------------------------------

interface ScopeRow {
  scope_type: string;
  scope_id: string;
}

interface MemoryRow {
  id: string;
  content: string;
}

async function runLight(
  env: Env,
  log: Logger,
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    cycle: "light",
    scopesScanned: 0,
    duplicatesMerged: 0,
    expiredPruned: 0,
    semanticDerived: 0,
    remLinksCreated: 0,
    proceduresPromoted: 0,
    proceduresRetired: 0,
    feedbackProcessed: 0,
    failures: 0,
  };

  try {
    const store = new MemoryStore(env);
    result.expiredPruned = await store.prune();
  } catch (e) {
    result.failures += 1;
    log.warn("light_prune_failed", { error: String(e) });
  }

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const scopes = await env.ARCADIA_DB.prepare(
    `SELECT DISTINCT scope_type, scope_id FROM memories
      WHERE created_at >= ?`,
  )
    .bind(since)
    .all<ScopeRow>();

  for (const s of scopes.results) {
    result.scopesScanned += 1;
    try {
      const merged = await dedupeScope(env, s.scope_type, s.scope_id, since);
      result.duplicatesMerged += merged;
    } catch (e) {
      result.failures += 1;
      log.warn("light_dedupe_failed", {
        scopeType: s.scope_type,
        scopeId: s.scope_id,
        error: String(e),
      });
    }
  }

  log.info("memory_consolidation", { ...result });
  return result;
}

async function dedupeScope(
  env: Env,
  scopeType: string,
  scopeId: string,
  since: string,
): Promise<number> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT id, content FROM memories
      WHERE scope_type = ? AND scope_id = ?
        AND created_at >= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at ASC`,
  )
    .bind(scopeType, scopeId, since, new Date().toISOString())
    .all<MemoryRow>();

  if (rows.results.length < 2) return 0;

  const byKey = new Map<string, MemoryRow>();
  const drops: MemoryRow[] = [];
  for (const r of rows.results) {
    const key = normalise(r.content);
    if (key.length < 20) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      continue;
    }
    drops.push(r);
  }
  if (drops.length === 0) return 0;

  const store = new MemoryStore(env);
  for (const d of drops) {
    await store.forget(d.id);
  }
  return drops.length;
}

function normalise(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Deep cycle
// ---------------------------------------------------------------------------

const DEEP_SCOPES_PER_RUN = 5;
const DEEP_MEMORIES_PER_SCOPE = 30;

async function runDeep(
  env: Env,
  log: Logger,
  injectedRouter?: Router,
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    cycle: "deep",
    scopesScanned: 0,
    duplicatesMerged: 0,
    expiredPruned: 0,
    semanticDerived: 0,
    remLinksCreated: 0,
    proceduresPromoted: 0,
    proceduresRetired: 0,
    feedbackProcessed: 0,
    failures: 0,
  };

  const sevenDays = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const scopes = await env.ARCADIA_DB.prepare(
    `SELECT scope_type, scope_id, COUNT(*) AS n
       FROM memories
      WHERE created_at >= ?
        AND kind = 'episodic'
        AND (expires_at IS NULL OR expires_at > ?)
      GROUP BY scope_type, scope_id
      HAVING n >= 5
      ORDER BY n DESC
      LIMIT ?`,
  )
    .bind(sevenDays, new Date().toISOString(), DEEP_SCOPES_PER_RUN)
    .all<ScopeRow & { n: number }>();

  const router = injectedRouter ?? new Router(env);
  const store = new MemoryStore(env);

  for (const s of scopes.results) {
    result.scopesScanned += 1;
    try {
      const created = await distillScope(
        router,
        store,
        s.scope_type as Scope,
        s.scope_id,
        log,
      );
      result.semanticDerived += created;
    } catch (e) {
      result.failures += 1;
      log.warn("deep_distill_failed", {
        scopeType: s.scope_type,
        scopeId: s.scope_id,
        error: String(e),
      });
    }
  }

  // Phase 4: consume feedback + promote/retire procedures. Each stage is
  // isolated so one failure never aborts the nightly consolidation.
  try {
    const fb = await runFeedbackConsolidation(env, log);
    result.feedbackProcessed = fb.processed;
  } catch (e) {
    result.failures += 1;
    log.warn("feedback_consolidation_failed", { error: String(e) });
  }

  try {
    const pr = await new ProcedureStore(env).promoteAndRetire(log);
    result.proceduresPromoted = pr.promoted;
    result.proceduresRetired = pr.retired;
  } catch (e) {
    result.failures += 1;
    log.warn("promote_retire_failed", { error: String(e) });
  }

  log.info("memory_consolidation", { ...result });
  return result;
}

interface DistilledFact {
  text: string;
  confidence: number;
  derivedFrom: string[];
}

async function distillScope(
  router: Router,
  store: MemoryStore,
  scopeType: Scope,
  scopeId: string,
  log: Logger,
): Promise<number> {
  const recent = await store.recent(
    scopeType,
    scopeId,
    "episodic",
    DEEP_MEMORIES_PER_SCOPE,
  );
  if (recent.length < 5) return 0;

  const block = recent
    .map((m) => `[${m.id}] (${m.occurredAt ?? m.createdAt}) ${m.content}`)
    .join("\n");

  const reply = await router.complete({
    system:
      "You are distilling recent episodic notes into a small set of stronger semantic facts. Each fact must be supported by at least two notes. Output strict JSON: { \"facts\": [ { \"text\": \"<≤140 chars>\", \"confidence\": 0.0-1.0, \"derivedFrom\": [\"<note-id>\",...] } ] }. Only include facts with confidence ≥ 0.8 and at least two supporting notes. No filler.",
    messages: [{ role: "user", content: block }],
    tier: "deep",
    maxTokens: 700,
    temperature: 0,
  });

  const facts = parseFacts(reply.text);
  if (!facts) return 0;

  let created = 0;
  for (const fact of facts) {
    if (fact.confidence < 0.8) continue;
    const supports = fact.derivedFrom.filter((id) =>
      recent.some((m) => m.id === id),
    );
    if (supports.length < 2) continue;

    const newMem = await store.add({
      kind: "semantic" as Kind,
      scopeType,
      scopeId,
      content: fact.text,
      confidence: fact.confidence,
      occurredAt: new Date().toISOString(),
    });
    for (const fromId of supports) {
      await store.link(newMem.id, fromId, "derived_from", fact.confidence);
    }
    created += 1;
  }
  if (created > 0) {
    log.info("deep_distilled", { scopeType, scopeId, created });
  }
  return created;
}

function parseFacts(raw: string): DistilledFact[] | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as {
      facts?: unknown;
    };
    if (!Array.isArray(obj.facts)) return null;
    const out: DistilledFact[] = [];
    for (const f of obj.facts) {
      if (!f || typeof f !== "object") continue;
      const r = f as Record<string, unknown>;
      const text = typeof r.text === "string" ? r.text.slice(0, 240) : "";
      const confidence =
        typeof r.confidence === "number"
          ? Math.max(0, Math.min(1, r.confidence))
          : 0;
      const derivedFrom = Array.isArray(r.derivedFrom)
        ? r.derivedFrom.filter((x): x is string => typeof x === "string")
        : [];
      if (!text || derivedFrom.length < 2) continue;
      out.push({ text, confidence, derivedFrom });
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// REM cycle
// ---------------------------------------------------------------------------

const REM_CANDIDATES = 50;

async function runRem(
  env: Env,
  log: Logger,
  injectedRouter?: Router,
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    cycle: "rem",
    scopesScanned: 0,
    duplicatesMerged: 0,
    expiredPruned: 0,
    semanticDerived: 0,
    remLinksCreated: 0,
    proceduresPromoted: 0,
    proceduresRetired: 0,
    feedbackProcessed: 0,
    failures: 0,
  };

  const rows = await env.ARCADIA_DB.prepare(
    `SELECT m.id, m.content
       FROM memories m
      WHERE m.kind IN ('semantic','observation')
        AND (m.expires_at IS NULL OR m.expires_at > ?)
        AND (
          SELECT COUNT(*) FROM memory_edges e
           WHERE e.from_id = m.id OR e.to_id = m.id
        ) < 2
      ORDER BY RANDOM()
      LIMIT ?`,
  )
    .bind(new Date().toISOString(), REM_CANDIDATES)
    .all<{ id: string; content: string }>();

  if (rows.results.length < 2) {
    log.info("memory_consolidation", { ...result });
    return result;
  }

  const store = new MemoryStore(env);
  const router = injectedRouter ?? new Router(env);
  const text = rows.results
    .map((r) => `[${r.id}] ${r.content}`)
    .join("\n");

  try {
    const reply = await router.complete({
      system:
        "You are inspecting a list of memory snippets, each prefixed by [id]. Identify pairs that semantically refine, contradict, or supersede each other. Output strict JSON: { \"links\": [ { \"from\": \"<id>\", \"to\": \"<id>\", \"kind\": \"refines\"|\"contradicts\"|\"supersedes\"|\"supports\", \"weight\": 0.0-1.0 } ] }. Only emit pairs you're at least 0.7 confident about.",
      messages: [{ role: "user", content: text }],
      tier: "deep",
      maxTokens: 600,
      temperature: 0,
    });

    const links = parseLinks(reply.text);
    if (links) {
      for (const link of links) {
        if (link.from === link.to) continue;
        try {
          await store.link(link.from, link.to, link.kind, link.weight);
          result.remLinksCreated += 1;
        } catch {
          // ignore individual link failures (most likely FK miss)
        }
      }
    }
  } catch (e) {
    result.failures += 1;
    log.warn("rem_router_failed", { error: String(e) });
  }

  log.info("memory_consolidation", { ...result });
  return result;
}

interface RemLink {
  from: string;
  to: string;
  kind: "refines" | "contradicts" | "supersedes" | "supports";
  weight: number;
}

function parseLinks(raw: string): RemLink[] | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as {
      links?: unknown;
    };
    if (!Array.isArray(obj.links)) return null;
    const out: RemLink[] = [];
    for (const l of obj.links) {
      if (!l || typeof l !== "object") continue;
      const r = l as Record<string, unknown>;
      const from = typeof r.from === "string" ? r.from : "";
      const to = typeof r.to === "string" ? r.to : "";
      const kind = r.kind;
      const weight =
        typeof r.weight === "number"
          ? Math.max(0, Math.min(1, r.weight))
          : 0.5;
      if (
        !from ||
        !to ||
        weight < 0.7 ||
        (kind !== "refines" &&
          kind !== "contradicts" &&
          kind !== "supersedes" &&
          kind !== "supports")
      ) {
        continue;
      }
      out.push({ from, to, kind, weight });
    }
    return out;
  } catch {
    return null;
  }
}
