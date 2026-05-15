// Sensitivity-label policy.
//
// Microsoft Information Protection / sensitivity labels are GUIDs in
// the wild, but most tenants surface them by name (Public, General,
// Confidential, Highly Confidential, …). We accept either: the
// `policyFor(label)` function normalises by lower-case substring and
// returns one of:
//
//   public        — visible to anyone authenticated
//   restricted    — visible to authenticated users; ACL still applies
//                   if rows are present
//   confidential  — ACL required: empty ACL is treated as deny, not
//                   default-open
//   redact        — visible only to subject_aad_id; content stripped
//                   for everyone else
//
// `apply(content, label, viewer, subject)` returns the content to
// surface to the viewer — same string for permissive cases, "[redacted]"
// for the redact case.

import type { SensitivityPolicy } from "./types";

const REDACTED = "[redacted]";

// Order matters: "highly confidential" must hit before "confidential".
const LABEL_RULES: { match: RegExp; policy: SensitivityPolicy }[] = [
  { match: /highly\s*confidential|secret|restricted/, policy: "redact" },
  { match: /confidential/, policy: "confidential" },
  { match: /internal|general/, policy: "restricted" },
  { match: /public|unclassified/, policy: "public" },
];

export function policyFor(label: string | null | undefined): SensitivityPolicy {
  if (!label) return "restricted";
  const lc = label.toLowerCase();
  for (const r of LABEL_RULES) {
    if (r.match.test(lc)) return r.policy;
  }
  return "restricted";
}

export function requiresExplicitAcl(policy: SensitivityPolicy): boolean {
  return policy === "confidential" || policy === "redact";
}

/**
 * Render content for a viewer given the sensitivity policy. The viewer
 * is allowed to read once ACL passes; this is the final filter that
 * scrubs content for redact-class memories.
 */
export function applyPolicy(
  content: string,
  policy: SensitivityPolicy,
  viewerAadId: string,
  subjectAadId: string | undefined,
): string {
  if (policy !== "redact") return content;
  if (subjectAadId && subjectAadId === viewerAadId) return content;
  return REDACTED;
}
