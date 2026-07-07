// Daily heartbeat (SOUL.md §Heartbeat).
//
// "Each day, she checks whether her memory is balanced across categories,
//  whether any part of her understanding has gone stale, and whether there
//  are proactive opportunities she should surface — approaching deadlines,
//  silent team members, unowned high-priority tasks."
//
// The heartbeat OBSERVES and RECORDS; it never acts. It writes a single
// structured report as a tenant-scoped observation memory
// (source_resource_type='heartbeat', held lightly at low confidence) so the
// org-pulse (src/intelligence/org-pulse.ts) can surface the opportunities at
// the right moment.
//
// Why record rather than propose: the improvement_proposals queue models
// *behaviour changes* the operator ratifies (charter_amendment /
// memory_correction / procedure / routine — the schema CHECK constrains the
// kind). A proactive operational opportunity ("this task has no owner") is
// not a behaviour change, so forcing it into a proposal kind would be
// dishonest. SOUL.md is explicit: "She does not act on every opportunity
// she identifies. She holds them, notices the patterns, and surfaces the
// ones that matter at the right moment." The org-pulse is that surface.
// (Eval, consolidation, and curiosity remain the proposal producers.)
//
// All heuristics are deterministic D1 scans, kept simple and labeled as
// inference where they infer.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";

// Memory-balance heuristic knobs.
const IMBALANCE_MIN_EPISODIC = 20;
const IMBALANCE_RATIO = 5; // episodic ≥ RATIO × semantic ⇒ under-consolidation
// Staleness / opportunity windows.
const STALE_SCOPE_DAYS = 30;
const SILENT_USER_DAYS = 14;
const DEADLINE_WINDOW_HOURS = 48;
const MAX_PER_LIST = 10;

export interface MemoryBalance {
  countsByKind: Record<string, number>;
  total: number;
  /** Inference-labeled flags, e.g. under-consolidation. */
  flags: string[];
}

export interface StaleScope {
  scopeType: string;
  scopeId: string;
  lastUpdatedAt: string;
}

export type OpportunityKind =
  | "approaching_deadline"
  | "silent_user"
  | "unowned_high_priority";

export interface Opportunity {
  kind: OpportunityKind;
  detail: string;
  /** Task id / user aad id the opportunity concerns. */
  ref: string;
}

export interface HeartbeatReport {
  generatedAt: string;
  tenantId: string;
  memoryBalance: MemoryBalance;
  staleScopes: StaleScope[];
  opportunities: Opportunity[];
  /** Id of the persisted report memory row. */
  memoryId: string;
}

export interface HeartbeatDeps {
  /** Tenant scope. Defaults to env.GRAPH_TENANT_ID. */
  tenantId?: string;
}

export async function runHeartbeat(
  env: Env,
  log: Logger,
  deps?: HeartbeatDeps,
): Promise<HeartbeatReport> {
  const tenantId = deps?.tenantId ?? env.GRAPH_TENANT_ID;
  const nowIso = new Date().toISOString();

  const memoryBalance = await checkMemoryBalance(env, nowIso);
  const staleScopes = await checkStaleScopes(env, nowIso);
  const opportunities = await findOpportunities(env, tenantId, nowIso);

  // Persist the report as a tenant-scoped observation, held lightly.
  const memoryId = crypto.randomUUID();
  const payload = { memoryBalance, staleScopes, opportunities };
  await env.ARCADIA_DB.prepare(
    `INSERT INTO memories
       (id, kind, scope_type, scope_id, content, source_resource_type,
        confidence, occurred_at, created_at, updated_at)
     VALUES (?, 'observation', 'tenant', ?, ?, 'heartbeat', 0.4, ?, ?, ?)`,
  )
    .bind(memoryId, tenantId, JSON.stringify(payload), nowIso, nowIso, nowIso)
    .run();

  const report: HeartbeatReport = {
    generatedAt: nowIso,
    tenantId,
    memoryBalance,
    staleScopes,
    opportunities,
    memoryId,
  };
  log.info("heartbeat", {
    tenantId,
    memoryTotal: memoryBalance.total,
    balanceFlags: memoryBalance.flags.length,
    staleScopes: staleScopes.length,
    opportunities: opportunities.length,
  });
  return report;
}

// ---------------------------------------------------------------------------
// Memory balance
// ---------------------------------------------------------------------------

