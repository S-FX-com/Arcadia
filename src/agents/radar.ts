// Radar — stall detection (§4 M1). Ground-truth signals only.
//
// Escalation is public at pod level. Never a private nudge only:
//   Day 3: email the named owner
//   Day 5: public pod post naming the owner AND the lead
//   Day 7: founder digest, filed under the LEAD's name, not the doer's
// The publicness is the mechanism. A quiet DM is one more thing to ignore.

import { Agent } from "agents";
import { notify } from "../integrations/notify";
import { appendAudit } from "../lib/audit";
import {
  daysStalled,
  readAllSignals,
  type ProjectSources,
  type SignalKind,
  type SignalReading,
} from "../radar/signals";

type Escalation = "none" | "dm_owner" | "pod_public" | "founder_digest";

const LADDER: Array<{ days: number; level: Escalation }> = [
  { days: 7, level: "founder_digest" },
  { days: 5, level: "pod_public" },
  { days: 3, level: "dm_owner" },
];

const RANK: Record<Escalation, number> = {
  none: 0,
  dm_owner: 1,
  pod_public: 2,
  founder_digest: 3,
};

interface ProjectRow {
  id: string;
  name: string;
  client: string | null;
  owner: string | null;
  lead: string | null;
  pod: string | null;
  sources: string;
}

interface OpenEventRow {
  id: string;
  days_stalled: number;
  escalation: string;
  detected_at: string;
}

export interface SweepSummary {
  projectsSwept: number;
  stalled: number;
  escalated: number;
  blind: number;
}

export class Radar extends Agent<Env> {
  ping(): string {
    return "ok";
  }

  async onStart() {
    // Daily sweep at 12:00 UTC (~8am America/New_York) so escalations land at
    // the start of the working day, and a Friday founder digest at 21:00 UTC.
    await this.schedule("0 12 * * 1-5", "sweep");
    await this.schedule("0 21 * * 5", "founderDigest");
  }

  private sourcesOf(row: ProjectRow): ProjectSources {
    try {
      return JSON.parse(row.sources) as ProjectSources;
    } catch {
      return {};
    }
  }

  private async fingerprints(projectId: string): Promise<Partial<Record<SignalKind, string>>> {
    const rows = await this.env.DB.prepare(
      `SELECT signal, fingerprint FROM project_signals WHERE project_id = ?1`
    )
      .bind(projectId)
      .all<{ signal: string; fingerprint: string | null }>();
    const out: Partial<Record<SignalKind, string>> = {};
    for (const r of rows.results) {
      if (r.fingerprint) out[r.signal as SignalKind] = r.fingerprint;
    }
    return out;
  }

  private async recordReadings(projectId: string, readings: SignalReading[]): Promise<void> {
    for (const r of readings) {
      await this.env.DB.prepare(
        `INSERT INTO project_signals (project_id, signal, fingerprint, last_activity_at, available, detail, read_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
         ON CONFLICT(project_id, signal) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           last_activity_at = COALESCE(excluded.last_activity_at, project_signals.last_activity_at),
           available = excluded.available,
           detail = excluded.detail,
           read_at = excluded.read_at`
      )
        .bind(
          projectId,
          r.kind,
          r.fingerprint ?? null,
          r.lastActivityAt ?? null,
          r.available ? 1 : 0,
          r.detail.slice(0, 500)
        )
        .run();
    }
  }

