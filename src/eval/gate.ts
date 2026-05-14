// PR / nightly regression gate.
//
// The gate compares the latest run's per-tag pass rates against a
// rolling baseline (the mean of the previous N successful runs). The
// run fails the gate if:
//
//   - overall pass_rate drops by more than ABSOLUTE_DROP, OR
//   - any tag's pass_rate drops by more than TAG_DROP and its
//     baseline had ≥ TAG_MIN_BASELINE samples
//
// Used in two places:
//
//   1. cron "0 4 * * *" — nightly eval; the gate decision is logged
//      so an alert hook can fire when it trips.
//   2. CI — surface the gate result on a PR. The CI runner calls
//      runEvals() against a staging worker and feeds the summary into
//      gateLatestRun().

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import type { RunSummary } from "./types";

const ABSOLUTE_DROP = 0.05; // 5 percentage points overall
const TAG_DROP = 0.1; // 10 percentage points per tag
const TAG_MIN_BASELINE = 5; // tag needs at least 5 runs of history
const BASELINE_WINDOW = 10; // average over the last 10 successful runs

export interface GateDecision {
  passed: boolean;
  reason: string;
  overall: { current: number; baseline: number };
  perTag: {
    tag: string;
    current: number;
    baseline: number;
    delta: number;
    breach: boolean;
  }[];
}

export async function gateLatestRun(
  env: Env,
  summary: RunSummary,
  log: Logger,
): Promise<GateDecision> {
  const baseline = await loadBaseline(env, summary.runId);

  const overallDelta = baseline.overall - summary.pass_rate;
  const breaches: GateDecision["perTag"] = [];

  for (const [tag, baselineRate] of baseline.perTag.entries()) {
    const current = currentTagRate(summary, tag);
    const delta = baselineRate - current;
    const enough = (baseline.perTagCount.get(tag) ?? 0) >= TAG_MIN_BASELINE;
    breaches.push({
      tag,
      current,
      baseline: baselineRate,
      delta,
      breach: enough && delta > TAG_DROP,
    });
  }

  const overallBreach = overallDelta > ABSOLUTE_DROP;
  const tagBreaches = breaches.filter((b) => b.breach);
  const passed = !overallBreach && tagBreaches.length === 0;

  const decision: GateDecision = {
    passed,
    reason: passed
      ? "pass"
      : [
          overallBreach
            ? `overall ${(overallDelta * 100).toFixed(1)}pp drop`
            : null,
          ...tagBreaches.map(
            (b) => `${b.tag} ${(b.delta * 100).toFixed(1)}pp drop`,
          ),
        ]
          .filter(Boolean)
          .join("; "),
    overall: { current: summary.pass_rate, baseline: baseline.overall },
    perTag: breaches,
  };

  log.info("eval_gate", { passed, reason: decision.reason });
  return decision;
}

interface Baseline {
  overall: number;
  perTag: Map<string, number>;
  perTagCount: Map<string, number>;
}

async function loadBaseline(env: Env, excludeRunId: string): Promise<Baseline> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT pass_rate, summary_json
       FROM eval_runs
      WHERE pass_rate IS NOT NULL
        AND id != ?
      ORDER BY started_at DESC
      LIMIT ?`,
  )
    .bind(excludeRunId, BASELINE_WINDOW)
    .all<{ pass_rate: number; summary_json: string | null }>();

  if (rows.results.length === 0) {
    return { overall: 0, perTag: new Map(), perTagCount: new Map() };
  }

  let overallSum = 0;
  const tagSums = new Map<string, number>();
  const tagCounts = new Map<string, number>();

  for (const r of rows.results) {
    overallSum += r.pass_rate;
    if (!r.summary_json) continue;
    try {
      const parsed = JSON.parse(r.summary_json) as RunSummary;
      const seen = new Map<string, { passed: number; total: number }>();
      for (const result of parsed.results) {
        for (const tag of result.tags ?? []) {
          const cur = seen.get(tag) ?? { passed: 0, total: 0 };
          cur.total += 1;
          if (result.passed) cur.passed += 1;
          seen.set(tag, cur);
        }
      }
      for (const [tag, agg] of seen) {
        const rate = agg.total === 0 ? 0 : agg.passed / agg.total;
        tagSums.set(tag, (tagSums.get(tag) ?? 0) + rate);
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    } catch {
      // skip malformed row
    }
  }

  const overall = overallSum / rows.results.length;
  const perTag = new Map<string, number>();
  for (const [tag, sum] of tagSums) {
    const count = tagCounts.get(tag) ?? 1;
    perTag.set(tag, sum / count);
  }
  return { overall, perTag, perTagCount: tagCounts };
}

function currentTagRate(summary: RunSummary, tag: string): number {
  const tagged = summary.results.filter((r) => (r.tags ?? []).includes(tag));
  if (tagged.length === 0) return 0;
  return tagged.filter((r) => r.passed).length / tagged.length;
}
