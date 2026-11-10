// Directory overlay. Graph supplies the profile read. Arcadia supplies a
// value only when someone set one here. The page says which one it is
// showing. Nothing in this file writes to Entra.

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
