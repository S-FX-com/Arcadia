// Roles and capabilities. Every mutating route checks a capability
// server-side; the dashboard only hides what the caller cannot do anyway.
//
// shane@s-fx.com and alex@s-fx.com are seeded as the only superadmins
// (src/schema/d1.sql). Superadmin implies every capability, including admin
// of model routing and of other users.

/**
 * An authenticated staff member, as established by src/lib/sso.ts. Defined
 * here rather than there so authorization does not depend on the mechanism
 * that produced the identity.
 */
export interface Identity {
  email: string;
  /** Entra object id — stable across email changes. */
  aadId?: string;
  name?: string;
}

export type Role = "superadmin" | "founder" | "lead" | "specialist";

export type Capability =
  | "approve_plans" // tap the site-plan approval gate (§4 Phase 4)
  | "ratify_doctrine" // promote staging → canonical
  | "view_audit" // read the audit tail
  | "view_board" // the public accountability board
  | "sign_certification" // sign a pre-flight checklist
  | "manage_projects" // register projects/owners/leads for Radar
  | "admin_models" // change model routing
  | "admin_users" // change roles and grants
  | "ask_arcadia"; // query the memory core

const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  superadmin: [
    "approve_plans",
    "ratify_doctrine",
    "view_audit",
    "view_board",
    "sign_certification",
    "manage_projects",
    "admin_models",
    "admin_users",
    "ask_arcadia",
  ],
  // The founder is not automatically a superadmin: doctrine ratification and
  // approvals are his, but tenancy administration is a separate grant.
  founder: [
    "approve_plans",
    "ratify_doctrine",
    "view_audit",
    "view_board",
    "sign_certification",
    "manage_projects",
    "ask_arcadia",
  ],
  lead: [
    "approve_plans",
    "view_audit",
    "view_board",
    "sign_certification",
    "manage_projects",
    "ask_arcadia",
  ],
  specialist: ["view_board", "sign_certification", "ask_arcadia"],
};

export interface UserRecord {
  email: string;
  displayName?: string;
  role: Role;
  leadEmail?: string;
  pod?: string;
  active: boolean;
  /** Capabilities granted beyond the role. */
  grants: Capability[];
}

interface UserRow {
  email: string;
  display_name: string | null;
  role: string;
  lead_email: string | null;
  pod: string | null;
  active: number;
}

function isRole(value: string): value is Role {
  return value === "superadmin" || value === "founder" || value === "lead" || value === "specialist";
}

function isCapability(value: string): value is Capability {
  return (ROLE_CAPABILITIES.superadmin as string[]).includes(value);
}

export class UnauthorizedError extends Error {
  constructor(capability: Capability, email: string) {
    super(`${email} lacks the "${capability}" capability`);
    this.name = "UnauthorizedError";
  }
}

/**
 * Resolve a user. An email with no row is an authenticated staff member with
 * no grants beyond the specialist baseline — SSO let them in, so they can
 * see the board and sign their own checklists, nothing more.
 */
export async function resolveUser(env: Env, identity: Identity): Promise<UserRecord> {
  const email = identity.email.toLowerCase();
  const row = await env.DB.prepare(
    `SELECT email, display_name, role, lead_email, pod, active FROM users WHERE lower(email) = ?1`
  )
    .bind(email)
    .first<UserRow>();
  const grantRows = await env.DB.prepare(`SELECT capability FROM user_capabilities WHERE lower(email) = ?1`)
    .bind(email)
    .all<{ capability: string }>()
    .catch(() => ({ results: [] as Array<{ capability: string }> }));
  const grants = grantRows.results.map((g) => g.capability).filter(isCapability);

  if (!row) {
    return { email, role: "specialist", active: true, grants };
  }
  return {
    email: row.email,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    role: isRole(row.role) ? row.role : "specialist",
    ...(row.lead_email ? { leadEmail: row.lead_email } : {}),
    ...(row.pod ? { pod: row.pod } : {}),
    active: row.active === 1,
    grants,
  };
}

export function can(user: UserRecord, capability: Capability): boolean {
  if (!user.active) return false;
  return ROLE_CAPABILITIES[user.role].includes(capability) || user.grants.includes(capability);
}

export function requireCapability(user: UserRecord, capability: Capability): void {
  if (!can(user, capability)) throw new UnauthorizedError(capability, user.email);
}

export function capabilitiesOf(user: UserRecord): Capability[] {
  if (!user.active) return [];
  return [...new Set([...ROLE_CAPABILITIES[user.role], ...user.grants])];
}

/**
 * Person memory is a sensitive layer (§5.7). Read access: the person
 * themselves, their lead, and Shane — nobody else. Staff can always see
 * their own numbers; covert scoring does more damage than the metric is worth.
 */
export function canViewPersonRecord(
  viewer: UserRecord,
  subjectEmail: string,
  subjectLeadEmail?: string
): boolean {
  if (!viewer.active) return false;
  const viewerEmail = viewer.email.toLowerCase();
  if (viewerEmail === subjectEmail.toLowerCase()) return true;
  if (subjectLeadEmail && viewerEmail === subjectLeadEmail.toLowerCase()) return true;
  return viewer.role === "superadmin" || viewer.role === "founder";
}

export async function listUsers(env: Env): Promise<UserRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT email, display_name, role, lead_email, pod, active FROM users ORDER BY role, email`
  ).all<UserRow>();
  const grantRows = await env.DB.prepare(`SELECT email, capability FROM user_capabilities`)
    .all<{ email: string; capability: string }>()
    .catch(() => ({ results: [] as Array<{ email: string; capability: string }> }));
  const grantsByEmail = new Map<string, Capability[]>();
  for (const g of grantRows.results) {
    if (!isCapability(g.capability)) continue;
    const key = g.email.toLowerCase();
    grantsByEmail.set(key, [...(grantsByEmail.get(key) ?? []), g.capability]);
  }
  return rows.results.map((row) => ({
    email: row.email,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    role: isRole(row.role) ? row.role : "specialist",
    ...(row.lead_email ? { leadEmail: row.lead_email } : {}),
    ...(row.pod ? { pod: row.pod } : {}),
    active: row.active === 1,
    grants: grantsByEmail.get(row.email.toLowerCase()) ?? [],
  }));
}

export async function upsertUser(
  env: Env,
  input: { email: string; displayName?: string; role: Role; leadEmail?: string; pod?: string }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (email, display_name, role, lead_email, pod)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(email) DO UPDATE SET
       display_name = excluded.display_name,
       role = excluded.role,
       lead_email = excluded.lead_email,
       pod = excluded.pod,
       updated_at = datetime('now')`
  )
    .bind(
      input.email.toLowerCase(),
      input.displayName ?? null,
      input.role,
      input.leadEmail?.toLowerCase() ?? null,
      input.pod ?? null
    )
    .run();
}

export async function setUserActive(env: Env, email: string, active: boolean): Promise<void> {
  await env.DB.prepare(`UPDATE users SET active = ?1, updated_at = datetime('now') WHERE lower(email) = ?2`)
    .bind(active ? 1 : 0, email.toLowerCase())
    .run();
}

export const ALL_ROLES: Role[] = ["superadmin", "founder", "lead", "specialist"];
export const ALL_CAPABILITIES: Capability[] = ROLE_CAPABILITIES.superadmin;
