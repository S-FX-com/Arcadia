// Ledger — the certification ledger (§4 M2). The highest-leverage component
// in the project.
//
// Work cannot advance a stage until the doer signs a pre-flight checklist:
// timestamped, immutable, attributed. Then Arcadia independently verifies the
// subset she can. When someone signs "all links resolve" and the crawler
// finds 404s, that is a false certification event — logged, attributed,
// surfaced to their lead. Not "the project had errors." Specifically: you
// signed for something untrue.

import { Agent } from "agents";
import { checklistByKey, itemByKey } from "../certification/checklists";
import { runVerifier, type CheckResult } from "../certification/verify";
import { appendAudit } from "../lib/audit";

export interface SignInput {
  checklist: string;
  stage: string;
  projectId?: string;
  targetUrl?: string;
  /** Text the signer is certifying, when there is no crawlable URL. */
  signedText?: string;
  /** Approved source copy for the copy-diff verifier. */
  approvedCopy?: string;
  /** Item keys the signer is attesting to. Must cover the whole checklist. */
  signedItems: string[];
  signedBy: string;
}

export interface SignResult {
  certificationId: string;
  verified: number;
  failures: number;
  falseCertifications: number;
}

export class Ledger extends Agent<Env> {
  ping(): string {
    return "ok";
  }

  /**
   * Record a signature, then verify it. The signature is written before
   * verification runs and is never mutated afterwards — the verification
   * result is a separate, additive record.
   */
  async sign(input: SignInput): Promise<SignResult> {
    const def = checklistByKey(input.checklist);
    if (!def) throw new Error(`unknown checklist: ${input.checklist}`);
    if (!def.stages.includes(input.stage)) {
      throw new Error(`checklist ${def.key} does not gate stage "${input.stage}"`);
    }
    const missing = def.items.filter((i) => !input.signedItems.includes(i.key));
    if (missing.length > 0) {
      // Partial signing is not signing. Either you certify the checklist or
      // you don't advance the stage.
      throw new Error(`cannot sign: ${missing.length} item(s) unsigned — ${missing.map((m) => m.key).join(", ")}`);
    }

    const certificationId = crypto.randomUUID();
    const items = def.items.map((i) => ({ item: i.key, label: i.label, signed: true }));
    await this.env.DB.prepare(
      `INSERT INTO certifications (id, project_id, checklist, stage, signed_by, target_url, items)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
      .bind(
        certificationId,
        input.projectId ?? null,
        def.key,
        input.stage,
        input.signedBy,
        input.targetUrl ?? null,
        JSON.stringify(items)
      )
      .run();
    await appendAudit(this.env.DB, {
      actor: input.signedBy,
      action: "certification_signed",
      subject: certificationId,
      detail: `${def.key} @ ${input.stage}${input.targetUrl ? ` — ${input.targetUrl}` : ""}`,
    });

    // Verification runs in the same request so the signer sees the result
    // immediately — the feedback loop is the point.
    return this.verify(certificationId, input);
  }

  private async verify(certificationId: string, input: SignInput): Promise<SignResult> {
    const def = checklistByKey(input.checklist);
    if (!def) throw new Error(`unknown checklist: ${input.checklist}`);
    const ctx = {
      env: this.env,
      ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
      ...(input.approvedCopy ? { approvedCopy: input.approvedCopy } : {}),
    };

    const lead = await this.leadOf(input.signedBy);
    let verified = 0;
    let failures = 0;
    let falseCertifications = 0;

    for (const item of def.items) {
      if (item.verifier === "none") continue;
      let result: CheckResult;
      try {
        result = await runVerifier(item.verifier, ctx, input.signedText);
      } catch (err) {
        result = {
          verdict: "unverifiable",
          evidence: `verifier error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      await this.env.DB.prepare(
        `INSERT INTO certification_checks (id, certification_id, item, verdict, evidence)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
        .bind(crypto.randomUUID(), certificationId, item.key, result.verdict, result.evidence.slice(0, 2000))
        .run();

      if (result.verdict === "pass" || result.verdict === "partial") verified++;
      if (result.verdict === "fail") {
        failures++;
        // The signer attested to this item and Arcadia disproved it. That is
        // the false certification — recorded against the person, visible to
        // their lead.
        await this.env.DB.prepare(
          `INSERT INTO false_certifications (id, certification_id, item, signed_by, lead, evidence)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        )
          .bind(
            crypto.randomUUID(),
            certificationId,
            item.key,
            input.signedBy,
            lead ?? "unassigned",
            `Signed "${item.label}" — ${result.evidence}`.slice(0, 2000)
          )
          .run();
        falseCertifications++;
        await appendAudit(this.env.DB, {
          actor: "ledger",
          action: "false_certification",
          subject: input.signedBy,
          detail: `${def.key}/${item.key}: signed "${item.label}" but ${result.evidence.slice(0, 300)}`,
        });
      }
    }

    return { certificationId, verified, failures, falseCertifications };
  }

  private async leadOf(email: string): Promise<string | undefined> {
    const row = await this.env.DB.prepare(`SELECT lead_email FROM users WHERE lower(email) = ?1`)
      .bind(email.toLowerCase())
      .first<{ lead_email: string | null }>();
    return row?.lead_email ?? undefined;
  }

  /**
   * False-certification rate per person — the number that is the whole point
   * of the module (§4 M2).
   */
  async ratesByPerson(): Promise<
    Array<{ signedBy: string; lead: string | null; signatures: number; falseCerts: number; rate: number }>
  > {
    const rows = await this.env.DB.prepare(
      `SELECT c.signed_by AS signed_by,
              (SELECT lead_email FROM users u WHERE lower(u.email) = lower(c.signed_by)) AS lead,
              COUNT(DISTINCT c.id) AS signatures,
              (SELECT COUNT(*) FROM false_certifications f WHERE lower(f.signed_by) = lower(c.signed_by)) AS false_certs
         FROM certifications c
        GROUP BY lower(c.signed_by)
        ORDER BY false_certs DESC, signatures DESC`
    ).all<{ signed_by: string; lead: string | null; signatures: number; false_certs: number }>();
    return rows.results.map((r) => ({
      signedBy: r.signed_by,
      lead: r.lead,
      signatures: r.signatures,
      falseCerts: r.false_certs,
      rate: r.signatures > 0 ? r.false_certs / r.signatures : 0,
    }));
  }

  /** Same number rolled up per pod. */
  async ratesByPod(): Promise<Array<{ pod: string; signatures: number; falseCerts: number; rate: number }>> {
    const rows = await this.env.DB.prepare(
      `SELECT COALESCE(u.pod, 'unassigned') AS pod,
              COUNT(DISTINCT c.id) AS signatures,
              SUM(CASE WHEN f.id IS NOT NULL THEN 1 ELSE 0 END) AS false_certs
         FROM certifications c
         LEFT JOIN users u ON lower(u.email) = lower(c.signed_by)
         LEFT JOIN false_certifications f ON f.certification_id = c.id
        GROUP BY COALESCE(u.pod, 'unassigned')
        ORDER BY false_certs DESC`
    ).all<{ pod: string; signatures: number; false_certs: number }>();
    return rows.results.map((r) => ({
      pod: r.pod,
      signatures: r.signatures,
      falseCerts: r.false_certs ?? 0,
      rate: r.signatures > 0 ? (r.false_certs ?? 0) / r.signatures : 0,
    }));
  }

  override async onRequest(_request: Request): Promise<Response> {
    return Response.json({ error: "use the dashboard or RPC" }, { status: 404 });
  }
}
