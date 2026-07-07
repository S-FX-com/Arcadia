// Eval → proposal bridge (EXECUTION-PLAN §Phase 4).
//
// The nightly eval grades cases and the gate compares to a rolling
// baseline — but nothing fed failures back into behaviour. This module
// closes that loop: after a run + gate, each FAILING case (or a tripped
// gate) becomes a PROPOSED remedy in the operator review queue
// (src/learning/proposals.ts). Nothing is applied silently — Arcadia
// proposes, the operator ratifies (SOUL.md + D5).
//
// Two remedies are drafted, both via the deep-tier router from the case's
// expected-points + Arcadia's actual answer (both live in the run detail):
//
//   - memory_correction — when a recalled memory looks culpable (the case
//     recalled memories and the judge rationale blames context/recall).
//     Targets the top recalled memory id so approval can forget it.
//
//   - charter_amendment — otherwise treated as missing ground truth.
//     Failing cases are grouped by their failing tag; one candidate
//     clause is drafted per tag.
//
// Dedupe keys (failing tag for charter, `mem:<id>` for memory) keep
// nightly runs from piling duplicate proposals for the same weakness.
//
// Wired into the eval cron path from gateLatestRun() (src/eval/gate.ts),
// fully try/catch-guarded there so proposal generation can never fail an
// eval run.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import type { CompleteRequest, CompleteResponse } from "../ai/types";
import { ProposalStore } from "../learning/proposals";
import type { GateDecision } from "./gate";
import type { CaseResult, RunSummary } from "./types";

/** Minimal router seam so tests can inject a fake completion. */
export interface ProposeDeps {
  router?: { complete(req: CompleteRequest): Promise<CompleteResponse> };
}

const CHARTER_DRAFT_SYSTEM = `You maintain Arcadia's operator charter — the small set of canonical, durable facts about the organisation that Arcadia treats as ground truth.

An eval case failed: Arcadia's answer missed points the operator considers correct, which suggests the charter is missing a fact. Draft ONE concise candidate clause (1-3 sentences) that, if added to the charter, would supply the missing ground truth.

Rules:
- State it as a durable fact or policy, not as a reference to this test or question.
- Do not restate the whole charter; produce only the new clause.
- Output STRICT JSON only: {"clause":"<the clause>"}`;

const MEMORY_DRAFT_SYSTEM = `You review Arcadia's learned memories. An eval case failed and a recalled memory appears to have driven the wrong answer.

Draft a short correction (1-2 sentences) for a human operator: what the recalled memory got wrong and what the correct fact is.

Output STRICT JSON only: {"correction":"<the correction>"}`;

const MEMORY_FAULT =
  /\b(memor(y|ies)|recall(ed)?|context|outdated|stale|contradict|hallucinat)/i;

/**
 * Generate PROPOSED remedies from an eval run + gate decision. Returns the
 * ids of the proposals created (existing ids are returned when a dedupe key
 * already had an open proposal). Never throws for a per-item drafting error;
 * those are logged and skipped.
 */
