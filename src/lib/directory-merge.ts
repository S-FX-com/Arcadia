// Directory overlay. Graph supplies the profile read. Arcadia supplies a
// value only when someone set one here. The page says which one it is
// showing. Nothing in this file writes to Entra.
//
// Reporting lines stay on users.lead_email. A Graph manager is real only
// after a successful app-only proof response that actually carried an id.
// A skipped call, a failed call, and a 200 with no id are the same: not real.

export type FieldSource = "arcadia" | "graph" | "none";

export interface MergedField {
  /** The value the page shows. Null when neither side has one. */
  shown: string | null;
  source: FieldSource;
  graph: string | null;
  arcadia: string | null;
}

export interface GraphProfileFields {
  jobTitle?: string | null;
  department?: string | null;
  city?: string | null;
  state?: string | null;
}

export interface ArcadiaOverlay {
  titleOverride?: string | null;
  departmentOverride?: string | null;
  cityOverride?: string | null;
  stateOverride?: string | null;
}

export interface DirectoryUserInput {
  id?: string | null;
  accountEnabled?: boolean | null;
  userType?: string | null;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  mobilePhone?: string | null;
  businessPhones?: string[] | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

export type ManagerProofStatus = "skipped" | "failed" | "succeeded";

export interface ManagerProof {
  status: ManagerProofStatus;
  /** Present only when the response carried a manager id. */
  managerId?: string | null;
  managerMail?: string | null;
  /** The one user the proof call was made for. */
  probedAadId?: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mergeField(arcadia: string | null | undefined, graph: string | null | undefined): MergedField {
  const arcadiaValue = clean(arcadia);
  const graphValue = clean(graph);
  if (arcadiaValue) return { shown: arcadiaValue, source: "arcadia", graph: graphValue, arcadia: arcadiaValue };
  if (graphValue) return { shown: graphValue, source: "graph", graph: graphValue, arcadia: null };
  return { shown: null, source: "none", graph: null, arcadia: null };
}

/** Arcadia wins when it has a value. Otherwise Graph. Otherwise nothing. */
export function mergeOverlay(graph: GraphProfileFields, overlay?: ArcadiaOverlay): {
  title: MergedField;
  department: MergedField;
  city: MergedField;
  state: MergedField;
} {
  return {
    title: mergeField(overlay?.titleOverride, graph.jobTitle),
    department: mergeField(overlay?.departmentOverride, graph.department),
    city: mergeField(overlay?.cityOverride, graph.city),
    state: mergeField(overlay?.stateOverride, graph.state),
  };
}

/**
 * Active member users only. Guests and disabled accounts are not the
 * directory this page keeps. A row with no id cannot be cached.
 */
export function selectActiveMembers<T extends DirectoryUserInput>(users: T[]): T[] {
  return users.filter(
    (user) => Boolean(user.id) && user.accountEnabled === true && user.userType === "Member"
  );
}

/** mail, else userPrincipalName, lowercased. The join to users.email. */
export function directoryEmail(user: DirectoryUserInput): string | null {
  return clean(user.mail ?? user.userPrincipalName)?.toLowerCase() ?? null;
}

/**
 * Turn one proof attempt into the log row. Credentials absent → skipped,
 * and no call is made. A response with a manager id → succeeded. Everything
 * else, including 404 (no manager object) and 403 (application permissions
 * are not supported on this method), → failed. Failed is not real.
 */
export function classifyManagerCall(
  outcome:
    | { called: false }
    | { called: true; ok: true; managerId?: string | null; managerMail?: string | null }
    | { called: true; ok: false; status?: number; message: string }
): ManagerProof & { detail: string } {
  if (!outcome.called) {
    return { status: "skipped", detail: "Graph credentials are not configured. Manager was not requested." };
  }
  if (outcome.ok) {
    const managerId = outcome.managerId?.trim();
    if (!managerId) {
      return { status: "failed", detail: "The call returned no manager id. Manager is not treated as real." };
    }
    return {
      status: "succeeded",
      managerId,
      ...(outcome.managerMail?.trim() ? { managerMail: outcome.managerMail.trim() } : {}),
      detail: `App-only manager read returned ${managerId}.`,
    };
  }
  const status = outcome.status ? ` HTTP ${outcome.status}.` : "";
  return {
    status: "failed",
    detail: `Manager proof failed.${status} ${outcome.message}`.trim(),
  };
}

/**
 * The manager field is real only when the proof call returned a manager id.
 * Skipped (no credentials), failed, and a response with no id do not qualify.
 */
export function managerFieldIsReal(proof: Pick<ManagerProof, "status" | "managerId"> | null | undefined): boolean {
  return proof?.status === "succeeded" && Boolean(clean(proof.managerId));
}

/**
 * The line the chart draws. lead_email unless this person is the one the
 * proof call succeeded for AND that response named a manager. One probe is
 * not a directory of managers — everyone else stays on the Arcadia line.
 */
export function reportingLine(input: {
  leadEmail?: string | null;
  personAadId?: string | null;
  proof?: ManagerProof | null;
}): { email: string | null; source: "arcadia" | "graph" } {
  const lead = clean(input.leadEmail)?.toLowerCase() ?? null;
  if (
    managerFieldIsReal(input.proof) &&
    input.personAadId &&
    input.proof?.probedAadId === input.personAadId &&
    clean(input.proof?.managerMail)
  ) {
    return { email: clean(input.proof?.managerMail)!.toLowerCase(), source: "graph" };
  }
  return { email: lead, source: "arcadia" };
}

export interface RegionPerson {
  label: string;
  city: MergedField;
  state: MergedField;
}

export interface RegionGroup {
  region: string;
  count: number;
  people: string[];
}

/** City and state only. A street is not a field this board accepts. */
export function groupByRegion(people: RegionPerson[]): RegionGroup[] {
  const groups = new Map<string, string[]>();
  for (const person of people) {
    const city = person.city.shown;
    const state = person.state.shown;
    const region = city || state ? [city, state].filter(Boolean).join(", ") : "Region not set";
    groups.set(region, [...(groups.get(region) ?? []), person.label]);
  }
  return [...groups.entries()]
    .map(([region, names]) => ({ region, count: names.length, people: names }))
    .sort((a, b) => b.count - a.count || a.region.localeCompare(b.region));
}