  /** Daily sweep across active projects. */
  async sweep(): Promise<SweepSummary> {
    const projects = (
      await this.env.DB.prepare(
        `SELECT id, name, client, owner, lead, pod, sources FROM projects WHERE status = 'active'`
      ).all<ProjectRow>()
    ).results;

    const summary: SweepSummary = { projectsSwept: projects.length, stalled: 0, escalated: 0, blind: 0 };
    // One gatekeeper session id per sweep day — the observation log groups
    // every Graph read under the sweep that made it.
    const sweepId = `radar-sweep:${new Date().toISOString().slice(0, 10)}`;

    for (const project of projects) {
      const sources = this.sourcesOf(project);
      const previous = await this.fingerprints(project.id);
      const readings = await readAllSignals(this.env, project.id, sources, previous, {
        sessionId: sweepId,
        actor: "radar",
      });
      await this.recordReadings(project.id, readings);

      const days = daysStalled(readings);
      if (days === undefined) {
        // No signal could see anything. That is a visibility gap, not a
        // stall — surface it as one so nobody reads silence as progress.
        summary.blind++;
        await appendAudit(this.env.DB, {
          actor: "radar",
          action: "project_blind",
          subject: project.id,
          detail: `no readable signal for ${project.name}: ${readings.map((r) => `${r.kind}=${r.detail}`).join("; ")}`,
        });
        continue;
      }
      if (days < 3) {
        await this.resolveOpenEvent(project.id, days);
        continue;
      }

      summary.stalled++;
      const level = LADDER.find((l) => days >= l.days)?.level ?? "none";
      const escalated = await this.escalate(project, readings, days, level);
      if (escalated) summary.escalated++;
    }

    await appendAudit(this.env.DB, {
      actor: "radar",
      action: "sweep_complete",
      detail: `${summary.projectsSwept} swept, ${summary.stalled} stalled, ${summary.escalated} escalated, ${summary.blind} blind`,
    });
    return summary;
  }

