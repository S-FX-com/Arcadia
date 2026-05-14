#!/usr/bin/env tsx
// Idempotent forward-only schema migrator for Arcadia.
//
// Applies every schema/NNNN_*.sql file in order. Records each applied
// filename in _schema_migrations. Re-running is safe — the first migration
// is always applied unconditionally (its CREATEs are IF NOT EXISTS), and
// the rest are skipped if already recorded.
//
//   tsx scripts/migrate.ts            # local D1
//   tsx scripts/migrate.ts --remote   # production D1

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

const SCHEMA_DIR = "schema";
const DB_NAME = "arcadia-db";
const remote = process.argv.includes("--remote");
const flag = remote ? "--remote" : "--local";

async function listMigrations(): Promise<string[]> {
  const entries = await readdir(SCHEMA_DIR);
  return entries.filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
}

function applied(): Set<string> {
  try {
    const out = execSync(
      `npx wrangler d1 execute ${DB_NAME} ${flag} --command "SELECT filename FROM _schema_migrations" --json`,
      { stdio: ["pipe", "pipe", "pipe"] }
    ).toString();
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed[0]?.results ?? [] : [];
    return new Set(rows.map((r: { filename: string }) => r.filename));
  } catch {
    return new Set();
  }
}

function apply(file: string) {
  const path = join(SCHEMA_DIR, file);
  console.log(`→ ${file}`);
  execSync(`npx wrangler d1 execute ${DB_NAME} ${flag} --file=${path}`, {
    stdio: "inherit",
  });
}

async function main() {
  const all = await listMigrations();
  if (all.length === 0) {
    console.log("no migrations found");
    return;
  }

  // First migration creates the tracking table itself — always run it.
  apply(all[0]);

  const done = applied();
  for (const f of all.slice(1)) {
    if (done.has(f)) {
      console.log(`✓ ${f}`);
      continue;
    }
    apply(f);
  }
  console.log("migrations complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
