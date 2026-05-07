#!/usr/bin/env tsx
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Idempotent D1 migration runner
//
// Replaces the 12 phase-specific db:migrate:phaseN scripts with one
// command. Tracks applied migrations in a _migrations table so re-runs are
// safe. Usage:
//
//   npm run db:migrate            # apply against local D1
//   npm run db:migrate:remote     # apply against remote D1
//
// Drop new migrations into ./schema/ named like:
//   d1-init.sql
//   d1-phase{N}.sql
//   d1-phase{N}-{slug}.sql
// They run in lexicographic order. Each file's sha256 is recorded after
// successful apply; modifying an applied file is rejected (re-run errors
// out instead of silently re-applying).
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DB_NAME = "arcadia-db";
const SCHEMA_DIR = resolve(process.cwd(), "schema");
const REMOTE = process.argv.includes("--remote");
// --bootstrap records every current schema file as already-applied WITHOUT
// executing it. Use this once on environments that ran the old per-phase
// `db:migrate:phaseN` scripts manually, so subsequent runs apply only NEW
// migrations.
const BOOTSTRAP = process.argv.includes("--bootstrap");

const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS _migrations (
  filename TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

interface AppliedRow { filename: string; sha256: string }

function wrangler(args: string[]): string {
	const out = execFileSync("npx", ["wrangler", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		env: process.env,
	});
	return out;
}

function d1Execute(opts: { command?: string; file?: string; json?: boolean }): string {
	const args = ["d1", "execute", DB_NAME];
	if (REMOTE) args.push("--remote"); else args.push("--local");
	if (opts.json) args.push("--json");
	if (opts.command) { args.push("--command", opts.command); }
	else if (opts.file) { args.push("--file", opts.file); }
	return wrangler(args);
}

function listMigrationFiles(): string[] {
	return readdirSync(SCHEMA_DIR)
		.filter((f) => f.startsWith("d1-") && f.endsWith(".sql"))
		.sort();
}

function sha(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function ensureMigrationsTable(): void {
	d1Execute({ command: MIGRATIONS_TABLE_DDL });
}

function fetchApplied(): Map<string, string> {
	const raw = d1Execute({ command: "SELECT filename, sha256 FROM _migrations", json: true });
	// wrangler d1 execute --json output: array of result blocks; pick first results
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return new Map(); }
	const arr = Array.isArray(parsed) ? parsed : [parsed];
	const first = arr[0] as { results?: AppliedRow[] } | undefined;
	const rows = first?.results ?? [];
	return new Map(rows.map((r) => [r.filename, r.sha256]));
}

function recordApplied(filename: string, hash: string): void {
	const cmd = `INSERT INTO _migrations (filename, sha256, applied_at) VALUES ('${filename.replace(/'/g, "''")}', '${hash}', unixepoch())`;
	d1Execute({ command: cmd });
}

async function main(): Promise<void> {
	console.log(`[migrate] target=${REMOTE ? "remote" : "local"} db=${DB_NAME}${BOOTSTRAP ? " (bootstrap mode)" : ""}`);

	ensureMigrationsTable();
	const applied = fetchApplied();
	const files = listMigrationFiles();

	let appliedCount = 0;
	let skippedCount = 0;
	let bootstrappedCount = 0;

	for (const filename of files) {
		const path = join(SCHEMA_DIR, filename);
		const content = readFileSync(path, "utf8");
		const hash = sha(content);
		const prev = applied.get(filename);

		if (prev) {
			if (prev !== hash) {
				console.error(`[migrate] FATAL: ${filename} has changed since it was applied (sha256 mismatch).`);
				console.error(`[migrate] Migrations are immutable once applied. Add a new file with the corrective SQL.`);
				process.exit(2);
			}
			skippedCount++;
			continue;
		}

		if (BOOTSTRAP) {
			console.log(`[migrate] bootstrap: marking ${filename} as already applied (NOT executing)`);
			recordApplied(filename, hash);
			bootstrappedCount++;
			continue;
		}

		console.log(`[migrate] applying ${filename}`);
		try {
			d1Execute({ file: path });
			recordApplied(filename, hash);
			appliedCount++;
		} catch (err) {
			console.error(`[migrate] FAILED on ${filename}:`, err instanceof Error ? err.message : err);
			console.error(`[migrate] If this file was already applied manually, run: npm run db:migrate -- --bootstrap`);
			process.exit(3);
		}
	}

	if (BOOTSTRAP) {
		console.log(`[migrate] bootstrap done — bootstrapped=${bootstrappedCount} already_tracked=${skippedCount}`);
	} else {
		console.log(`[migrate] done — applied=${appliedCount} skipped=${skippedCount}`);
	}
}

main().catch((err) => {
	console.error("[migrate] unexpected error:", err);
	process.exit(1);
});
