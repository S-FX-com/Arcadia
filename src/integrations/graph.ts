// Microsoft Graph, application-only. The one module that holds the Graph
// client credential (CLAUDE.md rule 7) and the only place Arcadia calls
// graph.microsoft.com from.
//
// One exported function per Graph call kept code makes. Endpoints and
// request shapes are carried over unchanged from v5; nothing here is new
// Graph behaviour. The shared core adds three things:
//   - a client-credentials token cached in CONTROL KV
//   - retries: 429 for every method, honouring Retry-After (in seconds, per
//     Microsoft's throttling guidance); a Retry-After longer than this
//     module will wait fails at once instead of retrying early. 503/504 are
//     retried for GET only, so a write that may have landed is never sent
//     twice
//   - paging: list calls follow @odata.nextLink up to a page cap, and fail
//     rather than return a partial collection
//
// Every write (createTimeOffRequest, createShift, deleteShift) appends an
// audit_log row before the HTTP call and another after it, success or
// failure (CLAUDE.md §5). Callers cannot skip it.

import { appendAudit } from "../lib/audit";
import type { DirectoryUserInput } from "../lib/directory-merge";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_ROOT_PREFIX = /^https:\/\/graph\.microsoft\.com\/v1\.0/;
const TOKEN_CACHE_KEY = "graph:app_token";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
/**
 * Longest single wait between attempts. A page request cannot sleep for
 * minutes, so a longer Retry-After ends the request instead.
 */
const MAX_RETRY_WAIT_MS = 10_000;
const BACKOFF_BASE_MS = 500;

export function graphAvailable(env: Env): boolean {
  return Boolean(env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET);
}

/**
 * One sentence naming the missing credential. Null when tenant id, client
 * id, and client secret are all set. Consent failures are a different
 * sentence, written by the sync that Microsoft refused.
 */
export function graphNotConnected(env: Env): string | null {
  const missing = [
    env.GRAPH_TENANT_ID ? null : "GRAPH_TENANT_ID",
    env.GRAPH_CLIENT_ID ? null : "GRAPH_CLIENT_ID",
    env.GRAPH_CLIENT_SECRET ? null : "GRAPH_CLIENT_SECRET",
  ].filter((name): name is string => Boolean(name));
  if (missing.length === 0) return null;
  const list =
    missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  const verb = missing.length === 1 ? "is" : "are";
  return `Microsoft 365 is not connected. ${list} ${verb} not set.`;
}

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "GraphError";
  }
}

