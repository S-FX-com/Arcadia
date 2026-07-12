// Curiosity budget (EXECUTION-PLAN §Phase 4; SOUL.md §curiosity).
//
// During deep consolidation, Arcadia looks for gaps in her model of the
// world — a customer she keeps hearing about but has no profile for, a
// channel with activity but no owner — and turns a bounded number of them
// into open research questions. She does NOT answer them here (that is P5);
// she records them so they can be surfaced and pursued deliberately.
//
// Budget: at most RESEARCH_QUESTION_MAX_PER_CYCLE questions per run, and at
// most RESEARCH_QUESTION_MAX_PER_DAY across a calendar day. The per-day cap
// is tracked in KV under `curiosity:day:<YYYY-MM-DD>` (a simple counter with
// a 2-day TTL so keys self-expire).
//
// Where the questions live — a deliberate design choice. They are NOT forced
// into improvement_proposals: the schema CHECK constrains proposal `kind` to
// { charter_amendment, memory_correction, procedure, routine }, and an open
// research question ("who owns Acme?") is none of those. Rather than fabricate
// an enum value or mislabel a question as a "memory_correction", curiosity
// questions are stored as OBSERVATION memories (kind='observation', scope
// tenant, source_resource_type='curiosity_question'), held lightly at low
// confidence. source_resource_id carries the gap key so the same gap is not
// re-asked while an open question for it already exists. If a future gap
// class is genuinely a correction, that path can create an origin='curiosity'
// proposal with kind='memory_correction' — but we never invent kinds.
//
// Persistence uses raw D1 (not MemoryStore.add) — like customer profiles —
// so these rows are testable under miniflare (no Vectorize dependency).

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import type { CompleteRequest, CompleteResponse } from "../ai/types";
import { injectCharter } from "../charter/inject";
import { config } from "../lib/config";

const SOURCE = "curiosity_question";
const CUSTOMER_PROFILE_MARKER = "customer_profile";
const MAX_GAP_SCAN = 25;

const SYSTEM_PROMPT = `You are Arcadia. You have found a GAP in your understanding of this team's world. Turn it into a single, specific, open research question you could pursue to close the gap.

Rules:
- One question only. Under 160 characters. End with a question mark.
- Concrete and actionable — name the customer / channel / subject in the gap.
- No preamble, no options, no explanation. Return the question text only.`;

export type GapKind = "customer_no_profile" | "channel_no_owner";

export interface Gap {
  /** Stable dedupe key, e.g. "customer:acme". */
  key: string;
  kind: GapKind;
  /** Short human label for the subject of the gap. */
  subject: string;
  /** One-line description of the gap fed to the model. */
  detail: string;
}

export interface CuriosityDeps {
  /** Injectable router seam — tests pass a fake. */
  router?: Pick<Router, "complete">;
  /** Injectable gap detector — defaults to the D1 scan below. */
  findGaps?: (env: Env, tenantId: string) => Promise<Gap[]>;
  /** Calendar day key (YYYY-MM-DD) for the per-day counter. Defaults to today. */
  today?: string;
  /** Per-cycle cap. Defaults to config.researchQuestionMaxPerCycle. */
  maxPerCycle?: number;
  /** Per-day cap. Defaults to config.researchQuestionMaxPerDay. */
  maxPerDay?: number;
  /** Tenant scope. Defaults to env.GRAPH_TENANT_ID. */
  tenantId?: string;
}

export interface CuriosityQuestion {
  key: string;
  question: string;
}

export interface CuriosityResult {
  created: number;
  questions: CuriosityQuestion[];
  /** Running per-day count after this run. */
  dayCount: number;
  /** True when the run stopped because a cap was reached. */
  capped: boolean;
}