export async function proposeFromEvalRun(
  env: Env,
  summary: RunSummary,
  gate: GateDecision | null,
  log: Logger,
  deps: ProposeDeps = {},
): Promise<string[]> {
  const failing = summary.results.filter((r) => !r.passed);
  if (failing.length === 0) return [];

  const store = new ProposalStore(env);
  const router = deps.router ?? new Router(env);
  const created: string[] = [];
  const memHandled = new Set<string>();

  // memory_correction — one proposal per distinct culpable memory.
  const byMemory = new Map<string, CaseResult[]>();
  for (const r of failing) {
    if (!memoryLooksCulpable(r)) continue;
    const memId = (r.recalledMemoryIds ?? [])[0];
    if (!memId) continue;
    const list = byMemory.get(memId) ?? [];
    list.push(r);
    byMemory.set(memId, list);
  }
  for (const [memId, cases] of byMemory) {
    const lead = cases[0];
    if (!lead) continue;
    try {
      const correction = await draftMemoryCorrection(router, lead);
      const id = await store.create({
        kind: "memory_correction",
        origin: "eval",
        title: `Memory correction: ${truncate(lead.caseName, 60)}`,
        rationale: lead.rationale,
        payload: {
          targetMemoryId: memId,
          suggestedCorrection: correction,
          caseIds: cases.map((c) => c.caseId),
        },
        dedupeKey: `mem:${memId}`,
      });
      created.push(id);
      for (const c of cases) memHandled.add(c.caseId);
    } catch (e) {
      log.warn("eval_propose_memory_failed", { memId, error: String(e) });
    }
  }

  // charter_amendment — remaining failures grouped by failing tag.
  const byTag = new Map<string, CaseResult[]>();
  for (const r of failing) {
    if (memHandled.has(r.caseId)) continue;
    const tag = failingTagFor(r, gate);
    const list = byTag.get(tag) ?? [];
    list.push(r);
    byTag.set(tag, list);
  }
  for (const [tag, cases] of byTag) {
    const lead = cases[0];
    if (!lead) continue;
    try {
      const clause = await draftCharterClause(router, lead, tag);
      const id = await store.create({
        kind: "charter_amendment",
        origin: "eval",
        title: `Charter gap: ${tag}`,
        rationale:
          `${cases.length} eval case(s) tagged "${tag}" failed; drafted a ` +
          `candidate clause to supply the missing ground truth.`,
        payload: {
          suggestedClause: clause,
          failingTag: tag,
          caseIds: cases.map((c) => c.caseId),
        },
        dedupeKey: tag,
      });
      created.push(id);
    } catch (e) {
      log.warn("eval_propose_charter_failed", { tag, error: String(e) });
    }
  }

  log.info("eval_proposals", { created: created.length });
  return created;
}

function memoryLooksCulpable(r: CaseResult): boolean {
  return (r.recalledMemoryIds?.length ?? 0) > 0 && MEMORY_FAULT.test(r.rationale);
}

function failingTagFor(r: CaseResult, gate: GateDecision | null): string {
  const tags = r.tags ?? [];
  if (gate) {
    const breached = new Set(
      gate.perTag.filter((t) => t.breach).map((t) => t.tag),
    );
    const hit = tags.find((t) => breached.has(t));
    if (hit) return hit;
  }
  return tags[0] ?? "general";
}

async function draftCharterClause(
  router: NonNullable<ProposeDeps["router"]>,
  c: CaseResult,
  tag: string,
): Promise<string> {
  const res = await router.complete({
    system: CHARTER_DRAFT_SYSTEM,
    tier: "deep",
    maxTokens: 400,
    messages: [
      {
        role: "user",
        content:
          `Topic tag: ${tag}\n\nQuestion:\n${c.prompt}\n\n` +
          `Expected points:\n${c.expected}\n\n` +
          `Arcadia's actual answer:\n${c.reply}`,
      },
    ],
  });
  return extractField(res.text, "clause") ?? res.text.trim();
}

async function draftMemoryCorrection(
  router: NonNullable<ProposeDeps["router"]>,
  c: CaseResult,
): Promise<string> {
  const res = await router.complete({
    system: MEMORY_DRAFT_SYSTEM,
    tier: "deep",
    maxTokens: 300,
    messages: [
      {
        role: "user",
        content:
          `Question:\n${c.prompt}\n\nExpected points:\n${c.expected}\n\n` +
          `Arcadia's actual answer:\n${c.reply}\n\n` +
          `Grader rationale:\n${c.rationale}`,
      },
    ],
  });
  return extractField(res.text, "correction") ?? res.text.trim();
}

/** Pull a string field from a JSON reply, tolerating surrounding prose. */
function extractField(text: string, field: string): string | null {
  const direct = tryField(text, field);
  if (direct) return direct;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return tryField(m[0], field);
  return null;
}

function tryField(json: string, field: string): string | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const v = parsed[field];
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {
    // not JSON — caller falls back
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
