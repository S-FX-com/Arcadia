// Org pulse — tenant-wide "what is happening right now" synthesis
// (EXECUTION-PLAN §Phase 3 item 1).
//
// This is the admin-only generalization of src/intelligence/client-status.ts.
// Where client-status federates over one Client's asset bundle, org-pulse
// federates over the *entire tenant* and asks the Router to compose a single
// sectioned read on the whole org. Because it aggregates tenant-wide with no
// per-viewer ACL trimming, it is admin-only — the caller (org-pulse-api.ts)
// must reject non-admins before this runs.
//
// What's pulled (last WINDOW_DAYS unless noted):
//   - Active workstreams: channels with the most recent activity (digests),
//     plus their drivers (recent decision-makers in the channel).
//   - Decisions in flight: recent rows from `decisions`.
//   - Stalled: stale threads (same signal src/intelligence/stale.ts marks —
//     threads.stale_at IS NOT NULL).
//   - At-risk: open/in_progress tasks past or near deadline (same shape the
//     nudge engine scans — src/intelligence/nudge.ts).
//   - Unusual silences: channels whose activity dropped sharply vs their own
//     prior-window norm. This is a heuristic and is labeled as *inference*
//     per SOUL.md ("when her inference is uncertain, she labels it").
//
// The signals are gathered deterministically from D1, then handed to the
// Router (deep tier) with injectCharter to compose the sectioned pulse. If the
// model errors or returns unparseable output we fall back to a deterministic
// rendering of the same signals, so the endpoint never hard-fails on an AI hop.
//
// Output shape mirrors ClientStatus (generatedAt / summary / sections /
// counts) so the frontend can reuse the same section components.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import type { CompleteRequest, CompleteResponse } from "../ai/types";
import { injectCharter } from "../charter/inject";

export interface OrgPulseSection {
  title: string;
  bullets: string[];
}

export interface OrgPulseCounts {
  activeWorkstreams: number;
  decisionsInFlight: number;
  stalledThreads: number;
  atRiskTasks: number;
  unusualSilences: number;
}

export interface OrgPulse {
  generatedAt: string;
  summary: string;
  sections: OrgPulseSection[];
  counts: OrgPulseCounts;
}