export async function runCuriosity(
  env: Env,
  log: Logger,
  deps?: CuriosityDeps,
): Promise<CuriosityResult> {
  const cfg = config(env);
  const router = deps?.router ?? new Router(env);
  const findGaps = deps?.findGaps ?? defaultFindGaps;
  const tenantId = deps?.tenantId ?? env.GRAPH_TENANT_ID;
  const today = deps?.today ?? new Date().toISOString().slice(0, 10);
  const maxPerCycle = deps?.maxPerCycle ?? cfg.researchQuestionMaxPerCycle;
  const maxPerDay = deps?.maxPerDay ?? cfg.researchQuestionMaxPerDay;

  const dayKey = `curiosity:day:${today}`;
  const used = await readDayCount(env, dayKey);
  const budget = Math.min(maxPerCycle, maxPerDay - used);
  if (budget <= 0) {
    log.info("curiosity_capped", { today, used, maxPerDay, maxPerCycle });
    return { created: 0, questions: [], dayCount: used, capped: true };
  }

  const gaps = await findGaps(env, tenantId);
  const questions: CuriosityQuestion[] = [];
  const nowIso = new Date().toISOString();

  for (const gap of gaps) {
    if (questions.length >= budget) break;
    if (await alreadyAsked(env, gap.key, nowIso)) continue;
    const question = await phrase(env, router, gap);
    if (!question) continue;

    await env.ARCADIA_DB.prepare(
      `INSERT INTO memories
         (id, kind, scope_type, scope_id, content, source_resource_type,
          source_resource_id, confidence, occurred_at, created_at, updated_at)
       VALUES (?, 'observation', 'tenant', ?, ?, ?, ?, 0.4, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        tenantId,
        question,
        SOURCE,
        gap.key,
        nowIso,
        nowIso,
        nowIso,
      )
      .run();
    questions.push({ key: gap.key, question });
  }

  const created = questions.length;
  const dayCount = used + created;
  if (created > 0) {
    await env.ARCADIA_CACHE.put(dayKey, String(dayCount), {
      expirationTtl: 2 * 24 * 3600,
    });
  }

  const capped = created >= budget || dayCount >= maxPerDay;
  log.info("curiosity_cycle", { today, created, dayCount, gaps: gaps.length });
  return { created, questions, dayCount, capped };
}

// ---------------------------------------------------------------------------
// Per-day counter
// ---------------------------------------------------------------------------

async function readDayCount(env: Env, dayKey: string): Promise<number> {
  const raw = await env.ARCADIA_CACHE.get(dayKey);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function alreadyAsked(
  env: Env,
  gapKey: string,
  nowIso: string,
): Promise<boolean> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT 1 AS x FROM memories
      WHERE source_resource_type = ?
        AND source_resource_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
      LIMIT 1`,
  )
    .bind(SOURCE, gapKey, nowIso)
    .first<{ x: number }>();
  return row !== null;
}

// ---------------------------------------------------------------------------
// Question phrasing (deep tier, charter-injected)
// ---------------------------------------------------------------------------

async function phrase(
  env: Env,
  router: Pick<Router, "complete">,
  gap: Gap,
): Promise<string | null> {
  try {
    const system = await injectCharter(env, SYSTEM_PROMPT);
    const req: CompleteRequest = {
      system,
      messages: [{ role: "user", content: `Gap: ${gap.detail}` }],
      tier: "deep",
      maxTokens: 120,
      temperature: 0.3,
    };
    const reply: CompleteResponse = await router.complete(req);
    const text = reply.text.trim().slice(0, 300);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default gap detection
// ---------------------------------------------------------------------------

async function defaultFindGaps(env: Env, _tenantId: string): Promise<Gap[]> {
  const nowIso = new Date().toISOString();
  const gaps: Gap[] = [];

  // Customers we hold memories about but have never built a profile for.
  const customers = await env.ARCADIA_DB.prepare(
    `SELECT DISTINCT scope_id
       FROM memories
      WHERE scope_type = 'customer'
        AND (expires_at IS NULL OR expires_at > ?)
        AND scope_id NOT IN (
          SELECT scope_id FROM memories
           WHERE scope_type = 'customer'
             AND source_resource_type = ?
        )
      LIMIT ?`,
  )
    .bind(nowIso, CUSTOMER_PROFILE_MARKER, MAX_GAP_SCAN)
    .all<{ scope_id: string }>();
  for (const r of customers.results) {
    gaps.push({
      key: `customer:${r.scope_id}`,
      kind: "customer_no_profile",
      subject: r.scope_id,
      detail: `We hold memories about customer "${r.scope_id}" but have no profile for them.`,
    });
  }

  return gaps;
}
