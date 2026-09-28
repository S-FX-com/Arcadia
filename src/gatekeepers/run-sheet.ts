// Client run-sheet reads. Scope is a frozen set of bindings resolved at
// mint (./types.ts). Methods take no ids. The session iterates that set.
//
// Channel reads select createdDateTime and from only — the same shape the
// project session already uses. Bodies are not requested and are not
// returned. Folder reads are names and timestamps. Loop URLs are the
// strings that were bound. There is no chat binding in this scope.

import { graphAvailable, graphGet } from "../integrations/graph";
import type { ChannelFact, FolderFact, LoopFact, PlannerFact, RunSheetTask } from "../lib/run-sheet";
import { D1GatekeeperQueue } from "./log";
import type { ArcadiaActionQueue, GatekeeperContext } from "./types";

export interface RunSheetChannel {
  teamId: string;
  channelId: string;
  label: string;
}

export interface RunSheetFolder {
  driveId: string;
  path: string;
  label: string;
}

export interface RunSheetPlan {
  planId: string;
  label: string;
}

/** Frozen at mint. A binding added after this object exists is invisible. */
export interface RunSheetScope {
  clientId: string;
  plans: readonly RunSheetPlan[];
  channels: readonly RunSheetChannel[];
  folders: readonly RunSheetFolder[];
  loops: readonly LoopFact[];
  weekStart: string;
  weekEnd: string;
}

export interface RunSheetPorts {
  queue: ArcadiaActionQueue;
  available(): boolean;
  get<T>(path: string): Promise<T>;
}

export interface RunSheetSession {
  available(): boolean;
  planner(): Promise<PlannerFact[]>;
  channels(): Promise<ChannelFact[]>;
  folders(): Promise<FolderFact[]>;
  /** The URLs frozen at mint. No Graph call. */
  loops(): LoopFact[];
}

const GRAPH_ROOT_PREFIX = /^https:\/\/graph\.microsoft\.com\/v1\.0/;
const MAX_TASK_PAGES = 5;
const CHANNEL_CAP = 50;

interface RawTask {
  id: string;
  title?: string;
  percentComplete?: number;
  dueDateTime?: string | null;
  createdDateTime?: string;
  completedDateTime?: string | null;
  assignments?: Record<string, unknown>;
}

function dayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function inWindow(iso: string | null | undefined, scope: RunSheetScope): boolean {
  const day = dayOf(iso);
  if (!day) return false;
  return day >= scope.weekStart && day <= scope.weekEnd;
}

