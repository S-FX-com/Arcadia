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

import { graphAvailable, graphGet, graphPatchPlannerTask } from "../integrations/graph";
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
}

export function graphSessionFromPorts(scope: GraphScope, ports: GraphPorts): GraphSession {
  const requireAvailable = () => {
    if (!ports.available()) {
      throw new GatekeeperDeniedError("Graph credentials are not configured (CLAUDE.md §9.7)", "graph");
    }
  };
  return {
    available: () => ports.available(),

    async plannerTasks() {
      requireAvailable();
      if (!scope.plannerPlanId) {
        throw new GatekeeperDeniedError(
          `project ${scope.projectId} has no Planner plan in scope`,
          "graph"
        );
      }
      const res = await ports.get<{ value: PlannerTaskLite[] }>(
        `/planner/plans/${scope.plannerPlanId}/tasks`
      );
      await ports.queue.authorizeObservation({
        title: `Read Planner tasks (${scope.projectId})`,
        description: `Plan ${scope.plannerPlanId}: ${res.value.length} task(s), state metadata only`,
      });
      return res.value;
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
      if (!scope.plannerPlanId) {
        throw new GatekeeperDeniedError(
          `project ${scope.projectId} has no Planner plan in scope`,
          "graph"
        );
      }
      const actionKey = `${GRAPH_ACTION_KINDS.patchPlannerTask.tag}:${taskId}`;
      await ports.queue.submitAction(actionKey, {
        title: `Planner task ${taskId} update (${scope.projectId})`,
        description: `Patch: ${JSON.stringify(patch).slice(0, 300)}`,
        implementsRevert: false,
        actionKind: GRAPH_ACTION_KINDS.patchPlannerTask,
      });
      try {
        if (authorization.kind !== "dispatch_rule" && authorization.kind !== "human_approval") {
          throw new GatekeeperDeniedError(
            `authorization kind "${authorization.kind}" cannot write task state`,
            "graph"
          );
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
  });
}
