// The Leadership chart drawn from the directory, not from users.
//
// A node is an active member user. The edge is the Arcadia manager overlay
// when one is set, otherwise the Graph manager when the app-only proof
// succeeded, otherwise users.lead_email when that address is on the chart.
// Someone with no line that holds, and nobody under them, is Unplaced.
// A loop is cut so the walk finishes, and every person still appears once.

export type EdgeSource = "overlay" | "graph" | "lead" | "none";

export interface ChartPerson {
  id: string;
  email: string | null;
  name: string;
  title: string | null;
  department: string | null;
  initials: string;
}

export interface ChartEdge {
  personId: string;
  /** Null when this person has no line that holds. */
  managerId: string | null;
  source: EdgeSource;
}

export interface ChartNode {
  person: ChartPerson;
  reports: ChartNode[];
  source: EdgeSource;
  /** The upward edge was removed because it closed a loop. */
  loop: boolean;
}

export type UnplacedReason = "no-line" | "loop" | "manager-missing";

export interface UnplacedPerson {
  person: ChartPerson;
  source: EdgeSource;
  reason: UnplacedReason;
}

export interface DirectoryTree {
  roots: ChartNode[];
  unplaced: UnplacedPerson[];
}

export interface OverlayManager {
  /** Null places the person in Unplaced and blocks Graph and lead_email. */
  managerId: string | null;
}

const byName = (a: ChartPerson, b: ChartPerson) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id);

/** Two letters from the name. One word uses its first two characters. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return `${first.slice(0, 1)}${last.slice(0, 1)}`.toUpperCase();
}

/**
 * Arcadia overlay, then Graph when the proof succeeded, then the staff
 * record. An overlay row with a null manager is an explicit Unplaced: Graph
 * and lead_email do not fill it back in.
 */
export function resolveChartEdge(input: {
  personId: string;
  overlay: OverlayManager | null;
  graphManagerId?: string | null;
  proofSucceeded: boolean;
  leadManagerId?: string | null;
}): ChartEdge {
  if (input.overlay) {
    const managerId = input.overlay.managerId?.trim() || null;
    return { personId: input.personId, managerId, source: "overlay" };
  }
  if (input.proofSucceeded) {
    const graph = input.graphManagerId?.trim() || null;
    if (graph) return { personId: input.personId, managerId: graph, source: "graph" };
  }
  const lead = input.leadManagerId?.trim() || null;
  if (lead) return { personId: input.personId, managerId: lead, source: "lead" };
  return { personId: input.personId, managerId: null, source: "none" };
}

/**
 * True when a save would record the line the chart is already drawing, so a
 * title-only save does not freeze a Microsoft 365 line into the overlay.
 */
export function sameChartLine(baseline: string, picked: string): boolean {
  const splitAt = baseline.indexOf(":");
  const source = splitAt === -1 ? baseline : baseline.slice(0, splitAt);
  const manager = splitAt === -1 ? "" : baseline.slice(splitAt + 1);
  if (picked === "__clear__") return source !== "overlay";
  if (picked === "__unplaced__") {
    if (source === "overlay") return manager.length === 0;
    if (source === "none") return true;
    return manager.length === 0;
  }
  if (picked !== manager) return false;
  return source === "overlay" || source === "graph" || source === "lead";
}

/**
 * Build the tree. People with a holding line nest under that manager. People
 * with no holding line and no one under them land in Unplaced. A loop loses
 * one edge — the person whose name sorts first — and the walk stops.
 */
export function buildDirectoryTree(people: ChartPerson[], edges: ChartEdge[]): DirectoryTree {
  const index = new Map(people.map((person) => [person.id, person]));
  const edgeById = new Map(edges.map((edge) => [edge.personId, edge]));
  const parent = new Map<string, string | null>();
  const unresolved = new Set<string>();

  for (const person of people) {
    const edge = edgeById.get(person.id);
    const managerId = edge?.managerId ?? null;
    if (!managerId) {
      parent.set(person.id, null);
      continue;
    }
    if (managerId === person.id) {
      parent.set(person.id, null);
      unresolved.add(person.id);
      continue;
    }
    if (!index.has(managerId)) {
      parent.set(person.id, null);
      unresolved.add(person.id);
      continue;
    }
    parent.set(person.id, managerId);
  }

  const cut = new Set<string>();
  for (const person of people) {
    const seen: string[] = [];
    let cursor: string | null = person.id;
    while (cursor) {
      if (seen.includes(cursor)) {
        const cycle = seen.slice(seen.indexOf(cursor));
        const cutId = [...cycle].sort((a, b) => byName(index.get(a)!, index.get(b)!))[0]!;
        cut.add(cutId);
        break;
      }
      seen.push(cursor);
      cursor = parent.get(cursor) ?? null;
    }
  }
  for (const id of cut) parent.set(id, null);

  const children = new Map<string, string[]>();
  for (const person of people) {
    const managerId = parent.get(person.id);
    if (!managerId) continue;
    children.set(managerId, [...(children.get(managerId) ?? []), person.id]);
  }

  const unplaced: UnplacedPerson[] = [];
  const rootIds: string[] = [];
  for (const person of people) {
    if (parent.get(person.id)) continue;
    const kids = children.get(person.id) ?? [];
    if (kids.length === 0) {
      const source = edgeById.get(person.id)?.source ?? "none";
      const reason: UnplacedReason = cut.has(person.id) ? "loop" : unresolved.has(person.id) ? "manager-missing" : "no-line";
      unplaced.push({ person, source, reason });
      continue;
    }
    rootIds.push(person.id);
  }

  const build = (id: string, stack: Set<string>): ChartNode => {
    const person = index.get(id)!;
    const reports = (children.get(id) ?? [])
      .filter((child) => !stack.has(child))
      .sort((a, b) => byName(index.get(a)!, index.get(b)!))
      .map((child) => build(child, new Set([...stack, id])));
    return {
      person,
      reports,
      source: edgeById.get(id)?.source ?? "none",
      loop: cut.has(id),
    };
  };

  return {
    roots: rootIds.sort((a, b) => byName(index.get(a)!, index.get(b)!)).map((id) => build(id, new Set())),
    unplaced: unplaced.sort((a, b) => byName(a.person, b.person)),
  };
}

/** Every person on the tree or in Unplaced, once. */
export function chartMembers(tree: DirectoryTree): ChartPerson[] {
  const out: ChartPerson[] = [];
  const walk = (nodes: ChartNode[]) => {
    for (const node of nodes) {
      out.push(node.person);
      walk(node.reports);
    }
  };
  walk(tree.roots);
  for (const row of tree.unplaced) out.push(row.person);
  return out;
}
