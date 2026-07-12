#!/usr/bin/env tsx
// PR / nightly regression gate — CI shim.
//
// Reads the latest 11 eval_runs rows from production D1 (most recent
// + 10-row baseline), applies the same thresholds as src/eval/gate.ts,
// exits non-zero on failure.
//
// Two ways to feed it:
//
//   - From wrangler:
//       npx wrangler d1 execute arcadia-db --remote --json \
//         --command "SELECT id, pass_rate, summary_json FROM eval_runs
//                     WHERE pass_rate IS NOT NULL
//                     ORDER BY started_at DESC LIMIT 11" \
//         | tsx scripts/eval-gate.ts
//
//   - From a saved file:
//       tsx scripts/eval-gate.ts --file=eval-runs.json
//
// Thresholds match src/eval/gate.ts so the in-worker gate decision
// agrees with the CI decision when run on the same dataset.

import { readFileSync } from "node:fs";

const ABSOLUTE_DROP = 0.05; // 5pp overall
const TAG_DROP = 0.1; // 10pp per tag
const TAG_MIN_BASELINE = 5; // tag needs ≥ 5 baseline samples
const BASELINE_WINDOW = 10;

interface EvalRunRow {
  id: string;
  pass_rate: number;
  summary_json: string | null;
}

interface CaseResult {
  passed: boolean;
  tags?: string[];
}

interface RunSummary {
  results: CaseResult[];
}

interface WranglerD1Envelope {
  result?: { results?: EvalRunRow[] }[];
  results?: EvalRunRow[];
}

function parseInput(): EvalRunRow[] {
  const fileFlag = process.argv.find((a) => a.startsWith("--file="));
  const raw = fileFlag
    ? readFileSync(fileFlag.slice("--file=".length), "utf8")
    : readFileSync(0, "utf8");
  if (!raw.trim()) {
    console.error("eval-gate: no input on stdin or --file=");
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`eval-gate: input is not JSON: ${String(e)}`);
    process.exit(2);
  }

  // wrangler d1 execute --json wraps rows in an envelope whose exact
  // shape has drifted across versions:
  //   [{ results: [...] }]            (older)
  //   { result: [{ results: [...] }] }
  //   { results: [...] }
  //   [{ results: [], success: true, meta: {...} }]  (empty result set)
  // Rather than enumerate every shape, locate the deepest `results`
  // array that looks like eval rows. If none is found we treat it as
  // "no rows" and let the gate allow (a fresh D1 with no eval history
  // must not block a PR — the nightly in-worker gate in
  // src/eval/gate.ts is the real regression guard).
  const rows = findResultsArray(parsed);
  if (rows) return rows;

  // A bare array that isn't an envelope: assume it's the rows.
  if (Array.isArray(parsed)) return parsed as EvalRunRow[];

  console.warn(
    "eval-gate: could not locate eval_runs rows in input — treating as " +
      "no baseline and allowing. (Nightly in-worker gate remains authoritative.)",
  );
  return [];
}

/**
 * Recursively find the first `results` array in a wrangler --json
 * envelope. Accepts empty arrays (an empty result set is a valid
 * "no rows yet" signal, not an error).
 */
function findResultsArray(node: unknown): EvalRunRow[] | null {
  if (Array.isArray(node)) {
    for (const el of node) {
      const found = findResultsArray(el);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.results)) return obj.results as EvalRunRow[];
    for (const v of Object.values(obj)) {
      const found = findResultsArray(v);
      if (found) return found;
    }
  }
  return null;
}

function tagRates(summary: RunSummary | null): Map<string, { passed: number; total: number }> {
  const out = new Map<string, { passed: number; total: number }>();
  if (!summary) return out;
  for (const r of summary.results) {
    for (const tag of r.tags ?? []) {
      const cur = out.get(tag) ?? { passed: 0, total: 0 };
      cur.total += 1;
      if (r.passed) cur.passed += 1;
      out.set(tag, cur);
    }
  }
  return out;
}

function parseSummary(raw: string | null): RunSummary | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunSummary;
  } catch {
    return null;
  }
}

function main(): void {
  const rows = parseInput();
  if (rows.length === 0) {
    console.log("eval-gate: no runs yet — first deploy, allowing.");
    process.exit(0);
  }
  if (rows.length === 1) {
    console.log(
      `eval-gate: single run (pass_rate=${rows[0]!.pass_rate.toFixed(3)}) — no baseline yet, allowing.`,
    );
    process.exit(0);
  }

  const [current, ...rest] = rows;
  const baseline = rest.slice(0, BASELINE_WINDOW);
  const currentSummary = parseSummary(current!.summary_json);
  const currentTagRates = tagRates(currentSummary);

  // Baseline overall = mean of baseline pass_rates.
  const baselineOverall =
    baseline.reduce((sum, r) => sum + r.pass_rate, 0) / baseline.length;

  // Baseline per-tag = mean per-tag rate over baseline runs that
  // touched the tag.
  const tagSums = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  for (const r of baseline) {
    const trs = tagRates(parseSummary(r.summary_json));
    for (const [tag, agg] of trs) {
      const rate = agg.total === 0 ? 0 : agg.passed / agg.total;
      tagSums.set(tag, (tagSums.get(tag) ?? 0) + rate);
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const overallDelta = baselineOverall - current!.pass_rate;
  const overallBreach = overallDelta > ABSOLUTE_DROP;

  const tagBreaches: {
    tag: string;
    current: number;
    baseline: number;
    delta: number;
  }[] = [];
  for (const [tag, sum] of tagSums) {
    const count = tagCounts.get(tag) ?? 1;
    if (count < TAG_MIN_BASELINE) continue;
    const baselineRate = sum / count;
    const currentAgg = currentTagRates.get(tag);
    const currentRate =
      currentAgg && currentAgg.total > 0
        ? currentAgg.passed / currentAgg.total
        : 0;
    const delta = baselineRate - currentRate;
    if (delta > TAG_DROP) {
      tagBreaches.push({
        tag,
        current: currentRate,
        baseline: baselineRate,
        delta,
      });
    }
  }

  console.log(
    `eval-gate: current=${current!.pass_rate.toFixed(3)} ` +
      `baseline=${baselineOverall.toFixed(3)} ` +
      `delta=${overallDelta.toFixed(3)} (limit ${ABSOLUTE_DROP})`,
  );

  if (!overallBreach && tagBreaches.length === 0) {
    console.log("eval-gate: PASS");
    process.exit(0);
  }

  console.error("eval-gate: FAIL");
  if (overallBreach) {
    console.error(
      `  overall ${(overallDelta * 100).toFixed(1)}pp drop ` +
        `(${current!.pass_rate.toFixed(3)} vs ${baselineOverall.toFixed(3)})`,
    );
  }
  for (const b of tagBreaches) {
    console.error(
      `  ${b.tag}: ${(b.delta * 100).toFixed(1)}pp drop ` +
        `(${b.current.toFixed(3)} vs ${b.baseline.toFixed(3)})`,
    );
  }
  process.exit(1);
}

main();