export interface OrgPulseOptions {
  tenantId: string;
  /** Look-back window in days. Defaults to WINDOW_DAYS (7). */
  windowDays?: number;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface WorkstreamRow {
  channel_id: string;
  channel_display_name: string | null;
  digest_count: number;
  last_activity_at: string;
  drivers: string[];
}

export interface OrgDecisionRow {
  text: string;
  decided_at: string;
  decided_by: string | null;
  channel_display_name: string | null;
}

export interface StalledRow {
  topic: string | null;
  last_activity_at: string;
  channel_display_name: string | null;
}

export interface AtRiskRow {
  id: string;
  title: string;
  owner_display_name: string | null;
  deadline_at: string | null;
  priority: string;
  status: string;
}

export interface SilenceRow {
  channel_display_name: string | null;
  recent: number;
  prior: number;
}

// ---------------------------------------------------------------------------
// Injectable seam — mirrors SearchDeps (src/webapp/search-api.ts): integration
// tests substitute a fake Router (returning canned sections) and/or spy on the
// data-fetch fns, without a live provider or Graph.
// ---------------------------------------------------------------------------

export interface OrgPulseDeps {
  router: Pick<Router, "complete">;
  fetchWorkstreams: (
    env: Env,
    tenantId: string,
    cutoff: string,
  ) => Promise<WorkstreamRow[]>;
  fetchDecisions: (
    env: Env,
    tenantId: string,
    cutoff: string,
  ) => Promise<OrgDecisionRow[]>;
  fetchStalled: (env: Env, tenantId: string) => Promise<StalledRow[]>;
  fetchAtRisk: (
    env: Env,
    tenantId: string,
    deadlineWindow: string,
  ) => Promise<AtRiskRow[]>;
  fetchSilences: (
    env: Env,
    tenantId: string,
    windowDays: number,
  ) => Promise<SilenceRow[]>;
}

function resolveDeps(env: Env, deps?: Partial<OrgPulseDeps>): OrgPulseDeps {
  return {
    router: deps?.router ?? new Router(env),
    fetchWorkstreams: deps?.fetchWorkstreams ?? fetchWorkstreams,
    fetchDecisions: deps?.fetchDecisions ?? fetchDecisions,
    fetchStalled: deps?.fetchStalled ?? fetchStalled,
    fetchAtRisk: deps?.fetchAtRisk ?? fetchAtRisk,
    fetchSilences: deps?.fetchSilences ?? fetchSilences,
  };
}

const WINDOW_DAYS = 7;
const MAX_PER_LIST = 10;
const MAX_DRIVERS = 3;
const AT_RISK_HOURS = 48;
const SILENCE_MIN_PRIOR = 2;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function generateOrgPulse(
  env: Env,
  opts: OrgPulseOptions,
  deps?: Partial<OrgPulseDeps>,
): Promise<OrgPulse> {
  const d = resolveDeps(env, deps);
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const cutoff = new Date(
    Date.now() - windowDays * 24 * 3600 * 1000,
  ).toISOString();
  const deadlineWindow = new Date(
    Date.now() + AT_RISK_HOURS * 3600 * 1000,
  ).toISOString();

  const [workstreams, decisions, stalled, atRisk, silences] =
    await Promise.all([
      d.fetchWorkstreams(env, opts.tenantId, cutoff),
      d.fetchDecisions(env, opts.tenantId, cutoff),
      d.fetchStalled(env, opts.tenantId),
      d.fetchAtRisk(env, opts.tenantId, deadlineWindow),
      d.fetchSilences(env, opts.tenantId, windowDays),
    ]);

  const counts: OrgPulseCounts = {
    activeWorkstreams: workstreams.length,
    decisionsInFlight: decisions.length,
    stalledThreads: stalled.length,
    atRiskTasks: atRisk.length,
    unusualSilences: silences.length,
  };

  const deterministic = deterministicSections(
    workstreams,
    decisions,
    stalled,
    atRisk,
    silences,
  );

  const composed = await compose(env, d.router, deterministic);

  return {
    generatedAt: new Date().toISOString(),
    summary: composed.summary,
    sections: composed.sections,
    counts,
  };
}

// ---------------------------------------------------------------------------
// AI composition
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Arcadia, giving the operator a fast, honest read on the *whole org* right now.

You receive raw signals grouped by category. Compose a sectioned status the operator can scan in seconds. Return STRICT JSON only, no prose outside it:

{
  "summary": "<2-4 sentence lead: the most important thing happening, what is at risk, what to push on next>",
  "sections": [
    { "title": "<section name>", "bullets": ["<tight bullet>", "..."] }
  ]
}

Rules:
- Keep the section titles aligned to the input categories (Active workstreams, Decisions in flight, Stalled threads, At-risk tasks, Unusual silences).
- Each bullet leads with the answer, names people/channels when relevant, under 140 characters.
- Drop empty categories rather than emitting a section with no bullets.
- "Unusual silences" are INFERENCE, not fact — phrase them as such ("looks like", "may be") and never assert a cause.
- No filler. Speak in your own voice.`;

async function compose(
  env: Env,
  router: Pick<Router, "complete">,
  deterministic: { summary: string; sections: OrgPulseSection[] },
): Promise<{ summary: string; sections: OrgPulseSection[] }> {
  const nonEmpty = deterministic.sections.filter((s) => s.bullets.length > 0);
  if (nonEmpty.length === 0) {
    return {
      summary: "Nothing notable across the org right now.",
      sections: [],
    };
  }

  const corpus = nonEmpty
    .map((s) => `## ${s.title}\n${s.bullets.map((b) => `- ${b}`).join("\n")}`)
    .join("\n\n");

  try {
    const system = await injectCharter(env, SYSTEM_PROMPT);
    const req: CompleteRequest = {
      system,
      messages: [{ role: "user", content: `Signals:\n\n${corpus}` }],
      tier: "deep",
      maxTokens: 1200,
    };
    const reply: CompleteResponse = await router.complete(req);
    const parsed = parsePulse(reply.text);
    if (parsed && parsed.sections.length > 0) return parsed;
  } catch {
    // AI hop failed — fall back to the deterministic rendering below rather
    // than hard-failing the endpoint on a provider error.
  }
  return { summary: deterministic.summary, sections: nonEmpty };
}

function parsePulse(
  raw: string,
): { summary: string; sections: OrgPulseSection[] } | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as {
      summary?: unknown;
      sections?: unknown;
    };
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (!Array.isArray(obj.sections)) return null;
    const sections: OrgPulseSection[] = [];
    for (const s of obj.sections) {
      if (!s || typeof s !== "object") continue;
      const r = s as Record<string, unknown>;
      const title = typeof r.title === "string" ? r.title.trim() : "";
      if (!title || !Array.isArray(r.bullets)) continue;
      const bullets = r.bullets
        .filter((b): b is string => typeof b === "string")
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
      if (bullets.length === 0) continue;
      sections.push({ title, bullets });
    }
    if (sections.length === 0) return null;
    return { summary, sections };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic fallback rendering (also the corpus fed to the Router)
// ---------------------------------------------------------------------------

