// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Planner Context Provider (Phase 7)
//
// Fetches Planner tasks, plans, and buckets using user-delegated tokens.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet } from "../graph-delegated.js";
import type { PlannerTask, PlannerPlan, PlannerBucket } from "../types.js";

interface GraphListResponse<T> {
  value: T[];
}

/**
 * Lists all Planner tasks assigned to the authenticated user.
 */
export async function getUserTasks(accessToken: string): Promise<PlannerTask[]> {
  const res = await userGraphGet<GraphListResponse<{
    id: string;
    planId: string;
    bucketId?: string;
    title: string;
    percentComplete: number;
    dueDateTime?: string;
    assignments?: Record<string, unknown>;
    createdDateTime: string;
  }>>(
    "/me/planner/tasks?$select=id,planId,bucketId,title,percentComplete,dueDateTime,assignments,createdDateTime",
    accessToken
  );

  return res.value.map((t) => ({
    id: t.id,
    planId: t.planId,
    bucketId: t.bucketId ?? null,
    title: t.title,
    percentComplete: t.percentComplete,
    dueDateTime: t.dueDateTime ?? null,
    assignedTo: t.assignments ? Object.keys(t.assignments) : [],
    createdDateTime: t.createdDateTime,
  }));
}

/**
 * Lists tasks in a specific Planner plan.
 */
export async function getPlanTasks(
  planId: string,
  accessToken: string
): Promise<PlannerTask[]> {
  const res = await userGraphGet<GraphListResponse<{
    id: string;
    planId: string;
    bucketId?: string;
    title: string;
    percentComplete: number;
    dueDateTime?: string;
    assignments?: Record<string, unknown>;
    createdDateTime: string;
  }>>(
    `/planner/plans/${planId}/tasks?$select=id,planId,bucketId,title,percentComplete,dueDateTime,assignments,createdDateTime`,
    accessToken
  );

  return res.value.map((t) => ({
    id: t.id,
    planId: t.planId,
    bucketId: t.bucketId ?? null,
    title: t.title,
    percentComplete: t.percentComplete,
    dueDateTime: t.dueDateTime ?? null,
    assignedTo: t.assignments ? Object.keys(t.assignments) : [],
    createdDateTime: t.createdDateTime,
  }));
}

/**
 * Lists buckets in a specific Planner plan.
 */
export async function getPlanBuckets(
  planId: string,
  accessToken: string
): Promise<PlannerBucket[]> {
  const res = await userGraphGet<GraphListResponse<{
    id: string;
    name: string;
    planId: string;
    orderHint: string;
  }>>(
    `/planner/plans/${planId}/buckets?$select=id,name,planId,orderHint`,
    accessToken
  );

  return res.value.map((b) => ({
    id: b.id,
    name: b.name,
    planId: b.planId,
    orderHint: b.orderHint,
  }));
}

/**
 * Lists Planner plans the user has access to (via their groups).
 */
export async function getUserPlans(accessToken: string): Promise<PlannerPlan[]> {
  // Planner plans are associated with M365 Groups.
  // Get the user's groups first, then fetch plans for each.
  try {
    const groups = await userGraphGet<GraphListResponse<{ id: string }>>(
      "/me/memberOf/microsoft.graph.group?$select=id&$top=20",
      accessToken
    );

    const plans: PlannerPlan[] = [];
    // Fetch plans from the first few groups (avoid excessive API calls)
    const groupsToScan = groups.value.slice(0, 10);

    for (const group of groupsToScan) {
      try {
        const groupPlans = await userGraphGet<GraphListResponse<{
          id: string;
          title: string;
          owner: string;
          createdDateTime: string;
        }>>(
          `/groups/${group.id}/planner/plans?$select=id,title,owner,createdDateTime`,
          accessToken
        );

        for (const p of groupPlans.value) {
          plans.push({
            id: p.id,
            title: p.title,
            owner: p.owner,
            createdDateTime: p.createdDateTime,
          });
        }
      } catch {
        // Group may not have Planner enabled — skip silently
      }
    }

    return plans;
  } catch (err) {
    console.error("[Arcadia Webapp] Failed to fetch user plans:", err);
    return [];
  }
}
