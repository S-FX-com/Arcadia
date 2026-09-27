// Microsoft Graph Gatekeeper (Cloudflare OS integration plan, workstream A).
//
// A session is scoped to ONE project's configured sources at mint time — the
// methods take no ids, so a session cannot be pointed at another project's
// plan, folder, or channel. Reads map one-to-one onto the Radar signals and
// are logged as observations (metadata only — no message bodies, no file
// contents). The single write Graph permits Arcadia (Planner task state,
// Phase 3 dispatch) is an action that refuses to apply without a dispatch
// rule attributed to a named human.
//
// Application credentials stay inside src/integrations/graph.ts, which
// nothing outside this gatekeeper may import. Missing credentials degrade
// cleanly: available() is false and Radar reports a visibility gap, never a
// stall (§9.7).

import {
  graphAvailable,
  graphDelete,
  graphGet,
  graphPatchPlannerTask,
  graphPost,
  graphUserDisplayName,
} from "../integrations/graph";
import { D1GatekeeperQueue } from "./log";
import {
  GatekeeperDeniedError,
  type ActionAuthorization,
  type ActionKind,
  type ArcadiaActionQueue,
  type GatekeeperContext,
} from "./types";

export const GRAPH_ACTION_KINDS = {
  patchPlannerTask: { tag: "graph.patch_planner_task", label: "Update Planner task state" },
} satisfies Record<string, ActionKind>;

/** What one session may see — a single project's configured sources. */
export interface GraphScope {
  projectId: string;
  plannerPlanId?: string;
  sharepointDriveId?: string;
  sharepointFolderPath?: string;
  teamsTeamId?: string;
  teamsChannelId?: string;
}

export interface PlannerTaskLite {
  id: string;
  title: string;
  percentComplete: number;
  completedDateTime?: string;
}

/** One Planner bucket — the column a board groups under. */
export interface PlannerBucket {
  id: string;
  name: string;
}

/**
 * One task as the Objectives board renders it: title, state, dates, and who
 * it is assigned to — by directory id, resolved to names separately so the
 * name lookup stays a visible, scoped read of its own.
 */
export interface PlannerTaskDetail {
  id: string;
  title: string;
  bucketId: string | null;
  /** Planner's three states: 0 not started, 50 in progress, 100 complete. */
  percentComplete: number;
  /** Planner bands: 0–1 urgent, 2–4 important, 5–7 medium, 8–10 low. */
  priority: number;
  createdDateTime: string;
  dueDateTime: string | null;
  completedDateTime: string | null;
  assigneeIds: string[];
}

export interface PlannerBoard {
  buckets: PlannerBucket[];
  tasks: PlannerTaskDetail[];
}

/** The raw plannerTask shape Graph returns; mapped down before it leaves the session. */
interface RawPlannerTask {
  id: string;
  title?: string;
  bucketId?: string;
  percentComplete?: number;
  priority?: number;
  createdDateTime?: string;
  dueDateTime?: string | null;
  completedDateTime?: string | null;
  assignments?: Record<string, unknown>;
}

export interface DriveChildLite {
  name: string;
  lastModifiedDateTime: string;
}

export interface ChannelMessageLite {
  createdDateTime: string;
  from?: { user?: { displayName?: string } };
}

export interface GraphSession {
  /** False until the app registration and consent exist (§9.7). */
  available(): boolean;
  /** Planner tasks for the scoped plan. Observation. */
  plannerTasks(): Promise<PlannerTaskLite[]>;
  /**
   * The scoped plan as a board: buckets plus full task detail (titles, states,
   * dates, assignee ids — never descriptions or comments). One observation for
   * the whole read. Objectives renders from this.
   */
  plannerBoard(): Promise<PlannerBoard>;
  /**
   * Display names for assignees this session has already read off its own
   * plan. Refuses any id it has not seen — a plan-scoped session is not a
   * directory browser. Observation.
   */
  assigneeNames(ids: string[]): Promise<Record<string, string>>;
  /** Newest files in the scoped SharePoint folder. Observation. */
  folderChildren(): Promise<DriveChildLite[]>;
  /** Recent messages in the scoped Teams channel — timestamps only. Observation. */
  channelMessages(top?: number): Promise<ChannelMessageLite[]>;
  /**
   * The one Graph write Arcadia is allowed (§8): Planner task state, for
   * Phase 3 dispatch. Refuses without a dispatch rule naming the human it
   * acts for.
   */
  patchPlannerTask(
    taskId: string,
    etag: string,
    patch: Record<string, unknown>,
    authorization: ActionAuthorization
  ): Promise<void>;
}