function deterministicSections(
  workstreams: WorkstreamRow[],
  decisions: OrgDecisionRow[],
  stalled: StalledRow[],
  atRisk: AtRiskRow[],
  silences: SilenceRow[],
): { summary: string; sections: OrgPulseSection[] } {
  const sections: OrgPulseSection[] = [
    {
      title: "Active workstreams",
      bullets: workstreams.map(formatWorkstream),
    },
    {
      title: "Decisions in flight",
      bullets: decisions.map(formatDecision),
    },
    {
      title: "Stalled threads",
      bullets: stalled.map(formatStalled),
    },
    {
      title: "At-risk tasks",
      bullets: atRisk.map(formatTask),
    },
    {
      title: "Unusual silences",
      bullets: silences.map(formatSilence),
    },
  ];

  const nonEmpty = sections.filter((s) => s.bullets.length > 0);
  const summary = nonEmpty.length
    ? nonEmpty
        .map((s) => `${s.bullets.length} ${s.title.toLowerCase()}`)
        .join(", ")
    : "Nothing notable across the org right now.";

  return { summary, sections };
}

function formatWorkstream(w: WorkstreamRow): string {
  const name = w.channel_display_name ?? "Channel";
  const meta: string[] = [`${w.digest_count} recent digests`];
  if (w.drivers.length > 0) meta.push(`driven by ${w.drivers.join(", ")}`);
  meta.push(`last active ${w.last_activity_at}`);
  return `${name} — ${meta.join(" · ")}`;
}

function formatDecision(d: OrgDecisionRow): string {
  const where = d.channel_display_name ? ` in ${d.channel_display_name}` : "";
  const who = d.decided_by ? ` (${d.decided_by})` : "";
  return `${d.text}${who}${where} — ${d.decided_at}`;
}

function formatStalled(t: StalledRow): string {
  const where = t.channel_display_name ? ` in ${t.channel_display_name}` : "";
  return `${t.topic ?? "(untitled thread)"}${where} — quiet since ${t.last_activity_at}`;
}

function formatTask(t: AtRiskRow): string {
  const meta: string[] = [];
  if (t.owner_display_name) meta.push(t.owner_display_name);
  if (t.deadline_at) meta.push(`due ${t.deadline_at}`);
  meta.push(t.priority);
  meta.push(t.status);
  return `${t.title} (${meta.join(" · ")})`;
}

function formatSilence(s: SilenceRow): string {
  const name = s.channel_display_name ?? "Channel";
  return `${name} — looks quiet: ${s.recent} vs ${s.prior} prior (inference)`;
}

// ---------------------------------------------------------------------------
// Default tenant-wide D1 queries
// ---------------------------------------------------------------------------

async function fetchWorkstreams(
  env: Env,
  tenantId: string,
  cutoff: string,
): Promise<WorkstreamRow[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT c.channel_id AS channel_id,
            c.display_name AS channel_display_name,
            COUNT(d.id) AS digest_count,
            MAX(d.posted_at) AS last_activity_at
       FROM channels c
       JOIN digests d ON d.channel_id = c.channel_id
      WHERE c.tenant_id = ? AND d.posted_at >= ?
      GROUP BY c.channel_id
      ORDER BY digest_count DESC, last_activity_at DESC
      LIMIT ?`,
  )
    .bind(tenantId, cutoff, MAX_PER_LIST)
    .all<{
      channel_id: string;
      channel_display_name: string | null;
      digest_count: number;
      last_activity_at: string;
    }>();

  const channelIds = rows.results.map((r) => r.channel_id);
  const driversByChannel = await fetchDrivers(env, channelIds, cutoff);

  return rows.results.map((r) => ({
    channel_id: r.channel_id,
    channel_display_name: r.channel_display_name,
    digest_count: r.digest_count,
    last_activity_at: r.last_activity_at,
    drivers: driversByChannel.get(r.channel_id) ?? [],
  }));
}

/**
 * Drivers = the people making decisions in each channel over the window. One
 * grouped query across all workstream channels, mapped back per channel and
 * capped at MAX_DRIVERS each.
 */
async function fetchDrivers(
  env: Env,
  channelIds: string[],
  cutoff: string,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (channelIds.length === 0) return map;
  const placeholders = channelIds.map(() => "?").join(",");
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT dec.channel_id AS channel_id,
            u.display_name AS driver,
            COUNT(*) AS n
       FROM decisions dec
       JOIN users u ON u.aad_id = dec.decided_by_aad_id
      WHERE dec.channel_id IN (${placeholders})
        AND dec.decided_at >= ?
        AND dec.decided_by_aad_id IS NOT NULL
      GROUP BY dec.channel_id, dec.decided_by_aad_id
      ORDER BY n DESC`,
  )
    .bind(...channelIds, cutoff)
    .all<{ channel_id: string; driver: string | null; n: number }>();

  for (const r of rows.results) {
    if (!r.driver) continue;
    const list = map.get(r.channel_id) ?? [];
    if (list.length < MAX_DRIVERS) list.push(r.driver);
    map.set(r.channel_id, list);
  }
  return map;
}