function failure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function runSheetSessionFromPorts(scope: RunSheetScope, ports: RunSheetPorts): RunSheetSession {
  // Copies at mint. Mutating the caller's arrays afterward changes nothing.
  const plans = Object.freeze([...scope.plans]);
  const channels = Object.freeze([...scope.channels]);
  const folders = Object.freeze([...scope.folders]);
  const loops = Object.freeze([...scope.loops]);
  const frozen: RunSheetScope = { ...scope, plans, channels, folders, loops };

  return {
    available: () => ports.available(),

    async planner() {
      if (!ports.available()) {
        return plans.map((plan) => ({
          planLabel: plan.label,
          available: false,
          error: "Graph credentials are not configured",
          tasks: [],
        }));
      }
      const facts: PlannerFact[] = [];
      for (const plan of plans) {
        try {
          const raw: RawTask[] = [];
          let path: string | undefined = `/planner/plans/${encodeURIComponent(plan.planId)}/tasks`;
          for (let page = 0; path && page < MAX_TASK_PAGES; page++) {
            const res: { value: RawTask[]; "@odata.nextLink"?: string } = await ports.get(path);
            raw.push(...res.value);
            path = res["@odata.nextLink"]?.replace(GRAPH_ROOT_PREFIX, "");
          }
          const tasks: RunSheetTask[] = raw.map((task) => ({
            id: task.id,
            title: task.title?.trim() || task.id,
            planLabel: plan.label,
            percentComplete: task.percentComplete ?? 0,
            dueDateTime: task.dueDateTime ?? null,
            assignees: Object.keys(task.assignments ?? {}),
            createdDateTime: task.createdDateTime ?? null,
            completedDateTime: task.completedDateTime ?? null,
          }));
          facts.push({ planLabel: plan.label, available: true, tasks });
        } catch (err) {
          facts.push({ planLabel: plan.label, available: false, error: failure(err), tasks: [] });
        }
      }
      await ports.queue.authorizeObservation({
        title: `Run-sheet Planner read (${frozen.clientId})`,
        description: `${plans.length} bound plan(s) — title, state, due, assignee ids. No descriptions.`,
      });
      return facts;
    },

    async channels() {
      if (!ports.available()) {
        return channels.map((channel) => ({
          label: channel.label,
          available: false,
          error: "Graph credentials are not configured",
          messageCount: 0,
          capped: false,
          lastActivity: null,
          authors: [],
        }));
      }
      const facts: ChannelFact[] = [];
      for (const channel of channels) {
        try {
          // $select drops the body at the request. The map below keeps
          // timestamp and author only, so a body that arrived anyway does
          // not leave this session.
          const res = await ports.get<{
            value: Array<{ createdDateTime?: string; from?: { user?: { displayName?: string } } }>;
          }>(
            `/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages?$top=${CHANNEL_CAP}&$select=createdDateTime,from`
          );
          const inWeek = res.value.filter((message) => inWindow(message.createdDateTime, frozen));
          const authors = [...new Set(inWeek.map((message) => message.from?.user?.displayName).filter(Boolean))] as string[];
          const times = inWeek
            .map((message) => message.createdDateTime)
            .filter((value): value is string => Boolean(value))
            .sort();
          facts.push({
            label: channel.label,
            available: true,
            messageCount: inWeek.length,
            capped: res.value.length >= CHANNEL_CAP,
            lastActivity: times.at(-1) ?? null,
            authors,
          });
        } catch (err) {
          facts.push({
            label: channel.label,
            available: false,
            error: failure(err),
            messageCount: 0,
            capped: false,
            lastActivity: null,
            authors: [],
          });
        }
      }
      await ports.queue.authorizeObservation({
        title: `Run-sheet channel metadata (${frozen.clientId})`,
        description: `${channels.length} bound standard channel(s) — counts, last activity, authors. No message bodies.`,
      });
      return facts;
    },

    async folders() {
      if (!ports.available()) {
        return folders.map((folder) => ({
          label: folder.label,
          available: false,
          error: "Graph credentials are not configured",
          files: [],
        }));
      }
      const facts: FolderFact[] = [];
      for (const folder of folders) {
        try {
          const res = await ports.get<{ value: Array<{ name?: string; lastModifiedDateTime?: string }> }>(
            `/drives/${encodeURIComponent(folder.driveId)}/root:${folder.path}:/children?$select=name,lastModifiedDateTime&$orderby=lastModifiedDateTime desc&$top=50`
          );
          const files = res.value
            .filter((file) => file.name && inWindow(file.lastModifiedDateTime, frozen))
            .map((file) => ({ name: file.name as string, modified: file.lastModifiedDateTime ?? null }));
          facts.push({ label: folder.label, available: true, files });
        } catch (err) {
          facts.push({ label: folder.label, available: false, error: failure(err), files: [] });
        }
      }
      await ports.queue.authorizeObservation({
        title: `Run-sheet folder names (${frozen.clientId})`,
        description: `${folders.length} bound folder(s) — names and modified times in the week. No file bytes.`,
      });
      return facts;
    },

    loops: () => [...loops],
  };
}

export interface RunSheetBindingRow {
  type: string;
  external_id: string;
  label: string;
}

/** Resolve bindings once. The session built from this scope never re-reads D1. */
export function freezeRunSheetScope(
  clientId: string,
  bindings: RunSheetBindingRow[],
  loops: LoopFact[],
  weekStart: string,
  weekEnd: string
): RunSheetScope {
  const plans: RunSheetPlan[] = [];
  const channels: RunSheetChannel[] = [];
  const folders: RunSheetFolder[] = [];
  for (const binding of bindings) {
    if (binding.type === "planner_plan") {
      plans.push({ planId: binding.external_id, label: binding.label });
    } else if (binding.type === "channel") {
      const [teamId, channelId] = binding.external_id.split("/");
      if (teamId && channelId) channels.push({ teamId, channelId, label: binding.label });
    } else if (binding.type === "sharepoint_folder") {
      const sep = binding.external_id.indexOf(":/");
      if (sep > 0) {
        folders.push({
          driveId: binding.external_id.slice(0, sep),
          path: binding.external_id.slice(sep + 1),
          label: binding.label,
        });
      }
    }
    // team, enque, repo, staging_url, and anything else are not sheet sources.
    // Chat is not a binding type. Private channels are refused at bind time.
  }
  return Object.freeze({
    clientId,
    plans: Object.freeze(plans),
    channels: Object.freeze(channels),
    folders: Object.freeze(folders),
    loops: Object.freeze([...loops]),
    weekStart,
    weekEnd,
  });
}

export function openRunSheetSession(env: Env, ctx: GatekeeperContext, scope: RunSheetScope): RunSheetSession {
  return runSheetSessionFromPorts(scope, {
    queue: new D1GatekeeperQueue(env.DB, "graph", `graph:run-sheet:${scope.clientId}`, ctx),
    available: () => graphAvailable(env),
    get: (path) => graphGet(env, path),
  });
}