async function checkMemoryBalance(
  env: Env,
  nowIso: string,
): Promise<MemoryBalance> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT kind, COUNT(*) AS n
       FROM memories
      WHERE (expires_at IS NULL OR expires_at > ?)
      GROUP BY kind`,
  )
    .bind(nowIso)
    .all<{ kind: string; n: number }>();

  const countsByKind: Record<string, number> = {};
  let total = 0;
  for (const r of rows.results) {
    countsByKind[r.kind] = r.n;
    total += r.n;
  }

  const episodic = countsByKind.episodic ?? 0;
  const semantic = countsByKind.semantic ?? 0;
  const flags: string[] = [];
  if (
    episodic >= IMBALANCE_MIN_EPISODIC &&
    episodic >= IMBALANCE_RATIO * Math.max(semantic, 1)
  ) {
    flags.push(
      `Episodic memories (${episodic}) greatly outnumber semantic (${semantic}) — possible under-consolidation (inference).`,
    );
  }
  return { countsByKind, total, flags };
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

async function checkStaleScopes(
  env: Env,
  nowIso: string,
): Promise<StaleScope[]> {
  const cutoff = new Date(
    Date.now() - STALE_SCOPE_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT scope_type, scope_id, MAX(updated_at) AS last_updated
       FROM memories
      WHERE (expires_at IS NULL OR expires_at > ?)
      GROUP BY scope_type, scope_id
      HAVING last_updated < ?
      ORDER BY last_updated ASC
      LIMIT ?`,
  )
    .bind(nowIso, cutoff, MAX_PER_LIST)
    .all<{ scope_type: string; scope_id: string; last_updated: string }>();

  return rows.results.map((r) => ({
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    lastUpdatedAt: r.last_updated,
  }));
}

// ---------------------------------------------------------------------------
// Proactive opportunities (deterministic, tenant-scoped)
// ---------------------------------------------------------------------------

async function findOpportunities(
  env: Env,
  tenantId: string,
  nowIso: string,
): Promise<Opportunity[]> {
  const out: Opportunity[] = [];
  const deadlineWindow = new Date(
    Date.now() + DEADLINE_WINDOW_HOURS * 3600 * 1000,
  ).toISOString();

  // Approaching (or overdue) deadlines on live tasks in this tenant.
  const deadlines = await env.ARCADIA_DB.prepare(
    `SELECT t.id AS id, t.title AS title, t.deadline_at AS deadline_at,
            u.display_name AS owner_name
       FROM tasks t
       LEFT JOIN users u ON u.aad_id = t.owner_aad_id
      WHERE t.status IN ('open','in_progress')
        AND t.deadline_at IS NOT NULL
        AND t.deadline_at <= ?
        AND (
          t.channel_id IN (SELECT channel_id FROM channels WHERE tenant_id = ?)
          OR t.chat_id IN (SELECT chat_id FROM chats WHERE tenant_id = ?)
        )
      ORDER BY t.deadline_at ASC
      LIMIT ?`,
  )
    .bind(deadlineWindow, tenantId, tenantId, MAX_PER_LIST)
    .all<{
      id: string;
      title: string;
      deadline_at: string;
      owner_name: string | null;
    }>();
  for (const r of deadlines.results) {
    const who = r.owner_name ? ` (owner ${r.owner_name})` : " (unowned)";
    out.push({
      kind: "approaching_deadline",
      ref: r.id,
      detail: `"${r.title}"${who} — due ${r.deadline_at}.`,
    });
  }

  // Unowned high-priority tasks in this tenant.
  const unowned = await env.ARCADIA_DB.prepare(
    `SELECT t.id AS id, t.title AS title, t.priority AS priority
       FROM tasks t
      WHERE t.status IN ('open','in_progress')
        AND t.owner_aad_id IS NULL
        AND t.priority IN ('high','urgent')
        AND (
          t.channel_id IN (SELECT channel_id FROM channels WHERE tenant_id = ?)
          OR t.chat_id IN (SELECT chat_id FROM chats WHERE tenant_id = ?)
        )
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 ELSE 1 END, t.created_at ASC
      LIMIT ?`,
  )
    .bind(tenantId, tenantId, MAX_PER_LIST)
    .all<{ id: string; title: string; priority: string }>();
  for (const r of unowned.results) {
    out.push({
      kind: "unowned_high_priority",
      ref: r.id,
      detail: `"${r.title}" is ${r.priority} priority but has no owner.`,
    });
  }

  // Usually-active people who have gone quiet — inference. "Usually active"
  // proxy: a last_seen_at exists (they were seen) but not recently.
  const silentCutoff = new Date(
    Date.now() - SILENT_USER_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const silent = await env.ARCADIA_DB.prepare(
    `SELECT aad_id, display_name, last_seen_at
       FROM users
      WHERE tenant_id = ?
        AND last_seen_at IS NOT NULL
        AND last_seen_at < ?
      ORDER BY last_seen_at ASC
      LIMIT ?`,
  )
    .bind(tenantId, silentCutoff, MAX_PER_LIST)
    .all<{ aad_id: string; display_name: string | null; last_seen_at: string }>();
  for (const r of silent.results) {
    const name = r.display_name ?? r.aad_id;
    out.push({
      kind: "silent_user",
      ref: r.aad_id,
      detail: `${name} usually active but quiet since ${r.last_seen_at} (inference).`,
    });
  }

  return out;
}
