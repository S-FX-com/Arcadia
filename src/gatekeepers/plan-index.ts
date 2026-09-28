// Tenant plan index. The session takes no group id and no plan id: it
// lists Unified groups and each group's plans. Roster containers are
// filtered by src/lib/plan-index.ts and counted, not fetched from beta.

import { graphAvailable, graphGet } from "../integrations/graph";
import { indexGroupPlans, type IndexGroup, type IndexPlan, type PlanIndexRow } from "../lib/plan-index";
import { D1GatekeeperQueue } from "./log";
import { GatekeeperDeniedError, type ArcadiaActionQueue, type GatekeeperContext } from "./types";

export interface PlanIndexPorts {
  queue: ArcadiaActionQueue;
  available(): boolean;
  get<T>(path: string): Promise<T>;
}

export interface PlanIndexSession {
  available(): boolean;
  index(): Promise<{ rows: PlanIndexRow[]; rosterOmitted: number; groupsWalked: number }>;
}

const MAX_PAGES = 10;
const GRAPH_ROOT_PREFIX = /^https:\/\/graph\.microsoft\.com\/v1\.0/;

async function pages<T>(ports: PlanIndexPorts, first: string): Promise<T[]> {
  const out: T[] = [];
  let path: string | undefined = first;
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const res: { value: T[]; "@odata.nextLink"?: string } = await ports.get(path);
    out.push(...res.value);
    path = res["@odata.nextLink"]?.replace(GRAPH_ROOT_PREFIX, "");
  }
  return out;
}

export function planIndexSessionFromPorts(ports: PlanIndexPorts): PlanIndexSession {
  return {
    available: () => ports.available(),

    async index() {
      if (!ports.available()) {
        throw new GatekeeperDeniedError("Graph credentials are not configured (CLAUDE.md §9)", "graph");
      }
      const groups = await pages<IndexGroup>(
        ports,
        "/groups?$select=id,displayName,groupTypes&$top=999"
      );
      const plansByGroupId = new Map<string, IndexPlan[]>();
      for (const group of groups) {
        if (!group.id || !(group.groupTypes ?? []).includes("Unified")) continue;
        const plans = await pages<IndexPlan>(
          ports,
          `/groups/${encodeURIComponent(group.id)}/planner/plans`
        );
        plansByGroupId.set(group.id, plans);
      }
      const indexed = indexGroupPlans(groups, plansByGroupId);
      await ports.queue.authorizeObservation({
        title: "Indexed group-owned Planner plans",
        description: `${indexed.groupsWalked} Unified group(s), ${indexed.rows.length} plan(s), ${indexed.rosterOmitted} non-group container(s) omitted. Titles and ids only.`,
      });
      return indexed;
    },
  };
}

export function openPlanIndexSession(env: Env, ctx: GatekeeperContext): PlanIndexSession {
  return planIndexSessionFromPorts({
    queue: new D1GatekeeperQueue(env.DB, "graph", "graph:plan-index", ctx),
    available: () => graphAvailable(env),
    get: (path) => graphGet(env, path),
  });
}
