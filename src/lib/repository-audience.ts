// Temporary audience for the M365-repository surfaces (27 September 2026).
//
// Shane narrowed every new read and write — Directory, the Leadership
// overlay, Continuing Education, shift patterns, the tenant plan index, the
// Processes catalog, and the weekly run-sheet — to the superadmin role.
// The seeded superadmins are shane@s-fx.com and alex@s-fx.com. Specialist,
// lead, and founder grants are not implemented. Widen this one function
// when that audience opens; each call site names the temporary limit.

import type { UserRecord } from "./rbac";

/** True only for an active superadmin. Inactive accounts fail closed. */
export function isRepositoryAudience(user: UserRecord): boolean {
  return user.active && user.role === "superadmin";
}