/** Injectable seams so scoping policy is unit-testable without Graph or D1. */
export interface GraphPorts {
  queue: ArcadiaActionQueue;
  available(): boolean;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  /** Shift delete. Absent on sessions that have no delete. */
  del?(path: string): Promise<void>;
  patchPlannerTask(taskId: string, etag: string, patch: Record<string, unknown>): Promise<void>;
  /** Directory display name, or undefined for someone no longer resolvable. */
  userName(aadId: string): Promise<string | undefined>;
}

const GRAPH_ROOT_PREFIX = /^https:\/\/graph\.microsoft\.com\/v1\.0/;
/** Pages of 400 tasks each. Five bounds a runaway plan without truncating a real one. */
const MAX_TASK_PAGES = 5;

export function graphSessionFromPorts(scope: GraphScope, ports: GraphPorts): GraphSession {
  const requireAvailable = () => {
    if (!ports.available()) {
      throw new GatekeeperDeniedError("Graph credentials are not configured (CLAUDE.md §9.7)", "graph");
    }
  };
  const requirePlan = (): string => {
    if (!scope.plannerPlanId) {
      throw new GatekeeperDeniedError(`project ${scope.projectId} has no Planner plan in scope`, "graph");
    }
    return scope.plannerPlanId;
  };
  // Assignee ids this session has read off its own plan. assigneeNames() will
  // resolve these and nothing else — the scope is the plan, not the directory.
  const seenAssignees = new Set<string>();
  return {
    available: () => ports.available(),

    async plannerTasks() {
      requireAvailable();
      const planId = requirePlan();
      const res = await ports.get<{ value: PlannerTaskLite[] }>(`/planner/plans/${planId}/tasks`);
      await ports.queue.authorizeObservation({
        title: `Read Planner tasks (${scope.projectId})`,
        description: `Plan ${scope.plannerPlanId}: ${res.value.length} task(s), state metadata only`,
      });
      return res.value;
    },

    async plannerBoard() {
      requireAvailable();
      const planId = requirePlan();
      const buckets = await ports.get<{ value: Array<{ id: string; name?: string }> }>(
        `/planner/plans/${planId}/buckets`
      );

      // Planner's OData surface has no $select on tasks, so the full objects
      // arrive and are mapped down here — descriptions and comments live in
      // taskDetails, a different endpoint this session never calls.
      const raw: RawPlannerTask[] = [];
      let path: string | undefined = `/planner/plans/${planId}/tasks`;
      for (let page = 0; path && page < MAX_TASK_PAGES; page++) {
        const res: { value: RawPlannerTask[]; "@odata.nextLink"?: string } = await ports.get(path);
        raw.push(...res.value);
        path = res["@odata.nextLink"]?.replace(GRAPH_ROOT_PREFIX, "");
      }

      const tasks: PlannerTaskDetail[] = raw.map((t) => {
        const assigneeIds = Object.keys(t.assignments ?? {});
        for (const id of assigneeIds) seenAssignees.add(id);
        return {
          id: t.id,
          title: t.title ?? "(untitled)",
          bucketId: t.bucketId ?? null,
          percentComplete: t.percentComplete ?? 0,
          priority: t.priority ?? 5,
          createdDateTime: t.createdDateTime ?? "",
          dueDateTime: t.dueDateTime ?? null,
          completedDateTime: t.completedDateTime ?? null,
          assigneeIds,
        };
      });

      await ports.queue.authorizeObservation({
        title: `Read Planner board (${scope.projectId})`,
        description: `Plan ${planId}: ${buckets.value.length} bucket(s), ${tasks.length} task(s) — titles, states, dates and assignee ids; no descriptions or comments`,
      });
      return {
        buckets: buckets.value.map((b) => ({ id: b.id, name: b.name ?? "(unnamed bucket)" })),
        tasks,
      };
    },

    async assigneeNames(ids) {
      requireAvailable();
      const wanted = [...new Set(ids)];
      const unseen = wanted.filter((id) => !seenAssignees.has(id));
      if (unseen.length > 0) {
        throw new GatekeeperDeniedError(
          `session may only resolve assignees read off its own plan — ${unseen.length} id(s) were not`,
          "graph"
        );
      }
      const names: Record<string, string> = {};
      let failed = 0;
      for (const id of wanted) {
        try {
          const name = await ports.userName(id);
          if (name) names[id] = name;
        } catch {
          // A name is decoration on a board; the tasks still render without it.
          failed++;
        }
      }
      await ports.queue.authorizeObservation({
        title: `Resolved assignee names (${scope.projectId})`,
        description: `${Object.keys(names).length} of ${wanted.length} directory lookups, display names only${failed ? `; ${failed} failed` : ""}`,
      });
      return names;
    },

    async folderChildren() {
      requireAvailable();
      if (!scope.sharepointDriveId || !scope.sharepointFolderPath) {
        throw new GatekeeperDeniedError(
          `project ${scope.projectId} has no SharePoint folder in scope`,
          "graph"
        );
      }
      const res = await ports.get<{ value: DriveChildLite[] }>(
        `/drives/${scope.sharepointDriveId}/root:${scope.sharepointFolderPath}:/children?$select=name,lastModifiedDateTime&$orderby=lastModifiedDateTime desc&$top=5`
      );
      await ports.queue.authorizeObservation({
        title: `Read folder mtimes (${scope.projectId})`,
        description: `${scope.sharepointFolderPath}: ${res.value.length} entries, names and timestamps only`,
      });
      return res.value;
    },

    async channelMessages(top = 20) {
      requireAvailable();
      if (!scope.teamsTeamId || !scope.teamsChannelId) {
        throw new GatekeeperDeniedError(
          `project ${scope.projectId} has no Teams channel in scope`,
          "graph"
        );
      }
      const res = await ports.get<{ value: ChannelMessageLite[] }>(
        `/teams/${scope.teamsTeamId}/channels/${scope.teamsChannelId}/messages?$top=${top}&$select=createdDateTime,from`
      );
      await ports.queue.authorizeObservation({
        title: `Read channel velocity (${scope.projectId})`,
        description: `${res.value.length} message timestamps — no bodies read`,
      });
      return res.value;
    },

    async patchPlannerTask(taskId, etag, patch, authorization) {
      requireAvailable();
      requirePlan();
      const actionKey = `${GRAPH_ACTION_KINDS.patchPlannerTask.tag}:${taskId}`;
      await ports.queue.submitAction(actionKey, {
        title: `Planner task ${taskId} update (${scope.projectId})`,
        description: `Patch: ${JSON.stringify(patch).slice(0, 300)}`,
        implementsRevert: false,
        actionKind: GRAPH_ACTION_KINDS.patchPlannerTask,
      });
      try {
        // Read as a plain string: the two accepted kinds are currently the
        // whole union, and narrowing would make this guard unwritable — but
        // it is what stops a kind added later from inheriting Planner writes.
        const kind: string = authorization.kind;
        if (kind !== "dispatch_rule" && kind !== "human_approval") {
          throw new GatekeeperDeniedError(`authorization kind "${kind}" cannot write task state`, "graph");
        }
        await ports.queue.recordDecision(actionKey, authorization);
        await ports.patchPlannerTask(taskId, etag, patch);
        await ports.queue.recordApplied(actionKey, `task ${taskId} patched`);
      } catch (err) {
        await ports.queue.recordFailed(actionKey, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
  };
}

/** Production wiring: D1-backed queue, real Graph client. */
export function openGraphSession(env: Env, ctx: GatekeeperContext, scope: GraphScope): GraphSession {
  return graphSessionFromPorts(scope, {
    queue: new D1GatekeeperQueue(env.DB, "graph", `graph:project:${scope.projectId}`, ctx),
    available: () => graphAvailable(env),
    get: (path) => graphGet(env, path),
    post: async () => {
      throw new GatekeeperDeniedError("project sessions have no generic Graph write", "graph");
    },
    patchPlannerTask: async (taskId, etag, patch) => {
      await graphPatchPlannerTask(env, taskId, etag, patch);
    },
    userName: (aadId) => graphUserDisplayName(env, aadId),
  });
}

// ---------------------------------------------------------------------------
// Client-scoped sessions — v5.0 (§8).
//
// Scope is a frozen SET of bindings resolved from D1 at mint (the scope rule
// in ./types.ts). v5.0 needs only the bound Teams — membership is the spine's
// one Graph read. Later stages widen this shape (plans, folders, channels),
// always as frozen sets, never as method parameters.
// ---------------------------------------------------------------------------

export interface ClientGraphScope {
  clientId: string;
  /** Graph group ids of the client's bound Teams. Frozen at mint. */
  teamIds: readonly string[];
}

/** One Team member, as the membership cache stores it. Directory metadata only. */
export interface TeamMemberLite {
  aadId: string;
  sourceTeamId: string;
  displayName?: string;
  /** mail ?? userPrincipalName, lowercased — joins to the SSO identity. */
  email?: string;
}

export interface ClientGraphSession {
  /** False until the app registration and consent exist (§9.5). */
  available(): boolean;
  /**
   * Members of every Team frozen into the scope — the raw material for the
   * client_members cache (§8: access = capability × membership). Metadata
   * observation: directory ids, names, addresses; no messages, no files.
   */
  teamMembers(): Promise<TeamMemberLite[]>;
}

/** Pages of 999 each. Five bounds a runaway group without truncating a real team. */
const MAX_MEMBER_PAGES = 5;

interface RawDirectoryObject {
  "@odata.type"?: string;
  id?: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string | null;
}

export function clientGraphSessionFromPorts(
  scope: ClientGraphScope,
  ports: GraphPorts
): ClientGraphSession {
  // Defensive copy at mint: the session iterates this array and nothing else,
  // so mutating the scope object after mint changes nothing here (./types.ts
  // scope rule — a binding added mid-session does not appear in that session).
  const teamIds: readonly string[] = Object.freeze([...scope.teamIds]);
  return {
    available: () => ports.available(),

    async teamMembers() {
      if (!ports.available()) {
        throw new GatekeeperDeniedError("Graph credentials are not configured (CLAUDE.md §9)", "graph");
      }
      const members: TeamMemberLite[] = [];
      let skipped = 0;
      for (const teamId of teamIds) {
        let path: string | undefined =
          `/groups/${encodeURIComponent(teamId)}/members?$select=id,displayName,mail,userPrincipalName&$top=999`;
        for (let page = 0; path && page < MAX_MEMBER_PAGES; page++) {
          const res: { value: RawDirectoryObject[]; "@odata.nextLink"?: string } = await ports.get(path);
          for (const m of res.value) {
            // Nested groups and devices inside a Team grant nothing: only
            // directory users become workspace members.
            if (m["@odata.type"] && m["@odata.type"] !== "#microsoft.graph.user") {
              skipped++;
              continue;
            }
            if (!m.id) continue;
            const email = (m.mail ?? m.userPrincipalName ?? "").trim().toLowerCase();
            members.push({
              aadId: m.id,
              sourceTeamId: teamId,
              ...(m.displayName ? { displayName: m.displayName } : {}),
              ...(email ? { email } : {}),
            });
          }
          path = res["@odata.nextLink"]?.replace(GRAPH_ROOT_PREFIX, "");
        }
      }
      await ports.queue.authorizeObservation({
        title: `Read Team membership (${scope.clientId})`,
        description: `${teamIds.length} bound team(s): ${members.length} member(s) — directory ids, names and addresses only; no messages, no files${skipped ? `; ${skipped} non-user object(s) ignored` : ""}`,
      });
      return members;
    },
  };
}

/**
 * Resolve a client's team bindings from D1 — called exactly once, at mint.
 * The returned scope is frozen; the session never re-reads D1 (./types.ts).
 */
export async function mintClientGraphScope(env: Env, clientId: string): Promise<ClientGraphScope> {
  const rows = await env.DB.prepare(
    `SELECT external_id FROM client_bindings WHERE client_id = ?1 AND type = 'team'`
  )
    .bind(clientId)
    .all<{ external_id: string }>();
  return Object.freeze({
    clientId,
    teamIds: Object.freeze(rows.results.map((r) => r.external_id)),
  });
}

/** Production wiring. Client sessions hold no Planner write and no directory browse. */
export function openClientGraphSession(
  env: Env,
  ctx: GatekeeperContext,
  scope: ClientGraphScope
): ClientGraphSession {
  return clientGraphSessionFromPorts(scope, {
    queue: new D1GatekeeperQueue(env.DB, "graph", `graph:client:${scope.clientId}`, ctx),
    available: () => graphAvailable(env),
    get: (path) => graphGet(env, path),
    post: async () => {
      throw new GatekeeperDeniedError("client sessions have no generic Graph write", "graph");
    },
    patchPlannerTask: async () => {
      throw new GatekeeperDeniedError("client sessions have no Planner write", "graph");
    },
    userName: async () => undefined,
  });
}

/**
 * Bind-time check (§8 binding policy): only standard channels may be bound.
 * A private or shared channel's membership is not the Team's, so binding one
 * over-grants silently. One scoped read, minted for exactly this channel;
 * fails closed when Graph is unavailable — cannot verify means cannot bind.
 */
export async function verifyStandardChannel(
  env: Env,
  ctx: GatekeeperContext,
  teamId: string,
  channelId: string
): Promise<{ standard: boolean; membershipType: string; displayName?: string }> {
  if (!graphAvailable(env)) {
    throw new GatekeeperDeniedError(
      "cannot verify channel type without Graph consent (§9) — channel bindings refuse until it exists",
      "graph"
    );
  }
  const queue = new D1GatekeeperQueue(env.DB, "graph", `graph:channel-check:${teamId}/${channelId}`, ctx);
  const res = await graphGet<{ membershipType?: string; displayName?: string }>(
    env,
    `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}?$select=membershipType,displayName`
  );
  await queue.authorizeObservation({
    title: "Verified channel type (bind check)",
    description: `channel ${channelId} on team ${teamId}: membershipType=${res.membershipType ?? "unknown"} — name and type only`,
  });
  return {
    standard: res.membershipType === "standard",
    membershipType: res.membershipType ?? "unknown",
    ...(res.displayName ? { displayName: res.displayName } : {}),
  };
}

// ---------------------------------------------------------------------------
// Schedule (Teams Shifts) — department-wide, not project- or client-scoped.
// One Team hosts the schedule; which one is config('schedule.team_id'), set
// once by a superadmin (§9). Verified directly against Microsoft's live
// Graph reference before writing this (August 2026): shifts, timeOffRequests
// and timesOff are stable v1.0, application-permission-supported end to end.
//
// Two things this session deliberately does NOT do:
//   - Approve or decline a timeOffRequest. That endpoint's v1.0
//     application-permission support carries an active, dated Microsoft
//     deprecation this research could not resolve cleanly against its
//     documented beta replacement. A human approves natively in Shifts,
//     same as always (CLAUDE.md §1: she flags and logs, she does not
//     decide) — this session only reads the resulting state back.
//   - Write Availability. shiftPreferences/shiftAvailability is Graph BETA
//     with no v1.0 equivalent, and writing it is documented unsupported for
//     an application-only caller regardless. userAvailability() below is
//     read-only and degrades to undefined on any failure — never thrown —
//     because "unavailable" is the honest state of an API Microsoft itself
//     says is not supported in production (CLAUDE.md §11).
//
// No server-side date filter on shifts/timeOffRequests/timesOff: this
// session fetches the scoped team's full collections and callers narrow to a
// visible range themselves. A guessed OData filter that silently returns the
// wrong rows is worse than an unfiltered read a caller filters correctly —
// and for a ~30-person department the full collections are small.
// ---------------------------------------------------------------------------

export interface ScheduleScope {
  teamId: string;
}

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
  /** Read verbatim from Graph — never assumed. Typically pending/approved/declined. */
  state?: string;
}

export interface TimeOffLite {
  id: string;
  userId?: string;
  startDateTime?: string;
  endDateTime?: string;
}

/** The raw shift shape nests times under `sharedShift` (published) or
 * `draftShift` (manager-only, not this session's business to show). Parsed
 * defensively — a property Microsoft renames costs a blank cell, not a 500. */
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

export interface ScheduleSession {
  /** False until Schedule.* consent exists (§9). */
  available(): boolean;
  /** Every shift on the scoped schedule's published (sharedShift) times. Observation. */
  shifts(): Promise<ShiftLite[]>;
  /** The reasons Shifts is configured with, for a request form's dropdown. Observation. */
  timeOffReasons(): Promise<TimeOffReasonLite[]>;
  /** Every time-off request, whatever its state — callers filter. Observation. */
  timeOffRequests(): Promise<TimeOffRequestLite[]>;
  /** Confirmed/approved time-off instances — the state a request becomes once a human approves it in Shifts. Observation. */
  timesOff(): Promise<TimeOffLite[]>;
  /**
   * File a time-off request. Non-binding until a human approves it natively
   * in Shifts, so this action is auto-approvable — the same class as a
   * project-fact write (§12.1), never client-visible. Callers must pass the
   * REQUESTER'S OWN directory id as senderUserId; this session does not
   * re-verify that, the same way patchPlannerTask trusts its caller's taskId.
   */
  createTimeOffRequest(input: {
    senderUserId: string;
    startDateTime: string;
    endDateTime: string;
    timeOffReasonId?: string;
  }): Promise<{ graphId?: string }>;
  /** Scheduling groups on this team, so a pattern can name one. Observation. */
  schedulingGroups(): Promise<Array<{ id: string; displayName?: string }>>;
  /**
   * Post one shift instance. sharedShift is set and draftShift is omitted:
   * the v1.0 resource page says updates to sharedShift notify in Teams, and
   * either draft or shared must be null. Duration is checked before the
   * call (1 minute through 24 hours). Not auto-approved — the caller passes
   * the human who turned the pattern on, or who asked for this one shift.
   */
  createShift(
    input: {
      userId: string;
      schedulingGroupId: string;
      startDateTime: string;
      endDateTime: string;
      displayName?: string;
    },
    authorization: ActionAuthorization
  ): Promise<{ graphId?: string }>;
  /**
   * Delete one posted shift. A separate action from stopping a pattern.
   * Stopping a pattern does not call this.
   */
  deleteShift(shiftId: string, authorization: ActionAuthorization): Promise<void>;
  /**
   * One person's Availability, best effort. Takes an email/UPN OR an aadId —
   * Graph's /users/{id} segment resolves either, so a caller never needs a
   * stored directory-id mapping just to check availability (users.aad_id
   * does not exist as a column; this is deliberate, not a gap). Undefined on
   * ANY failure — missing consent, no availability set, or the beta resource
   * behaving unpredictably all look the same to a caller: nothing to show.
   */
  userAvailability(emailOrAadId: string): Promise<string | undefined>;
}

const SCHEDULE_ACTION_KINDS = {
  createTimeOffRequest: { tag: "schedule.create_time_off_request", label: "File a time-off request" },
  createShift: { tag: "schedule.create_shift", label: "Post a shift" },
  deleteShift: { tag: "schedule.delete_shift", label: "Delete a posted shift" },
} satisfies Record<string, ActionKind>;

function parseShift(raw: RawShift): ShiftLite {
  return {
    id: raw.id,
    ...(raw.userId ? { userId: raw.userId } : {}),
    ...(raw.sharedShift?.displayName ? { displayName: raw.sharedShift.displayName } : {}),
    ...((raw.sharedShift?.startDateTime ?? raw.startDateTime)
      ? { startDateTime: raw.sharedShift?.startDateTime ?? raw.startDateTime }
      : {}),
    ...((raw.sharedShift?.endDateTime ?? raw.endDateTime)
      ? { endDateTime: raw.sharedShift?.endDateTime ?? raw.endDateTime }
      : {}),
  };
}

export function scheduleSessionFromPorts(scope: ScheduleScope, ports: GraphPorts): ScheduleSession {
  const requireAvailable = () => {
    if (!ports.available()) {
      throw new GatekeeperDeniedError("Graph credentials are not configured (CLAUDE.md §9)", "graph");
    }
  };
  return {
    available: () => ports.available(),

    async shifts() {
      requireAvailable();
      const res = await ports.get<{ value: RawShift[] }>(
        `/teams/${encodeURIComponent(scope.teamId)}/schedule/shifts`
      );
      const shifts = res.value.map(parseShift);
      await ports.queue.authorizeObservation({
        title: `Read shifts (schedule:${scope.teamId})`,
        description: `${shifts.length} shift(s) — assignee id, published times and label only`,
      });
      return shifts;
    },

    async timeOffReasons() {
      requireAvailable();
      const res = await ports.get<{ value: Array<{ id: string; displayName?: string }> }>(
        `/teams/${encodeURIComponent(scope.teamId)}/schedule/timeOffReasons`
      );
      await ports.queue.authorizeObservation({
        title: `Read time-off reasons (schedule:${scope.teamId})`,
        description: `${res.value.length} configured reason(s)`,
      });
      return res.value.map((r) => ({ id: r.id, ...(r.displayName ? { displayName: r.displayName } : {}) }));
    },

    async timeOffRequests() {
      requireAvailable();
      const res = await ports.get<{ value: RawTimeOffRequest[] }>(
        `/teams/${encodeURIComponent(scope.teamId)}/schedule/timeOffRequests`
      );
      await ports.queue.authorizeObservation({
        title: `Read time-off requests (schedule:${scope.teamId})`,
        description: `${res.value.length} request(s) — sender id, dates and state only`,
      });
      return res.value.map((r) => ({
        id: r.id,
        ...(r.senderUserId ? { senderUserId: r.senderUserId } : {}),
        ...(r.startDateTime ? { startDateTime: r.startDateTime } : {}),
        ...(r.endDateTime ? { endDateTime: r.endDateTime } : {}),
        ...(r.state ? { state: r.state } : {}),
      }));
    },

    async timesOff() {
      requireAvailable();
      const res = await ports.get<{ value: RawTimeOff[] }>(
        `/teams/${encodeURIComponent(scope.teamId)}/schedule/timesOff`
      );
      await ports.queue.authorizeObservation({
        title: `Read confirmed time off (schedule:${scope.teamId})`,
        description: `${res.value.length} confirmed instance(s) — assignee id and dates only`,
      });
      return res.value.map((r) => ({
        id: r.id,
        ...(r.userId ? { userId: r.userId } : {}),
        ...(r.startDateTime ? { startDateTime: r.startDateTime } : {}),
        ...(r.endDateTime ? { endDateTime: r.endDateTime } : {}),
      }));
    },

    async createTimeOffRequest(input) {
      requireAvailable();
      const actionKey = `${SCHEDULE_ACTION_KINDS.createTimeOffRequest.tag}:${crypto.randomUUID()}`;
      await ports.queue.submitAction(actionKey, {
        title: `Time-off request filed (${input.senderUserId})`,
        description: `${input.startDateTime} – ${input.endDateTime}`,
        implementsRevert: false,
        autoApprovable: true,
        actionKind: SCHEDULE_ACTION_KINDS.createTimeOffRequest,
      });
      try {
        await ports.queue.recordDecision(actionKey);
        const body: Record<string, unknown> = {
          senderUserId: input.senderUserId,
          startDateTime: input.startDateTime,
          endDateTime: input.endDateTime,
          ...(input.timeOffReasonId ? { timeOffReasonId: input.timeOffReasonId } : {}),
        };
        const created = await ports.post<{ id?: string }>(
          `/teams/${encodeURIComponent(scope.teamId)}/schedule/timeOffRequests`,
          body
        );
        await ports.queue.recordApplied(actionKey, `filed${created.id ? ` as ${created.id}` : ""}`);
        return created.id ? { graphId: created.id } : {};
      } catch (err) {
        await ports.queue.recordFailed(actionKey, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    async schedulingGroups() {
      requireAvailable();
      const res = await ports.get<{ value: Array<{ id: string; displayName?: string }> }>(
        `/teams/${encodeURIComponent(scope.teamId)}/schedule/schedulingGroups`
      );
      await ports.queue.authorizeObservation({
        title: `Read scheduling groups (schedule:${scope.teamId})`,
        description: `${res.value.length} group(s) — id and name only`,
      });
      return res.value.map((group) => ({
        id: group.id,
        ...(group.displayName ? { displayName: group.displayName } : {}),
      }));
    },

    async createShift(input, authorization) {
      requireAvailable();
      const start = new Date(input.startDateTime);
      const end = new Date(input.endDateTime);
      const minutes = (end.getTime() - start.getTime()) / 60_000;
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
        throw new GatekeeperDeniedError("a shift must last at least 1 minute and at most 24 hours", "graph");
      }
      const actionKey = `${SCHEDULE_ACTION_KINDS.createShift.tag}:${input.userId}:${input.startDateTime}`;
      await ports.queue.submitAction(actionKey, {
        title: `Post shift (${input.userId})`,
        description: `${input.startDateTime} – ${input.endDateTime}${input.displayName ? ` · ${input.displayName}` : ""}`,
        implementsRevert: false,
        autoApprovable: false,
        actionKind: SCHEDULE_ACTION_KINDS.createShift,
      });
      try {
        await ports.queue.recordDecision(actionKey, authorization);
        // sharedShift publishes. draftShift is omitted so the two are not
        // both set — the v1.0 shift resource requires one of them null.
        const created = await ports.post<{ id?: string }>(
          `/teams/${encodeURIComponent(scope.teamId)}/schedule/shifts`,
          {
            userId: input.userId,
            schedulingGroupId: input.schedulingGroupId,
            sharedShift: {
              ...(input.displayName ? { displayName: input.displayName } : {}),
              startDateTime: input.startDateTime,
              endDateTime: input.endDateTime,
              theme: "blue",
            },
          }
        );
        await ports.queue.recordApplied(actionKey, `posted${created.id ? ` as ${created.id}` : ""}`);
        return created.id ? { graphId: created.id } : {};
      } catch (err) {
        await ports.queue.recordFailed(actionKey, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    async deleteShift(shiftId, authorization) {
      requireAvailable();
      if (!ports.del) {
        throw new GatekeeperDeniedError("this session cannot delete a shift", "graph");
      }
      const actionKey = `${SCHEDULE_ACTION_KINDS.deleteShift.tag}:${shiftId}`;
      await ports.queue.submitAction(actionKey, {
        title: `Delete shift ${shiftId}`,
        description: `Named delete of posted shift ${shiftId}. Stopping a pattern does not do this.`,
        implementsRevert: false,
        autoApprovable: false,
        actionKind: SCHEDULE_ACTION_KINDS.deleteShift,
      });
      try {
        await ports.queue.recordDecision(actionKey, authorization);
        await ports.del(`/teams/${encodeURIComponent(scope.teamId)}/schedule/shifts/${encodeURIComponent(shiftId)}`);
        await ports.queue.recordApplied(actionKey, `deleted ${shiftId}`);
      } catch (err) {
        await ports.queue.recordFailed(actionKey, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    async userAvailability(emailOrAadId) {
      if (!ports.available()) return undefined;
      try {
        // Best-effort, defensive parse of a beta shape (CLAUDE.md §11): a
        // short summary, not a structured model of a resource that can
        // change under us. Any failure — 404, unset, beta instability —
        // reads as "nothing to show," never as an error.
        const raw = await ports.get<{ availability?: unknown[] }>(
          `/users/${encodeURIComponent(emailOrAadId)}/settings/shiftPreferences`
        );
        const count = Array.isArray(raw.availability) ? raw.availability.length : 0;
        if (count === 0) return undefined;
        await ports.queue.authorizeObservation({
          title: "Read availability (best effort, beta)",
          description: `1 user, ${count} availability entr${count === 1 ? "y" : "ies"} — set in Shifts, read here for display only`,
        });
        return `${count} availability window${count === 1 ? "" : "s"} set in Shifts`;
      } catch {
        return undefined;
      }
    },
  };
}

/** Resolve the configured Shifts team from D1 — once, at mint (types.ts scope rule). */
export async function mintScheduleScope(env: Env): Promise<ScheduleScope | undefined> {
  const row = await env.DB.prepare(`SELECT value FROM config WHERE key = 'schedule.team_id'`).first<{
    value: string;
  }>();
  return row?.value ? Object.freeze({ teamId: row.value }) : undefined;
}

/** Production wiring: D1-backed queue, real Graph client. */
export function openScheduleSession(
  env: Env,
  ctx: GatekeeperContext,
  scope: ScheduleScope
): ScheduleSession {
  return scheduleSessionFromPorts(scope, {
    queue: new D1GatekeeperQueue(env.DB, "graph", `graph:schedule:${scope.teamId}`, ctx),
    available: () => graphAvailable(env),
    get: (path) => graphGet(env, path),
    post: (path, body) => graphPost(env, path, body),
    del: (path) => graphDelete(env, path),
    patchPlannerTask: async () => {
      throw new GatekeeperDeniedError("schedule sessions have no Planner write", "graph");
    },
    userName: (aadId) => graphUserDisplayName(env, aadId),
  });
}
