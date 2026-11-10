// One roster sync. Active member users land in directory_profiles and
// everyone else is marked account_enabled = 0. With no Graph credentials the
// run is logged as skipped and no call is made.

import { appendAudit } from "../lib/audit";
import { directoryEmail, selectActiveMembers, type DirectoryUserInput } from "../lib/directory-merge";
import { graphAvailable, GraphError, listMemberUsers } from "../integrations/graph";
import { plainDirectoryFailure } from "../lib/m365-sync";

export type DirectorySyncStatus = "skipped" | "failed" | "succeeded";

export interface DirectorySyncResult {
  usersSeen: number;
  status: DirectorySyncStatus;
  detail: string;
  error: string | null;
}

/**
 * The run status lives in directory_sync_runs.manager_proof, a legacy column
 * name from v5 (NOT NULL, CHECK skipped|failed|succeeded). probed_aad_id,
 * manager_aad_id and manager_mail are left NULL.
 */
async function recordRun(
  env: Env,
  run: { id: string; started: string; usersSeen: number; status: DirectorySyncStatus; detail: string }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO directory_sync_runs (id, started_at, finished_at, users_seen, manager_proof, detail)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(run.id, run.started, new Date().toISOString(), run.usersSeen, run.status, run.detail)
    .run();
}

function phones(value: DirectoryUserInput["businessPhones"]): string {
  return JSON.stringify(Array.isArray(value) ? value.filter((phone) => typeof phone === "string") : []);
}

export async function syncDirectory(env: Env, actor: string): Promise<DirectorySyncResult> {
  const id = crypto.randomUUID();
  const started = new Date().toISOString();
  if (!graphAvailable(env)) {
    const detail = "Graph credentials are not configured. No profiles were read.";
    await recordRun(env, { id, started, usersSeen: 0, status: "skipped", detail });
    await appendAudit(env.DB, { actor, action: "directory_sync_skipped", subject: id, detail });
    return { usersSeen: 0, status: "skipped", detail, error: null };
  }

  let members: ReturnType<typeof selectActiveMembers>;
  try {
    members = selectActiveMembers(await listMemberUsers(env));
  } catch (err) {
    const status = err instanceof GraphError ? err.status : undefined;
    const error = plainDirectoryFailure(status);
    console.error("directory sync", err);
    await recordRun(env, { id, started, usersSeen: 0, status: "failed", detail: error });
    await appendAudit(env.DB, { actor, action: "directory_sync_failed", subject: id, detail: error });
    return { usersSeen: 0, status: "failed", detail: error, error };
  }
  // An empty read is a failure, not a tenant with nobody in it. It must not
  // mark the whole roster disabled.
  if (members.length === 0) {
    const error = "Microsoft 365 returned no active member users. The roster was left as it was.";
    await recordRun(env, { id, started, usersSeen: 0, status: "failed", detail: error });
    await appendAudit(env.DB, { actor, action: "directory_sync_failed", subject: id, detail: error });
    return { usersSeen: 0, status: "failed", detail: error, error };
  }

  for (const user of members) {
    if (!user.id) continue;
    await env.DB.prepare(
      `INSERT INTO directory_profiles
         (aad_id, mail, display_name, job_title, department, office_location, mobile_phone,
          business_phones, city, state, country, account_enabled, user_type, synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, 'Member', ?12)
       ON CONFLICT(aad_id) DO UPDATE SET
         mail = excluded.mail,
         display_name = excluded.display_name,
         job_title = excluded.job_title,
         department = excluded.department,
         office_location = excluded.office_location,
         mobile_phone = excluded.mobile_phone,
         business_phones = excluded.business_phones,
         city = excluded.city,
         state = excluded.state,
         country = excluded.country,
         account_enabled = 1,
         user_type = 'Member',
         synced_at = excluded.synced_at`
    )
      .bind(
        user.id,
        directoryEmail(user),
        user.displayName ?? null,
        user.jobTitle ?? null,
        user.department ?? null,
        user.officeLocation ?? null,
        user.mobilePhone ?? null,
        phones(user.businessPhones),
        user.city ?? null,
        user.state ?? null,
        user.country ?? null,
        new Date().toISOString()
      )
      .run();
  }

  const ids = members.map((user) => user.id).filter((value): value is string => Boolean(value));
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  await env.DB.prepare(`UPDATE directory_profiles SET account_enabled = 0 WHERE aad_id NOT IN (${placeholders})`)
    .bind(...ids)
    .run();

  const detail = `${members.length} active member(s).`;
  await recordRun(env, { id, started, usersSeen: members.length, status: "succeeded", detail });
  await appendAudit(env.DB, { actor, action: "directory_synced", subject: id, detail });
  return { usersSeen: members.length, status: "succeeded", detail, error: null };
}
