// Shared facts for the Microsoft 365 sync panel, and the never-synced open.

import { syncDirectory } from "../directory/sync";
import { graphAvailable } from "../integrations/graph";
import { refreshPlanIndex } from "../patterns/plan-index-job";
import { notIgnoredSql } from "../lib/directory-ignore";
import { kickIfNeverSynced, directoryLastError, planLastError } from "../lib/m365-sync";

export interface SyncFacts {
  hasRun: boolean;
  lastSynced: string | null;
  rowCount: number;
  lastError: string | null;
}

export async function directorySyncFacts(env: Env): Promise<SyncFacts> {
  const run = await env.DB.prepare(
    `SELECT finished_at, users_seen, manager_proof, detail
       FROM directory_sync_runs ORDER BY started_at DESC LIMIT 1`
  ).first<{ finished_at: string | null; users_seen: number; manager_proof: string; detail: string | null }>();
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM directory_profiles
      WHERE account_enabled = 1 AND ${notIgnoredSql("directory_profiles.aad_id")}`
  ).first<{ n: number }>();
  return {
    hasRun: Boolean(run),
    lastSynced: run?.finished_at ?? null,
    rowCount: count?.n ?? 0,
    lastError: directoryLastError(
      run ? { manager_proof: run.manager_proof, users_seen: run.users_seen, detail: run.detail } : null
    ),
  };
}

export async function planSyncFacts(env: Env): Promise<SyncFacts> {
  const run = await env.DB.prepare(
    `SELECT finished_at, detail FROM planner_index_runs ORDER BY finished_at DESC LIMIT 1`
  ).first<{ finished_at: string; detail: string | null }>();
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM planner_plan_index`).first<{ n: number }>();
  return {
    hasRun: Boolean(run),
    lastSynced: run?.finished_at ?? null,
    rowCount: count?.n ?? 0,
    lastError: planLastError(run?.detail),
  };
}

/** Start the job when this source has never synced. Inline runs finish before the caller re-reads. */
export async function autoSyncIfNeeded(
  env: Env,
  kind: "directory" | "plans",
  hasRun: boolean
): Promise<string | undefined> {
  let scheduled = false;
  const outcome = await kickIfNeverSynced({
    hasRun,
    connected: graphAvailable(env),
    start: async () => {
      // Loaded on use so a page module does not pull the agents SDK into unit tests.
      const { startM365Job } = await import("../lib/m365-sync-start");
      const mode = await startM365Job(env, kind, async () => {
        if (kind === "plans") {
          await refreshPlanIndex(env, { sessionId: `plan-index:${crypto.randomUUID()}`, actor: "arcadia" });
          return;
        }
        await syncDirectory(env, { sessionId: `directory:${crypto.randomUUID()}`, actor: "arcadia" });
      });
      scheduled = mode === "scheduled";
    },
  });
  if (outcome === "started" && scheduled) return "Sync started. Reload this page in a moment.";
  return undefined;
}