async function fetchDecisions(
  env: Env,
  tenantId: string,
  cutoff: string,
): Promise<OrgDecisionRow[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT dec.text AS text,
            dec.decided_at AS decided_at,
            u.display_name AS decided_by,
            c.display_name AS channel_display_name
       FROM decisions dec
       JOIN channels c ON c.channel_id = dec.channel_id
       LEFT JOIN users u ON u.aad_id = dec.decided_by_aad_id
      WHERE c.tenant_id = ? AND dec.decided_at >= ?
      ORDER BY dec.decided_at DESC
      LIMIT ?`,
  )
    .bind(tenantId, cutoff, MAX_PER_LIST)
    .all<OrgDecisionRow>();
  return rows.results;
}

async function fetchStalled(
  env: Env,
  tenantId: string,
): Promise<StalledRow[]> {
  // Same staleness signal src/intelligence/stale.ts marks (stale_at IS NOT
  // NULL), scoped tenant-wide via the channel join.
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT t.topic AS topic,
            t.last_activity_at AS last_activity_at,
            c.display_name AS channel_display_name
       FROM threads t
       JOIN channels c ON c.channel_id = t.channel_id
      WHERE c.tenant_id = ? AND t.stale_at IS NOT NULL
      ORDER BY t.last_activity_at DESC
      LIMIT ?`,
  )
    .bind(tenantId, MAX_PER_LIST)
    .all<StalledRow>();
  return rows.results;
}

async function fetchAtRisk(
  env: Env,
  tenantId: string,
  deadlineWindow: string,
): Promise<AtRiskRow[]> {
  // Same scan shape as the nudge engine (src/intelligence/nudge.ts): open or
  // in_progress, deadline set and past-or-within the near window. Scoped to
  // the tenant via the channel/chat membership of the task.
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT t.id AS id,
            t.title AS title,
            u.display_name AS owner_display_name,
            t.deadline_at AS deadline_at,
            t.priority AS priority,
            t.status AS status
       FROM tasks t
       LEFT JOIN users u ON u.aad_id = t.owner_aad_id
      WHERE t.status IN ('open','in_progress')
        AND t.deadline_at IS NOT NULL
        AND t.deadline_at <= ?
        AND (
          t.channel_id IN (SELECT channel_id FROM channels WHERE tenant_id = ?)
          OR t.chat_id IN (SELECT chat_id FROM chats WHERE tenant_id = ?)
        )
      ORDER BY
        CASE WHEN t.deadline_at < datetime('now') THEN 0 ELSE 1 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                       WHEN 'normal' THEN 2 ELSE 3 END,
        t.deadline_at
      LIMIT ?`,
  )
    .bind(deadlineWindow, tenantId, tenantId, MAX_PER_LIST)
    .all<AtRiskRow>();
  return rows.results;
}

/**
 * Unusual silences — heuristic, labeled as inference (SOUL.md). For each
 * channel, compare digest activity in the recent window against the equal
 * window immediately before it. Flag channels that had a real cadence
 * (prior >= SILENCE_MIN_PRIOR) and then dropped sharply (recent at most a
 * third of prior). No claim of cause — just "this went quiet".
 */
async function fetchSilences(
  env: Env,
  tenantId: string,
  windowDays: number,
): Promise<SilenceRow[]> {
  const now = Date.now();
  const recentCut = new Date(
    now - windowDays * 24 * 3600 * 1000,
  ).toISOString();
  const priorCut = new Date(
    now - 2 * windowDays * 24 * 3600 * 1000,
  ).toISOString();

  const rows = await env.ARCADIA_DB.prepare(
    `SELECT c.channel_id AS channel_id,
            c.display_name AS channel_display_name,
            SUM(CASE WHEN d.posted_at >= ? THEN 1 ELSE 0 END) AS recent,
            SUM(CASE WHEN d.posted_at >= ? AND d.posted_at < ? THEN 1 ELSE 0 END) AS prior
       FROM channels c
       JOIN digests d ON d.channel_id = c.channel_id
      WHERE c.tenant_id = ? AND d.posted_at >= ?
      GROUP BY c.channel_id`,
  )
    .bind(recentCut, priorCut, recentCut, tenantId, priorCut)
    .all<{
      channel_id: string;
      channel_display_name: string | null;
      recent: number;
      prior: number;
    }>();

  const flagged: SilenceRow[] = [];
  for (const r of rows.results) {
    if (r.prior >= SILENCE_MIN_PRIOR && r.recent * 3 <= r.prior) {
      flagged.push({
        channel_display_name: r.channel_display_name,
        recent: r.recent,
        prior: r.prior,
      });
    }
  }
  flagged.sort((a, b) => b.prior - a.prior);
  return flagged.slice(0, MAX_PER_LIST);
}
