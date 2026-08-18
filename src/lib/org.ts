// The reporting line, as a structure.
//
// Arcadia already acts on who reports to whom: the Dispatcher pings a lead
// when their person sits idle, a day-7 stall is filed under the lead's name
// rather than the doer's, and a person's certification record is visible to
// that person, their lead, and Shane. Those directives all read one edge —
// `users.lead_email` — and until now nothing rendered it, so nobody could see
// what they were steering.
//
// This file turns that column into a tree, and is deliberately free of
// Cloudflare imports so the sharp parts stay directly testable: a reporting
// line that loops would hang a renderer, and a lead who is not on staff is a
// hole in the ladder rather than a display bug.

/** The subset of a staff record the chart needs. */
export interface OrgPerson {
  email: string;
  displayName?: string;
  role: string;
  leadEmail?: string;
  pod?: string;
  active: boolean;
}

export interface OrgNode {
  person: OrgPerson;
  reports: OrgNode[];
  /** Depth from the top of the chart, 0 for a root. */
  depth: number;
  /** Everyone below this node, at any depth. */
  total: number;
}

export type GapKind = "no_lead" | "lead_not_on_staff" | "lead_inactive" | "self_lead" | "cycle";

export interface OrgGap {
  person: OrgPerson;
  kind: GapKind;
  /** The lead the record names, when it names one at all. */
  namedLead?: string;
  /** What breaks while this stands, in the department's own terms. */
  consequence: string;
}

export interface OrgChart {
  roots: OrgNode[];
  gaps: OrgGap[];
  /** Every person, by lowercased email. */
  index: Map<string, OrgPerson>;
}

const CONSEQUENCE: Record<GapKind, string> = {
  no_lead:
    "No lead recorded. Their day-5 stall names nobody, their day-7 escalation has no one to file under, and idle work pings no one.",
  lead_not_on_staff:
    "Their lead is not a staff record. Escalations address someone Arcadia cannot resolve, so they go nowhere.",
  lead_inactive: "Their lead is deactivated. Escalations address an account that can no longer sign in.",
  self_lead: "They are recorded as their own lead. An escalation would be filed under the person it is about.",
  cycle:
    "The reporting line loops back on itself. There is no lead above this person, so a day-7 escalation has no terminus.",
};

const key = (email: string) => email.trim().toLowerCase();

/** Display label for a person: their name if we have one, their email if not. */
export function personLabel(person: OrgPerson): string {
  return person.displayName?.trim() || person.email;
}

/**
 * Build the chart. Everyone appears exactly once: either in the tree, or in
 * `gaps` with the reason their edge does not hold. Nobody is dropped —
 * a person missing from both lists is a person no directive reaches, which is
 * the failure this page exists to make visible.
 */