  private async resolveOpenEvent(projectId: string, days: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE stall_events SET resolved_at = datetime('now'), days_stalled = ?2
       WHERE project_id = ?1 AND resolved_at IS NULL`
    )
      .bind(projectId, days)
      .run();
  }

  /**
   * Advance the ladder. Each level fires once per stall episode — re-running
   * the sweep the next day does not re-send day 3.
   */
  private async escalate(
    project: ProjectRow,
    readings: SignalReading[],
    days: number,
    level: Escalation
  ): Promise<boolean> {
    const owner = project.owner ?? "unassigned";
    const lead = project.lead ?? "unassigned";
    const open = await this.env.DB.prepare(
      `SELECT id, days_stalled, escalation, detected_at FROM stall_events
       WHERE project_id = ?1 AND resolved_at IS NULL ORDER BY detected_at DESC LIMIT 1`
    )
      .bind(project.id)
      .first<OpenEventRow>();

    const evidence = readings
      .filter((r) => r.available)
      .map((r) => `- ${r.kind}: ${r.detail}`)
      .join("\n");
    const blind = readings.filter((r) => !r.available).map((r) => r.kind);

    if (!open) {
      const id = crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT INTO stall_events (id, project_id, signal, days_stalled, owner, lead, escalation, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'none', ?7)`
      )
        .bind(id, project.id, readings.find((r) => r.available)?.kind ?? "unknown", days, owner, lead, evidence.slice(0, 1000))
        .run();
      return this.fireLevel(project, { id, escalation: "none" }, days, level, evidence, blind);
    }

    await this.env.DB.prepare(`UPDATE stall_events SET days_stalled = ?2, detail = ?3 WHERE id = ?1`)
      .bind(open.id, days, evidence.slice(0, 1000))
      .run();
    return this.fireLevel(
      project,
      { id: open.id, escalation: (open.escalation as Escalation) ?? "none" },
      days,
      level,
      evidence,
      blind
    );
  }

  private async fireLevel(
    project: ProjectRow,
    event: { id: string; escalation: Escalation },
    days: number,
    level: Escalation,
    evidence: string,
    blind: string[]
  ): Promise<boolean> {
    if (RANK[level] <= RANK[event.escalation]) return false; // already at or past this rung

    const owner = project.owner ?? "unassigned";
    const lead = project.lead ?? "unassigned";
    const label = `${project.name}${project.client ? ` (${project.client})` : ""}`;
    const blindNote = blind.length
      ? `\n\nSignals Arcadia could not read: ${blind.join(", ")}. Those are visibility gaps, not evidence of a stall.`
      : "";

    if (level === "dm_owner") {
      await notify(this.env, {
        kind: "dm_owner",
        subject: `${label} has shown no activity for ${days} days`,
        body: `${owner} — no ground-truth activity on ${label} for ${days} days.\n\nWhat Arcadia can see:\n${evidence}${blindNote}\n\nMove it today or tell your lead what's blocking it. On day 5 this posts publicly to your pod naming you and ${lead}.`,
        owner,
        lead,
        ...(project.pod ? { pod: project.pod } : {}),
        to: owner === "unassigned" ? [] : [owner],
        publicBoard: false,
        projectId: project.id,
      });
    } else if (level === "pod_public") {
      await notify(this.env, {
        kind: "pod_public",
        subject: `PUBLIC: ${label} stalled ${days} days — owner ${owner}, lead ${lead}`,
        body: `${label} has had no ground-truth activity for ${days} days.\n\nOwner: ${owner}\nLead: ${lead}\nPod: ${project.pod ?? "unassigned"}\n\nWhat Arcadia can see:\n${evidence}${blindNote}\n\nThis is visible to the whole pod. On day 7 it goes to the founder digest filed under ${lead}.`,
        owner,
        lead,
        ...(project.pod ? { pod: project.pod } : {}),
        to: [owner, lead].filter((e) => e !== "unassigned"),
        publicBoard: true,
        projectId: project.id,
      });
    } else if (level === "founder_digest") {
      // Filed under the LEAD's name, not the doer's — the lead owns the
      // judgment call that did not get made.
      await notify(this.env, {
        kind: "founder_digest",
        subject: `FOUNDER: ${label} stalled ${days} days — filed under ${lead}`,
        body: `${label} has had no ground-truth activity for ${days} days and passed both earlier rungs without resolution.\n\nFiled under: ${lead} (lead)\nDoer: ${owner}\nPod: ${project.pod ?? "unassigned"}\n\nWhat Arcadia can see:\n${evidence}${blindNote}\n\nThe day-3 email and day-5 pod post already went out. This is now a lead escalation.`,
        owner: lead,
        lead,
        ...(project.pod ? { pod: project.pod } : {}),
        to: [lead, ...(this.env.FOUNDER_EMAIL ? [this.env.FOUNDER_EMAIL] : [])].filter((e) => e !== "unassigned"),
        publicBoard: true,
        projectId: project.id,
      });
    } else {
      return false;
    }

    await this.env.DB.prepare(`UPDATE stall_events SET escalation = ?2 WHERE id = ?1`)
      .bind(event.id, level)
      .run();
    return true;
  }

  /** Weekly roll-up of everything still open, by lead. */
  async founderDigest(): Promise<void> {
    const rows = (
      await this.env.DB.prepare(
        `SELECT s.lead, s.owner, s.days_stalled, s.escalation, p.name, p.client
           FROM stall_events s JOIN projects p ON p.id = s.project_id
          WHERE s.resolved_at IS NULL
          ORDER BY s.lead, s.days_stalled DESC`
      ).all<{
        lead: string;
        owner: string;
        days_stalled: number;
        escalation: string;
        name: string;
        client: string | null;
      }>()
    ).results;
    if (rows.length === 0) {
      await appendAudit(this.env.DB, { actor: "radar", action: "founder_digest_empty", detail: "nothing open" });
      return;
    }
    const byLead = new Map<string, typeof rows>();
    for (const r of rows) byLead.set(r.lead, [...(byLead.get(r.lead) ?? []), r]);
    const body = [...byLead.entries()]
      .map(
        ([lead, items]) =>
          `${lead} — ${items.length} open:\n${items
            .map((i) => `  - ${i.name}${i.client ? ` (${i.client})` : ""}: ${i.days_stalled} days, owner ${i.owner}, at ${i.escalation}`)
            .join("\n")}`
      )
      .join("\n\n");
    await notify(this.env, {
      kind: "founder_digest",
      subject: `Weekly stall digest — ${rows.length} open across ${byLead.size} leads`,
      body: `${body}\n\nFiled by lead. Each line is a judgment call that has not been made.`,
      to: this.env.FOUNDER_EMAIL ? [this.env.FOUNDER_EMAIL] : [],
      publicBoard: true,
    });
  }

  override async onRequest(_request: Request): Promise<Response> {
    return Response.json({ error: "use the dashboard or RPC" }, { status: 404 });
  }
}
