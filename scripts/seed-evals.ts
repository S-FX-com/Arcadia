#!/usr/bin/env tsx
// Seed the eval_cases table from evals/cases/*.json.
//
// Each JSON file is treated as one row. The file's basename (minus
// .json) becomes the case id so re-runs are idempotent — existing
// rows are replaced.
//
// Usage:
//   tsx scripts/seed-evals.ts            # local D1
//   tsx scripts/seed-evals.ts --remote   # production D1

import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";

const CASES_DIR = "evals/cases";
const DB_NAME = "arcadia-db";
const remote = process.argv.includes("--remote");
const flag = remote ? "--remote" : "--local";

interface CaseFile {
  name?: string;
  prompt?: string;
  expected?: string;
  user_aad_id?: string;
  tenant_id?: string;
  scope_type?: string;
  scope_id?: string;
  tags?: string[];
}

async function main(): Promise<void> {
  const entries = await readdir(CASES_DIR);
  const files = entries.filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.warn(`no .json under ${CASES_DIR}`);
    return;
  }

  const statements: string[] = [];
  let prepared = 0;
  for (const file of files) {
    const raw = await readFile(join(CASES_DIR, file), "utf8");
    let parsed: CaseFile;
    try {
      parsed = JSON.parse(raw) as CaseFile;
    } catch (e) {
      console.warn(`skip ${file}: ${String(e)}`);
      continue;
    }
    if (!parsed.prompt || !parsed.expected) {
      console.warn(`skip ${file}: missing prompt or expected`);
      continue;
    }
    const id = basename(file, ".json");
    const tags = (parsed.tags ?? []).join(",");
    const input = JSON.stringify({
      name: parsed.name ?? id,
      prompt: parsed.prompt,
      ...(parsed.user_aad_id ? { user_aad_id: parsed.user_aad_id } : {}),
      ...(parsed.tenant_id ? { tenant_id: parsed.tenant_id } : {}),
      ...(parsed.scope_type ? { scope_type: parsed.scope_type } : {}),
      ...(parsed.scope_id ? { scope_id: parsed.scope_id } : {}),
    });
    const expected = JSON.stringify({ expected: parsed.expected });

    statements.push(
      `INSERT OR REPLACE INTO eval_cases (id, kind, tags, input_json, expected_json) ` +
        `VALUES (${sqlQuote(id)}, 'default', ${sqlQuote(tags)}, ${sqlQuote(input)}, ${sqlQuote(expected)});`,
    );
    prepared += 1;
  }

  if (statements.length === 0) {
    console.warn("nothing to seed");
    return;
  }

  const tmpFile = `/tmp/arcadia-seed-evals-${Date.now()}.sql`;
  await writeFile(tmpFile, statements.join("\n"), "utf8");
  try {
    execSync(
      `npx wrangler d1 execute ${DB_NAME} ${flag} --file ${tmpFile}`,
      { stdio: "inherit" },
    );
    console.log(`seeded ${prepared} eval case(s)`);
  } finally {
    await unlink(tmpFile).catch(() => {
      /* best effort */
    });
  }
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

void main();
