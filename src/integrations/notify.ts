// Notification transport. Escalations are public at pod level (§4 M1) — a
// quiet DM is one more thing to ignore, so every escalation lands on the
// durable accountability board first and email goes out on top of it.
//
// Teams DMs and channel posts arrive with the Azure Bot registration in
// Phase 2 (§9.7). Until then email + board carries the publicness.

import { appendAudit } from "../lib/audit";

export interface Notification {
  /** 'dm_owner' | 'pod_public' | 'founder_digest' | 'dispatch' | 'sla_breach' */
  kind: string;
  subject: string;
  body: string;
  /** Named humans this is about — always attributed, never anonymous. */
  owner?: string;
  lead?: string;
  pod?: string;
  /** Recipients for the email leg. */
  to: string[];
  /** True for pod-level and founder escalations: visible to everyone. */
  publicBoard: boolean;
  projectId?: string;
}

export interface NotifyResult {
  boardPostId: string;
  emailed: boolean;
  emailError?: string;
}

/**
 * Post to the accountability board and send email if a provider is
 * configured. The board write is the durable part — email is best effort and
 * its failure never loses the escalation.
 */
export async function notify(env: Env, n: Notification): Promise<NotifyResult> {
  const boardPostId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO board_posts (id, kind, subject, body, owner, lead, pod, project_id, public)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(
      boardPostId,
      n.kind,
      n.subject,
      n.body,
      n.owner ?? null,
      n.lead ?? null,
      n.pod ?? null,
      n.projectId ?? null,
      n.publicBoard ? 1 : 0
    )
    .run();

  let emailed = false;
  let emailError: string | undefined;
  if (n.to.length > 0) {
    try {
      emailed = await sendEmail(env, n);
    } catch (err) {
      emailError = err instanceof Error ? err.message : String(err);
    }
  }

  await env.DB.prepare(
    `INSERT INTO notifications (id, kind, recipients, subject, delivered, error, board_post_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(
      crypto.randomUUID(),
      n.kind,
      JSON.stringify(n.to),
      n.subject,
      emailed ? 1 : 0,
      emailError ?? null,
      boardPostId
    )
    .run();

  await appendAudit(env.DB, {
    actor: "arcadia",
    action: `escalation_${n.kind}`,
    subject: n.owner ?? n.projectId,
    detail: `${n.subject}${emailed ? " (emailed)" : emailError ? ` (email failed: ${emailError})` : " (board only)"}`,
  });

  return { boardPostId, emailed, ...(emailError ? { emailError } : {}) };
}

/**
 * Resend-compatible HTTP API. Any provider with the same shape works; set
 * EMAIL_API_URL to point elsewhere. Unconfigured means board-only, which is
 * a supported mode, not an error.
 */
async function sendEmail(env: Env, n: Notification): Promise<boolean> {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) return false;
  const url = env.EMAIL_API_URL ?? "https://api.resend.com/emails";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: n.to,
      subject: n.subject,
      text: n.body,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`email provider ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return true;
}