// ---------------------------------------------------------------------------
// Core: token, request with retries, paging
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/** Client-credentials token, cached in KV until shortly before it expires. */
async function appToken(env: Env): Promise<string> {
  if (!graphAvailable(env)) {
    throw new GraphError("Graph credentials are not configured", 401);
  }
  const cached = await env.CONTROL.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID as string,
    client_secret: env.GRAPH_CLIENT_SECRET as string,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new GraphError(`token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  }
  const token = (await res.json()) as TokenResponse;
  await env.CONTROL.put(TOKEN_CACHE_KEY, token.access_token, {
    expirationTtl: Math.max(60, Math.min(token.expires_in - 120, 3600)),
  });
  return token.access_token;
}

type Method = "GET" | "POST" | "DELETE";

function retryable(method: Method, status: number): boolean {
  if (status === 429) return true;
  return method === "GET" && (status === 503 || status === 504);
}

/**
 * How long to wait before the next attempt, or null when Graph asked for a
 * longer wait than MAX_RETRY_WAIT_MS: retrying early would only extend the
 * throttle. Retry-After is seconds or an HTTP date; without it, exponential
 * backoff.
 */
function retryDelayMs(res: Response, attempt: number): number | null {
  const header = res.headers.get("Retry-After");
  if (header !== null && header.trim() !== "") {
    let ms: number | undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      ms = seconds * 1000;
    } else {
      const at = Date.parse(header);
      if (Number.isFinite(at)) ms = Math.max(0, at - Date.now());
    }
    if (ms !== undefined) return ms > MAX_RETRY_WAIT_MS ? null : ms;
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphRequest(env: Env, method: Method, path: string, body?: unknown): Promise<Response> {
  const token = await appToken(env);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GRAPH_ROOT}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return res;
    if (attempt + 1 < MAX_ATTEMPTS && retryable(method, res.status)) {
      const wait = retryDelayMs(res, attempt);
      if (wait !== null) {
        await res.body?.cancel();
        await sleep(wait);
        continue;
      }
    }
    throw new GraphError(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  }
}

async function graphGet<T>(env: Env, path: string): Promise<T> {
  return (await (await graphRequest(env, "GET", path)).json()) as T;
}

/**
 * Every item of a collection, following @odata.nextLink up to maxPages. A
 * collection longer than the cap throws instead of returning a partial list:
 * a caller such as the shift-pattern post must not act on missing time off.
 */
async function graphGetAll<T>(env: Env, path: string, maxPages: number): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = path;
  for (let page = 0; next && page < maxPages; page++) {
    const res: { value?: T[]; "@odata.nextLink"?: string } = await graphGet(env, next);
    items.push(...(res.value ?? []));
    next = res["@odata.nextLink"]?.replace(GRAPH_ROOT_PREFIX, "");
  }
  if (next) {
    throw new GraphError(`GET ${path} has more than ${maxPages} pages; refusing a partial read`, 500);
  }
  return items;
}

/** A 202/204 with no body is a valid write; the caller gets {} and an unconfirmed id. */
async function graphPost<T>(env: Env, path: string, body: unknown): Promise<T> {
  const text = await (await graphRequest(env, "POST", path, body)).text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function graphDelete(env: Env, path: string): Promise<void> {
  await (await graphRequest(env, "DELETE", path)).body?.cancel();
}

function requireAvailable(env: Env): void {
  if (!graphAvailable(env)) throw new GraphError("Graph credentials are not configured", 401);
}

/**
 * Audit before, call, audit after (success or failure). The before row is
 * written first and fails closed, so a write that never returns still leaves
 * a trace. The after row cannot change the outcome: if it fails to write, the
 * caller still gets the result of a write that landed, or the original Graph
 * error, and the failure is logged.
 */
async function auditedWrite<T>(
  env: Env,
  input: { actor: string; action: string; subject: string; detail: string },
  call: () => Promise<T>,
  outcome: (result: T) => string
): Promise<T> {
  await appendAudit(env.DB, {
    actor: input.actor,
    action: `${input.action}_started`,
    subject: input.subject,
    detail: input.detail,
  });
  let result: T;
  try {
    result = await call();
  } catch (err) {
    await auditAfter(env, {
      actor: input.actor,
      action: `${input.action}_failed`,
      subject: input.subject,
      detail: `${input.detail} — ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000),
    });
    throw err;
  }
  await auditAfter(env, {
    actor: input.actor,
    action: `${input.action}_succeeded`,
    subject: input.subject,
    detail: `${input.detail} — ${outcome(result)}`,
  });
  return result;
}

async function auditAfter(env: Env, entry: Parameters<typeof appendAudit>[1]): Promise<void> {
  try {
    await appendAudit(env.DB, entry);
  } catch (err) {
    console.error(`audit row ${entry.action} not written`, err);
  }
}

const team = (teamId: string) => `/teams/${encodeURIComponent(teamId)}`;

// ---------------------------------------------------------------------------
// Users (roster)
// ---------------------------------------------------------------------------

const USER_SELECT = [
  "id",
  "displayName",
  "mail",
  "userPrincipalName",
  "jobTitle",
  "department",
  "officeLocation",
  "mobilePhone",
  "businessPhones",
  "city",
  "state",
  "country",
  "accountEnabled",
  "userType",
].join(",");
const MAX_USER_PAGES = 10;

/**
 * GET /users with profile fields. Every user the tenant returns; the caller
 * filters to active members (selectActiveMembers). No manager, no address.
 */
export async function listMemberUsers(env: Env): Promise<DirectoryUserInput[]> {
  requireAvailable(env);
  return await graphGetAll<DirectoryUserInput>(env, `/users?$select=${USER_SELECT}&$top=999`, MAX_USER_PAGES);
}

const USER_NAME_TTL_SECONDS = 86_400;

/**
 * GET /users/{id}?$select=displayName, cached in KV for a day. A 404 (someone
 * who has left the directory) is cached too, as the empty string. Any other
 * failure propagates.
 */
