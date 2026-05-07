#!/usr/bin/env tsx
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Eval pass-rate regression gate
//
// Reads the latest two eval_runs rows from D1 and fails if the most
// recent run's pass rate dropped by more than EVAL_REGRESSION_THRESHOLD
// (default 5 percentage points) relative to the previous run.
//
// Usage (from CI, where the deploy step already happened):
//   npx wrangler d1 execute arcadia-db --remote --json \
//     --command "SELECT cases_total, cases_passed FROM eval_runs ORDER BY id DESC LIMIT 2" \
//     | tsx scripts/eval-gate.ts
//
// Or pass a JSON file via --file=path.json.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

const THRESHOLD_PP = parseFloat(process.env.EVAL_REGRESSION_THRESHOLD ?? "5");

interface Row { cases_total: number; cases_passed: number }

function parseInput(): Row[] {
	const fileFlag = process.argv.find((a) => a.startsWith("--file="));
	const raw = fileFlag ? readFileSync(fileFlag.slice("--file=".length), "utf8") : readSync(0);
	const parsed = JSON.parse(raw) as unknown;
	const blocks = Array.isArray(parsed) ? parsed : [parsed];
	const first = blocks[0] as { results?: Row[] } | undefined;
	return first?.results ?? [];
}

function readSync(fd: number): string {
	const chunks: Buffer[] = [];
	const buf = Buffer.alloc(65536);
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("node:fs") as typeof import("node:fs");
	let n;
	while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
		chunks.push(Buffer.from(buf.subarray(0, n)));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function main(): void {
	const rows = parseInput();
	if (rows.length === 0) {
		console.log("[eval-gate] no eval_runs rows; skipping (first run baseline?).");
		return;
	}
	const latest = rows[0]!;
	const latestRate = latest.cases_total > 0 ? latest.cases_passed / latest.cases_total : 0;
	console.log(`[eval-gate] latest: ${latest.cases_passed}/${latest.cases_total} = ${(latestRate * 100).toFixed(1)}%`);

	if (rows.length < 2) {
		console.log("[eval-gate] only one run on file; nothing to compare. ok.");
		return;
	}
	const prev = rows[1]!;
	const prevRate = prev.cases_total > 0 ? prev.cases_passed / prev.cases_total : 0;
	console.log(`[eval-gate] previous: ${prev.cases_passed}/${prev.cases_total} = ${(prevRate * 100).toFixed(1)}%`);

	const drop = (prevRate - latestRate) * 100;
	if (drop > THRESHOLD_PP) {
		console.error(`::error::Eval pass-rate regression: dropped ${drop.toFixed(1)} percentage points (threshold ${THRESHOLD_PP})`);
		process.exit(1);
	}
	console.log(`[eval-gate] regression ${drop.toFixed(1)}pp <= threshold ${THRESHOLD_PP}pp. ok.`);
}

main();
