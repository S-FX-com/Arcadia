#!/usr/bin/env tsx
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Backfill source-resource pointers on legacy memories
//
// Phase 1 left memories created before commit B without source_resource_*
// columns populated. Under permissive ACL enforcement they remain visible
// to all callers; under strict enforcement they become invisible.
//
// This script walks the memories table (and client_memories) and best-effort
// attaches a source pointer using the existing source_channel_id /
// source_user_id columns when present. Channel-scoped memories become
// teams_channel/{channel_id}; user-scoped DM memories become
// teams_chat/{user_id} (a placeholder that will not match any ACL but at
// least leaves the row tagged so a follow-up enrichment pass can fix it).
//
// Usage:
//   npm run db:backfill-acl                  # local D1
//   npm run db:backfill-acl -- --remote      # remote D1
//   npm run db:backfill-acl -- --dry-run     # report without writing
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";

const DB_NAME = "arcadia-db";
const REMOTE = process.argv.includes("--remote");
const DRY_RUN = process.argv.includes("--dry-run");

function d1(command: string): string {
	const args = ["wrangler", "d1", "execute", DB_NAME];
	if (REMOTE) args.push("--remote"); else args.push("--local");
	args.push("--json", "--command", command);
	const isWin = process.platform === "win32";
	if (isWin) {
		const quote = (s: string) => /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
		const cmd = ["npx", ...args].map(quote).join(" ");
		return execFileSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: true });
	}
	return execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function hasColumn(table: string, column: string): boolean {
	const out = d1(`PRAGMA table_info(${table})`);
	const start = out.search(/[\[{]/);
	const slice = start >= 0 ? out.slice(start) : out;
	const parsed = JSON.parse(slice) as Array<{ results?: Array<{ name: string }> }>;
	return (parsed[0]?.results ?? []).some((c) => c.name === column);
}

function countNeedingBackfill(table: string): number {
	const out = d1(
		`SELECT COUNT(*) AS n FROM ${table} WHERE source_resource_id IS NULL AND source_channel_id IS NOT NULL`,
	);
	const parsed = JSON.parse(out) as Array<{ results?: Array<{ n: number }> }>;
	return parsed[0]?.results?.[0]?.n ?? 0;
}

function backfill(table: string): void {
	if (!hasColumn(table, "source_channel_id")) {
		console.log(`[backfill] ${table}: no source_channel_id column — skipping`);
		return;
	}
	const action = DRY_RUN ? "would update" : "updating";
	const channelCount = countNeedingBackfill(table);
	console.log(`[backfill] ${table}: ${action} ${channelCount} channel-scoped rows`);
	if (DRY_RUN || channelCount === 0) return;

	d1(
		`UPDATE ${table}
		    SET source_resource_type = 'teams_channel',
		        source_resource_id   = source_channel_id
		  WHERE source_resource_id IS NULL
		    AND source_channel_id IS NOT NULL`,
	);
	console.log(`[backfill] ${table}: done`);
}

function main(): void {
	console.log(`[backfill] target=${REMOTE ? "remote" : "local"}${DRY_RUN ? " (dry-run)" : ""}`);
	console.log(`[backfill] NOTE: this only tags rows with source_channel_id set.`);
	console.log(`[backfill] DM-only memories without channel context remain untagged.`);
	console.log(`[backfill] resource_acl rows must still be populated for these channels`);
	console.log(`[backfill] before flipping ACL_ENFORCEMENT to "strict".`);

	backfill("memories");
	backfill("client_memories");

	console.log(`[backfill] complete`);
}

main();
