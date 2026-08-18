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

import { graphAvailable, graphGet, graphPatchPlannerTask, graphUserDisplayName } from "../integrations/graph";
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
    patchPlannerTask: async (taskId, etag, patch) => {
      await graphPatchPlannerTask(env, taskId, etag, patch);
    },
    userName: (aadId) => graphUserDisplayName(env, aadId),
  });
}
