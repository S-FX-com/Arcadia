// Facts for the Directory's Microsoft 365 sync panel, and the never-synced open.

import { syncDirectory } from "../directory/sync";
import { graphAvailable } from "../integrations/graph";
import { notIgnoredSql } from "../lib/directory-ignore";
import { kickIfNeverSynced, directoryLastError } from "../lib/m365-sync";

export interface SyncFacts {
  hasRun: boolean;
  lastSynced: string | null;
  rowCount: number;
  lastError: string | null;
}

export async function directorySyncFacts(env: Env): Promise<SyncFacts> {
  // manager_proof holds the run status (skipped | failed | succeeded); the column name is legacy.
  const run = await env.DB.prepare(
    `SELECT finished_at, manager_proof, detail
       FROM directory_sync_runs ORDER BY started_at DESC LIMIT 1`
  ).first<{ finished_at: string | null; manager_proof: string; detail: string | null }>();
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM directory_profiles
      WHERE account_enabled = 1 AND ${notIgnoredSql("directory_profiles.aad_id")}`
  ).first<{ n: number }>();
  return {
    hasRun: Boolean(run),
    lastSynced: run?.finished_at ?? null,
    rowCount: count?.n ?? 0,
    lastError: directoryLastError(run ? { manager_proof: run.manager_proof, detail: run.detail } : null),
  };
}

/** Start the directory sync when it has never run. Inline runs finish before the caller re-reads. */
export async function autoSyncIfNeeded(env: Env, hasRun: boolean): Promise<string | undefined> {
  let scheduled = false;
  const outcome = await kickIfNeverSynced({
    hasRun,
    connected: graphAvailable(env),
    start: async () => {
      // Loaded on use so a page module does not pull the agents SDK into unit tests.
      const { startM365Job } = await import("../lib/m365-sync-start");
      const mode = await startM365Job(env, "directory", async () => {
        await syncDirectory(env, "arcadia");
      });
      scheduled = mode === "scheduled";
    },
  });
  if (outcome === "started" && scheduled) return "Sync started. Reload this page in a moment.";
  return undefined;
}
