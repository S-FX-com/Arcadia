// Ground-truth stall signals (§4 M1). Self-reported status is the mechanism
// that already failed — nothing here asks a human how it's going.
//
// Signals resolved now, with no Microsoft dependency:
//   - git commit activity (GitHub API)
//   - staging site HTTP diff (direct crawl from the Worker)
// Signals behind the interface until Graph credentials exist (§9.7):
//   - SharePoint / OneDrive file mtime
//   - Planner task state transitions  ← ground truth for task state
//   - Teams channel message velocity  ← where progress is discussed
// Planner is confirmed as the system of record for task state, and Teams
// channel threads carry the progress discussion, so both are first-class here.

import { graphAvailable, graphGet } from "../integrations/graph";

export type SignalKind = "git" | "staging_diff" | "file_mtime" | "planner" | "channel_velocity";

export interface SignalReading {
  kind: SignalKind;
  /** Most recent real activity this signal can see, ISO 8601. */
  lastActivityAt?: string;
  /** Opaque fingerprint for diff-based signals (staging HTML hash, etc). */
  fingerprint?: string;
  /** Human-readable note for the escalation and the board. */
  detail: string;
  /** False when the signal could not be read at all (missing credentials, 404). */
  available: boolean;
}

/** Per-project source configuration, stored as JSON on projects.sources. */
export interface ProjectSources {
  githubRepo?: string; // "owner/repo"
  githubBranch?: string;
  stagingUrl?: string;
  sharepointDriveId?: string;
  sharepointFolderPath?: string;
  plannerPlanId?: string;
  teamsTeamId?: string;
  teamsChannelId?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// git — commit activity. The cleanest stall signal available when work is in
// Git (§10.2), and needs no Microsoft dependency.
// ---------------------------------------------------------------------------

export async function readGitSignal(env: Env, sources: ProjectSources): Promise<SignalReading> {
  if (!sources.githubRepo) {
    return { kind: "git", detail: "no repo configured", available: false };
  }
  if (!env.GITHUB_TOKEN) {
    return { kind: "git", detail: "GITHUB_TOKEN not configured", available: false };
  }
  const branch = sources.githubBranch ? `&sha=${encodeURIComponent(sources.githubBranch)}` : "";
  const url = `https://api.github.com/repos/${sources.githubRepo}/commits?per_page=1${branch}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "arcadia-radar",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { kind: "git", detail: `GitHub API ${res.status}`, available: false };
    }
    const commits = (await res.json()) as Array<{
      sha: string;
      commit: { author?: { date?: string }; message?: string };
    }>;
    const head = commits[0];
    if (!head) return { kind: "git", detail: "no commits on branch", available: true };
    const date = head.commit.author?.date;
    return {
      kind: "git",
      ...(date ? { lastActivityAt: date } : {}),
      fingerprint: head.sha,
      detail: `last commit ${head.sha.slice(0, 7)}: ${(head.commit.message ?? "").split("\n")[0]?.slice(0, 80)}`,
      available: true,
    };
  } catch (err) {
    return { kind: "git", detail: `GitHub unreachable: ${err instanceof Error ? err.message : ""}`, available: false };
  }
}

// ---------------------------------------------------------------------------
// staging_diff — has the staging site changed since last sweep?
// ---------------------------------------------------------------------------

export async function readStagingSignal(
  sources: ProjectSources,
  previousFingerprint?: string
): Promise<SignalReading> {
  if (!sources.stagingUrl) {
    return { kind: "staging_diff", detail: "no staging URL configured", available: false };
  }
  try {
    const res = await fetch(sources.stagingUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return { kind: "staging_diff", detail: `staging returned HTTP ${res.status}`, available: true };
    }
    const body = await res.text();
    // Strip obvious per-request noise so a cache-buster doesn't read as work.
    const normalized = body
      .replace(/nonce="[^"]*"/g, "")
      .replace(/\?ver=[\w.]+/g, "")
      .replace(/csrf[^"']*["'][^"']*["']/gi, "")
      .replace(/\s+/g, " ");
    const fingerprint = await sha256Hex(normalized);
    const changed = previousFingerprint !== undefined && previousFingerprint !== fingerprint;
    return {
      kind: "staging_diff",
      fingerprint,
      ...(changed ? { lastActivityAt: new Date().toISOString() } : {}),
      detail: previousFingerprint === undefined
        ? "first sweep — fingerprint recorded"
        : changed
          ? "staging content changed since last sweep"
          : "staging content unchanged since last sweep",
      available: true,
    };
  } catch (err) {
    return {
      kind: "staging_diff",
      detail: `staging unreachable: ${err instanceof Error ? err.message : ""}`,
      available: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Graph-backed signals. Each degrades to available:false with a clear reason
// until the app registration and consent exist (§9.7) — Radar never guesses.
// ---------------------------------------------------------------------------

export async function readPlannerSignal(env: Env, sources: ProjectSources): Promise<SignalReading> {
  if (!sources.plannerPlanId) {
    return { kind: "planner", detail: "no Planner plan configured", available: false };
  }
  if (!graphAvailable(env)) {
    return { kind: "planner", detail: "Graph credentials not configured (CLAUDE.md §9.7)", available: false };
  }
  try {
    const tasks = await graphGet<{
      value: Array<{ id: string; title: string; percentComplete: number; completedDateTime?: string }>;
    }>(env, `/planner/plans/${sources.plannerPlanId}/tasks`);
    const open = tasks.value.filter((t) => t.percentComplete < 100);
    // Planner exposes completion timestamps; the newest transition is the
    // freshest ground truth about whether the plan is moving.
    const newestCompletion = tasks.value
      .map((t) => t.completedDateTime)
      .filter((d): d is string => !!d)
      .sort()
      .pop();
    return {
      kind: "planner",
      ...(newestCompletion ? { lastActivityAt: newestCompletion } : {}),
      detail: `${open.length} open of ${tasks.value.length} tasks${
        newestCompletion ? `; last completion ${newestCompletion}` : "; no completions recorded"
      }`,
      available: true,
    };
  } catch (err) {
    return {
      kind: "planner",
      detail: `Planner read failed: ${err instanceof Error ? err.message : ""}`,
      available: false,
    };
  }
}

export async function readFileMtimeSignal(env: Env, sources: ProjectSources): Promise<SignalReading> {
  if (!sources.sharepointDriveId || !sources.sharepointFolderPath) {
    return { kind: "file_mtime", detail: "no SharePoint folder configured", available: false };
  }
  if (!graphAvailable(env)) {
    return { kind: "file_mtime", detail: "Graph credentials not configured (CLAUDE.md §9.7)", available: false };
  }
  try {
    const listing = await graphGet<{
      value: Array<{ name: string; lastModifiedDateTime: string }>;
    }>(
      env,
      `/drives/${sources.sharepointDriveId}/root:${sources.sharepointFolderPath}:/children?$select=name,lastModifiedDateTime&$orderby=lastModifiedDateTime desc&$top=5`
    );
    const newest = listing.value[0];
    return {
      kind: "file_mtime",
      ...(newest ? { lastActivityAt: newest.lastModifiedDateTime } : {}),
      detail: newest ? `newest file: ${newest.name} (${newest.lastModifiedDateTime})` : "folder is empty",
      available: true,
    };
  } catch (err) {
    return {
      kind: "file_mtime",
      detail: `SharePoint read failed: ${err instanceof Error ? err.message : ""}`,
      available: false,
    };
  }
}

export async function readChannelVelocitySignal(env: Env, sources: ProjectSources): Promise<SignalReading> {
  if (!sources.teamsTeamId || !sources.teamsChannelId) {
    return { kind: "channel_velocity", detail: "no Teams channel configured", available: false };
  }
  if (!graphAvailable(env)) {
    return {
      kind: "channel_velocity",
      detail: "Graph credentials not configured (CLAUDE.md §9.7)",
      available: false,
    };
  }
  try {
    const messages = await graphGet<{
      value: Array<{ createdDateTime: string; from?: { user?: { displayName?: string } } }>;
    }>(
      env,
      `/teams/${sources.teamsTeamId}/channels/${sources.teamsChannelId}/messages?$top=20&$select=createdDateTime,from`
    );
    const newest = messages.value
      .map((m) => m.createdDateTime)
      .sort()
      .pop();
    const lastWeek = messages.value.filter(
      (m) => Date.parse(m.createdDateTime) > Date.now() - 7 * 86_400_000
    ).length;
    return {
      kind: "channel_velocity",
      ...(newest ? { lastActivityAt: newest } : {}),
      detail: `${lastWeek} messages in the last 7 days`,
      available: true,
    };
  } catch (err) {
    return {
      kind: "channel_velocity",
      detail: `Teams read failed: ${err instanceof Error ? err.message : ""}`,
      available: false,
    };
  }
}

export async function readAllSignals(
  env: Env,
  sources: ProjectSources,
  previousFingerprints: Partial<Record<SignalKind, string>>
): Promise<SignalReading[]> {
  return Promise.all([
    readGitSignal(env, sources),
    readStagingSignal(sources, previousFingerprints.staging_diff),
    readPlannerSignal(env, sources),
    readFileMtimeSignal(env, sources),
    readChannelVelocitySignal(env, sources),
  ]);
}

/**
 * Days since the freshest available signal. Unavailable signals are excluded —
 * a missing credential must never read as a stall, or Radar cries wolf and
 * gets ignored, which is the failure mode the whole module exists to fix.
 */
export function daysStalled(readings: SignalReading[], now = Date.now()): number | undefined {
  const stamps = readings
    .filter((r) => r.available && r.lastActivityAt)
    .map((r) => Date.parse(r.lastActivityAt as string))
    .filter((t) => Number.isFinite(t));
  if (stamps.length === 0) return undefined;
  const newest = Math.max(...stamps);
  return Math.floor((now - newest) / 86_400_000);
}