export function buildOrgChart(people: OrgPerson[]): OrgChart {
  const index = new Map<string, OrgPerson>();
  for (const person of people) index.set(key(person.email), person);

  const gaps: OrgGap[] = [];
  const gap = (person: OrgPerson, kind: GapKind, namedLead?: string) => {
    gaps.push({
      person,
      kind,
      ...(namedLead ? { namedLead } : {}),
      consequence: CONSEQUENCE[kind],
    });
  };

  /** The lead edge that actually holds, or the reason it does not. */
  const resolvedLead = new Map<string, string | undefined>();
  for (const person of people) {
    const self = key(person.email);
    const named = person.leadEmail ? key(person.leadEmail) : "";

    if (!named) {
      resolvedLead.set(self, undefined);
      // A founder or superadmin at the top of the chart is not a gap — the
      // ladder has to end somewhere.
      if (person.role !== "founder" && person.role !== "superadmin" && person.active) gap(person, "no_lead");
      continue;
    }
    if (named === self) {
      resolvedLead.set(self, undefined);
      gap(person, "self_lead", person.leadEmail);
      continue;
    }
    const lead = index.get(named);
    if (!lead) {
      resolvedLead.set(self, undefined);
      gap(person, "lead_not_on_staff", person.leadEmail);
      continue;
    }
    if (!lead.active) {
      // The edge still holds structurally — render it, but say it is broken.
      resolvedLead.set(self, named);
      if (person.active) gap(person, "lead_inactive", person.leadEmail);
      continue;
    }
    resolvedLead.set(self, named);
  }

  // A loop has no root, so it would never be reached by a walk down from one.
  // Find each one before building, and cut its members loose.
  const inCycle = new Set<string>();
  for (const person of people) {
    const seen: string[] = [];
    let cursor: string | undefined = key(person.email);
    while (cursor) {
      if (seen.includes(cursor)) {
        for (const member of seen.slice(seen.indexOf(cursor))) inCycle.add(member);
        break;
      }
      seen.push(cursor);
      cursor = resolvedLead.get(cursor);
    }
  }
  for (const member of inCycle) {
    const person = index.get(member);
    if (person) gap(person, "cycle", person.leadEmail);
  }

  const childrenOf = new Map<string, OrgPerson[]>();
  const roots: OrgPerson[] = [];
  for (const person of people) {
    const self = key(person.email);
    const lead = inCycle.has(self) ? undefined : resolvedLead.get(self);
    if (!lead) {
      roots.push(person);
      continue;
    }
    childrenOf.set(lead, [...(childrenOf.get(lead) ?? []), person]);
  }

  const byLabel = (a: OrgPerson, b: OrgPerson) => personLabel(a).localeCompare(personLabel(b));
  const build = (person: OrgPerson, depth: number): OrgNode => {
    const reports = (childrenOf.get(key(person.email)) ?? []).sort(byLabel).map((r) => build(r, depth + 1));
    return {
      person,
      reports,
      depth,
      total: reports.reduce((n, r) => n + r.total + 1, 0),
    };
  };

  // Founder first, then leads, then everyone else — the chart should read the
  // way the department does.
  const rank: Record<string, number> = { superadmin: 0, founder: 0, lead: 1, specialist: 2 };
  const ordered = roots.sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3) || byLabel(a, b));

  return { roots: ordered.map((r) => build(r, 0)), gaps, index };
}

/** Walk up from a person to the lead their escalations land on. */
export function leadOf(chart: OrgChart, email: string): OrgPerson | undefined {
  const person = chart.index.get(key(email));
  if (!person?.leadEmail) return undefined;
  const lead = chart.index.get(key(person.leadEmail));
  return lead && key(lead.email) !== key(person.email) ? lead : undefined;
}

export interface ProjectRow {
  id: string;
  name: string;
  owner: string | null;
  lead: string | null;
  pod: string | null;
}

export interface LadderDisagreement {
  project: ProjectRow;
  /** The lead the project escalates to today. */
  projectLead: string | null;
  /** The lead the chart says the owner reports to. */
  chartLead: string | null;
}

/**
 * Projects whose escalation target is not the owner's lead.
 *
 * Radar files a day-5 pod post and a day-7 founder digest against
 * `projects.lead`, which is a copy of the reporting line taken whenever the
 * project was registered. When the two disagree, the escalation goes to
 * someone who is not accountable for that person — and nothing in the system
 * says so out loud until here.
 */
export function ladderDisagreements(chart: OrgChart, projects: ProjectRow[]): LadderDisagreement[] {
  const out: LadderDisagreement[] = [];
  for (const project of projects) {
    if (!project.owner) continue;
    const chartLead = leadOf(chart, project.owner);
    const chartLeadEmail = chartLead ? key(chartLead.email) : null;
    const projectLeadEmail = project.lead ? key(project.lead) : null;
    if (chartLeadEmail === projectLeadEmail) continue;
    out.push({
      project,
      projectLead: project.lead,
      chartLead: chartLead?.email ?? null,
    });
  }
  return out;
}