export async function userDisplayName(env: Env, aadId: string): Promise<string | undefined> {
  const key = `graph:username:${aadId}`;
  const cached = await env.CONTROL.get(key);
  if (cached !== null) return cached || undefined;
  try {
    const user = await graphGet<{ displayName?: string }>(
      env,
      `/users/${encodeURIComponent(aadId)}?$select=displayName`
    );
    const name = (user.displayName ?? "").trim();
    await env.CONTROL.put(key, name, { expirationTtl: USER_NAME_TTL_SECONDS });
    return name || undefined;
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) {
      await env.CONTROL.put(key, "", { expirationTtl: USER_NAME_TTL_SECONDS });
      return undefined;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export interface TeamLite {
  id: string;
  displayName: string;
}

const MAX_TEAM_PAGES = 5;

/**
 * Tenant Teams for the Schedule config picker. Needs Group.Read.All. Best
 * effort: an empty list on any failure, because the page falls back to
 * locally known team ids and a manual field.
 */
export async function listTeams(env: Env): Promise<TeamLite[]> {
  if (!graphAvailable(env)) return [];
  try {
    const groups = await graphGetAll<{ id?: string; displayName?: string }>(
      env,
      `/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName&$top=200&$orderby=displayName`,
      MAX_TEAM_PAGES
    );
    return groups
      .filter((g): g is { id: string; displayName?: string } => Boolean(g.id))
      .map((g) => ({ id: g.id, displayName: g.displayName ?? g.id }));
  } catch {
    return [];
  }
}

/** GET one channel's membershipType and name, for the bind-time standard-channel check. */
export async function getChannel(
  env: Env,
  teamId: string,
  channelId: string
): Promise<{ membershipType?: string; displayName?: string }> {
  requireAvailable(env);
  const res = await graphGet<{ membershipType?: string; displayName?: string }>(
    env,
    `${team(teamId)}/channels/${encodeURIComponent(channelId)}?$select=membershipType,displayName`
  );
  return {
    ...(res.membershipType ? { membershipType: res.membershipType } : {}),
    ...(res.displayName ? { displayName: res.displayName } : {}),
  };
}

// ---------------------------------------------------------------------------
// Schedule (Teams Shifts) on the configured team
//
// No server-side date filter: these read the team's full collections and
// callers narrow to the visible range. Arcadia never approves or declines a
// time-off request; a human does that in Shifts.
// ---------------------------------------------------------------------------

export interface ShiftLite {
  id: string;
  userId?: string;
  displayName?: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface TimeOffReasonLite {
  id: string;
  displayName?: string;
}

export interface TimeOffRequestLite {
  id: string;
  senderUserId?: string;
  startDateTime?: string;
  endDateTime?: string;
  /** Read verbatim from Graph, never assumed. Typically pending/approved/declined. */
  state?: string;
}

export interface TimeOffLite {
  id: string;
  userId?: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface SchedulingGroupLite {
  id: string;
  displayName?: string;
}

/** Times live under sharedShift (published) or draftShift (unpublished, not shown). */
interface RawShift {
  id: string;
  userId?: string;
  sharedShift?: { displayName?: string; startDateTime?: string; endDateTime?: string };
  startDateTime?: string;
  endDateTime?: string;
}

interface RawTimeOffRequest {
  id: string;
  senderUserId?: string;
  startDateTime?: string;
  endDateTime?: string;
  state?: string;
}

interface RawTimeOff {
  id: string;
  userId?: string;
  startDateTime?: string;
  endDateTime?: string;
}

const MAX_SCHEDULE_PAGES = 10;

function parseShift(raw: RawShift): ShiftLite {
  const start = raw.sharedShift?.startDateTime ?? raw.startDateTime;
  const end = raw.sharedShift?.endDateTime ?? raw.endDateTime;
  return {
    id: raw.id,
    ...(raw.userId ? { userId: raw.userId } : {}),
    ...(raw.sharedShift?.displayName ? { displayName: raw.sharedShift.displayName } : {}),
    ...(start ? { startDateTime: start } : {}),
    ...(end ? { endDateTime: end } : {}),
  };
}

/** GET /teams/{id}/schedule/shifts, on published (sharedShift) times. */
export async function listShifts(env: Env, teamId: string): Promise<ShiftLite[]> {
  requireAvailable(env);
  const raw = await graphGetAll<RawShift>(env, `${team(teamId)}/schedule/shifts`, MAX_SCHEDULE_PAGES);
  return raw.map(parseShift);
}

/** GET /teams/{id}/schedule/timesOff: confirmed time off, the state an approved request becomes. */
export async function listTimesOff(env: Env, teamId: string): Promise<TimeOffLite[]> {
  requireAvailable(env);
  const raw = await graphGetAll<RawTimeOff>(env, `${team(teamId)}/schedule/timesOff`, MAX_SCHEDULE_PAGES);
  return raw.map((r) => ({
    id: r.id,
    ...(r.userId ? { userId: r.userId } : {}),
    ...(r.startDateTime ? { startDateTime: r.startDateTime } : {}),
    ...(r.endDateTime ? { endDateTime: r.endDateTime } : {}),
  }));
}

/** GET /teams/{id}/schedule/timeOffReasons, for the request form's dropdown. */
export async function listTimeOffReasons(env: Env, teamId: string): Promise<TimeOffReasonLite[]> {
  requireAvailable(env);
  const raw = await graphGetAll<{ id: string; displayName?: string }>(
    env,
    `${team(teamId)}/schedule/timeOffReasons`,
    MAX_SCHEDULE_PAGES
  );
  return raw.map((r) => ({ id: r.id, ...(r.displayName ? { displayName: r.displayName } : {}) }));
}

/** GET /teams/{id}/schedule/timeOffRequests, whatever their state. Callers filter. */
export async function listTimeOffRequests(env: Env, teamId: string): Promise<TimeOffRequestLite[]> {
  requireAvailable(env);
  const raw = await graphGetAll<RawTimeOffRequest>(
    env,
    `${team(teamId)}/schedule/timeOffRequests`,
    MAX_SCHEDULE_PAGES
  );
  return raw.map((r) => ({
    id: r.id,
    ...(r.senderUserId ? { senderUserId: r.senderUserId } : {}),
    ...(r.startDateTime ? { startDateTime: r.startDateTime } : {}),
    ...(r.endDateTime ? { endDateTime: r.endDateTime } : {}),
    ...(r.state ? { state: r.state } : {}),
  }));
}

/** GET /teams/{id}/schedule/schedulingGroups, so a shift pattern can name one. */
export async function listSchedulingGroups(env: Env, teamId: string): Promise<SchedulingGroupLite[]> {
  requireAvailable(env);
  const raw = await graphGetAll<{ id: string; displayName?: string }>(
    env,
    `${team(teamId)}/schedule/schedulingGroups`,
    MAX_SCHEDULE_PAGES
  );
  return raw.map((g) => ({ id: g.id, ...(g.displayName ? { displayName: g.displayName } : {}) }));
}

/**
 * POST /teams/{id}/schedule/timeOffRequests. Non-binding until a human
 * approves it in Shifts. The caller passes the requester's own directory id
 * as senderUserId. Audited before and after.
 */
export async function createTimeOffRequest(
  env: Env,
  teamId: string,
  input: { senderUserId: string; startDateTime: string; endDateTime: string; timeOffReasonId?: string },
  actor: string
): Promise<{ graphId?: string }> {
  requireAvailable(env);
  const created = await auditedWrite(
    env,
    {
      actor,
      action: "graph_create_time_off_request",
      subject: teamId,
      detail: `sender ${input.senderUserId}: ${input.startDateTime} – ${input.endDateTime}`,
    },
    () =>
      graphPost<{ id?: string }>(env, `${team(teamId)}/schedule/timeOffRequests`, {
        senderUserId: input.senderUserId,
        startDateTime: input.startDateTime,
        endDateTime: input.endDateTime,
        ...(input.timeOffReasonId ? { timeOffReasonId: input.timeOffReasonId } : {}),
      }),
    (result) => (result.id ? `filed as ${result.id}` : "filed, id unconfirmed")
  );
  return created.id ? { graphId: created.id } : {};
}

/**
 * POST /teams/{id}/schedule/shifts. sharedShift is set and draftShift is
 * omitted: the v1.0 shift resource requires one of them null, and a shared
 * shift publishes. Duration must be 1 minute through 24 hours, checked before
 * any call or audit row. Audited before and after; `detail` lets the caller
 * name the pattern and the person who turned it on.
 */
export async function createShift(
  env: Env,
  teamId: string,
  input: {
    userId: string;
    schedulingGroupId: string;
    startDateTime: string;
    endDateTime: string;
    displayName?: string;
  },
  actor: string,
  detail?: string
): Promise<{ graphId?: string }> {
  requireAvailable(env);
  const minutes = (new Date(input.endDateTime).getTime() - new Date(input.startDateTime).getTime()) / 60_000;
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new Error("a shift must last at least 1 minute and at most 24 hours");
  }
  const created = await auditedWrite(
    env,
    {
      actor,
      action: "graph_create_shift",
      subject: teamId,
      detail: `user ${input.userId}: ${input.startDateTime} – ${input.endDateTime}${input.displayName ? ` · ${input.displayName}` : ""}${detail ? ` (${detail})` : ""}`,
    },
    () =>
      graphPost<{ id?: string }>(env, `${team(teamId)}/schedule/shifts`, {
        userId: input.userId,
        schedulingGroupId: input.schedulingGroupId,
        sharedShift: {
          ...(input.displayName ? { displayName: input.displayName } : {}),
          startDateTime: input.startDateTime,
          endDateTime: input.endDateTime,
          theme: "blue",
        },
      }),
    (result) => (result.id ? `posted as ${result.id}` : "posted, id unconfirmed")
  );
  return created.id ? { graphId: created.id } : {};
}

/** DELETE /teams/{id}/schedule/shifts/{shiftId}. A named delete of one posted shift. Audited before and after. */
export async function deleteShift(env: Env, teamId: string, shiftId: string, actor: string): Promise<void> {
  requireAvailable(env);
  await auditedWrite(
    env,
    { actor, action: "graph_delete_shift", subject: shiftId, detail: `team ${teamId}` },
    () => graphDelete(env, `${team(teamId)}/schedule/shifts/${encodeURIComponent(shiftId)}`),
    () => "deleted"
  );
}
