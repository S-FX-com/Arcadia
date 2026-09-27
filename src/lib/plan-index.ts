// Tenant plan index. Group-owned Planner plans only.
//
// GET /planner/plans has no unfiltered tenant dump (v1.0, checked 27
// September 2026). The walk is Unified groups, then each group's plans.
// Roster-owned plans are a beta route and stay out. A plan that arrives
// with a container type other than "group" is omitted and counted — the
// page says they are not listed because there is no supported list API.

export interface IndexGroup {
  id?: string | null;
  displayName?: string | null;
  groupTypes?: string[] | null;
}

export interface IndexPlan {
  id?: string | null;
  title?: string | null;
  container?: { type?: string | null } | null;
}

export interface PlanIndexRow {
  planId: string;
  groupId: string;
  groupName: string;
  title: string;
}

export function isUnifiedGroup(group: IndexGroup): boolean {
  return Boolean(group.id) && (group.groupTypes ?? []).includes("Unified");
}

/**
 * One row per plan id. Non-unified groups are not walked. A container type
 * other than "group" (including "roster") is omitted and counted. A missing
 * container type still came from the group plans route, so it stays.
 */
export function indexGroupPlans(
  groups: IndexGroup[],
  plansByGroupId: ReadonlyMap<string, IndexPlan[]>
): { rows: PlanIndexRow[]; rosterOmitted: number; groupsWalked: number } {
  const rows: PlanIndexRow[] = [];
  const seen = new Set<string>();
  let rosterOmitted = 0;
  let groupsWalked = 0;
  for (const group of groups) {
    if (!isUnifiedGroup(group) || !group.id) continue;
    groupsWalked++;
    const plans = plansByGroupId.get(group.id) ?? [];
    for (const plan of plans) {
      if (!plan.id) continue;
      const containerType = plan.container?.type?.trim().toLowerCase();
      if (containerType && containerType !== "group") {
        rosterOmitted++;
        continue;
      }
      if (seen.has(plan.id)) continue;
      seen.add(plan.id);
      rows.push({
        planId: plan.id,
        groupId: group.id,
        groupName: group.displayName?.trim() || group.id,
        title: plan.title?.trim() || plan.id,
      });
    }
  }
  rows.sort((a, b) => a.groupName.localeCompare(b.groupName) || a.title.localeCompare(b.title));
  return { rows, rosterOmitted, groupsWalked };
}

/** The sentence the page always shows. The count is how many rows were dropped. */
export function rosterOmissionNote(rosterOmitted: number): string {
  const count = rosterOmitted === 1 ? "1 plan" : `${rosterOmitted} plans`;
  return `${count} omitted — roster container, no supported list API. Roster plans are not listed.`;
}
