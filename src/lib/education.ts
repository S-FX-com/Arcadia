// Continuing Education chronicle. A fact that a person completed a course
// or a certification. No expiry, no pass/fail, no rate, no "who is behind."
//
// Every active member reads it. Adding an entry needs admin_users, so a
// person does not add their own. The subject must be an active member user
// from the directory sync.

import { can, type UserRecord } from "./rbac";

export const EDUCATION_KINDS = ["course", "certification"] as const;
export type EducationKind = (typeof EDUCATION_KINDS)[number];

export function isEducationKind(value: string): value is EducationKind {
  return (EDUCATION_KINDS as readonly string[]).includes(value);
}

export function canReadContinuingEducation(user: UserRecord): boolean {
  return user.active;
}

export function canAddContinuingEducation(
  actor: UserRecord,
  subject: { activeMember: boolean }
): { ok: true } | { ok: false; reason: string } {
  if (!can(actor, "admin_users")) {
    return { ok: false, reason: "adding continuing education needs the admin_users capability" };
  }
  if (!subject.activeMember) {
    return { ok: false, reason: "the subject must be an active member user from the directory" };
  }
  return { ok: true };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateEducationInput(input: {
  kind: string;
  title: string;
  completedOn: string;
}): { ok: true; kind: EducationKind; title: string; completedOn: string } | { ok: false; reason: string } {
  if (!isEducationKind(input.kind)) return { ok: false, reason: "type is Course or Certification" };
  const title = input.title.trim();
  if (!title) return { ok: false, reason: "title is required" };
  if (title.length > 200) return { ok: false, reason: "title is too long" };
  if (!DATE.test(input.completedOn)) return { ok: false, reason: "completed-on is a date" };
  return { ok: true, kind: input.kind, title, completedOn: input.completedOn };
}
