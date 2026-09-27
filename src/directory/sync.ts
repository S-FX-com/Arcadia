// One directory sync. Active member users land in directory_profiles.
// The manager proof runs only when Graph credentials exist; otherwise the
// run is logged as skipped and no call is made. A failed proof does not
// write a manager id.

import { openDirectorySession } from "../gatekeepers/directory";
import type { GatekeeperContext } from "../gatekeepers/types";
import { appendAudit } from "../lib/audit";
import {
  classifyManagerCall,
  directoryEmail,
  selectActiveMembers,
  type DirectoryUserInput,
  type ManagerProof,
} from "../lib/directory-merge";
import { graphAvailable } from "../integrations/graph";

export interface DirectorySyncResult {
  usersSeen: number;
  proof: ManagerProof & { detail: string };
}

function phones(value: DirectoryUserInput["businessPhones"]): string {
  return JSON.stringify(Array.isArray(value) ? value.filter((phone) => typeof phone === "string") : []);
}

export async function syncDirectory(env: Env, ctx: GatekeeperContext): Promise<DirectorySyncResult> {
  const id = crypto.randomUUID();
  const started = new Date().toISOString();
  if (!graphAvailable(env)) {
    const proof = classifyManagerCall({ called: false });
    await env.DB.prepare(
      `INSERT INTO directory_sync_runs
         (id, started_at, finished_at, users_seen, manager_proof, detail)
       VALUES (?1, ?2, ?3, 0, ?4, ?5)`
    )
      .bind(id, started, new Date().toISOString(), proof.status, proof.detail)
      .run();
    await appendAudit(env.DB, {
      actor: ctx.actor,
      action: "directory_sync_skipped",
      subject: id,
      detail: proof.detail,
    });
    return { usersSeen: 0, proof };
  }

  const session = openDirectorySession(env, ctx);
  const members = selectActiveMembers(await session.listUsers());
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

  // An empty read must not mark the whole cache disabled — that is a
  // failure, not a tenant with nobody in it.
  if (members.length > 0) {
    const ids = members.map((user) => user.id).filter((value): value is string => Boolean(value));
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
    await env.DB.prepare(
      `UPDATE directory_profiles SET account_enabled = 0 WHERE aad_id NOT IN (${placeholders})`
    )
      .bind(...ids)
      .run();
  }

  const probed = members[0]?.id;
  const proof = probed
    ? { ...classifyManagerCall(await session.proveManager(probed)), probedAadId: probed }
    : classifyManagerCall({
        called: true,
        ok: false,
        message: "No active member user to probe. Manager was not requested.",
      });

  await env.DB.prepare(
    `INSERT INTO directory_sync_runs
       (id, started_at, finished_at, users_seen, manager_proof, probed_aad_id, manager_aad_id, manager_mail, detail)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(
      id,
      started,
      new Date().toISOString(),
      members.length,
      proof.status,
      proof.probedAadId ?? null,
      proof.status === "succeeded" ? (proof.managerId ?? null) : null,
      proof.status === "succeeded" ? (proof.managerMail ?? null) : null,
      proof.detail
    )
    .run();
  await appendAudit(env.DB, {
    actor: ctx.actor,
    action: "directory_synced",
    subject: id,
    detail: `${members.length} active member(s). Manager proof: ${proof.status}. ${proof.detail}`,
  });
  return { usersSeen: members.length, proof };
}

export async function latestDirectoryProof(env: Env): Promise<(ManagerProof & { detail: string; finishedAt: string | null }) | null> {
  const row = await env.DB.prepare(
    `SELECT manager_proof, probed_aad_id, manager_aad_id, manager_mail, detail, finished_at
       FROM directory_sync_runs ORDER BY started_at DESC LIMIT 1`
  ).first<{
    manager_proof: ManagerProof["status"];
    probed_aad_id: string | null;
    manager_aad_id: string | null;
    manager_mail: string | null;
    detail: string | null;
    finished_at: string | null;
  }>();
  if (!row) return null;
  return {
    status: row.manager_proof,
    ...(row.probed_aad_id ? { probedAadId: row.probed_aad_id } : {}),
    ...(row.manager_proof === "succeeded" && row.manager_aad_id ? { managerId: row.manager_aad_id } : {}),
    ...(row.manager_proof === "succeeded" && row.manager_mail ? { managerMail: row.manager_mail } : {}),
    detail: row.detail ?? "",
    finishedAt: row.finished_at,
  };
}
