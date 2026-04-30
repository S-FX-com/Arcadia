// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — People Graph Context Provider
//
// Fetches the most relevant people for the authenticated user using the
// Microsoft 365 People graph (ranked by interaction frequency / relevance).
// Requires People.Read delegated scope.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet } from "../graph-delegated.js";
import type { RelevantPerson } from "../types.js";

interface GraphPerson {
  id: string;
  displayName: string;
  scoredEmailAddresses?: Array<{ address: string }>;
  jobTitle?: string | null;
  officeLocation?: string | null;
  personType?: { class: string; subclass: string };
}

function normalizePerson(raw: GraphPerson): RelevantPerson {
  return {
    id: raw.id,
    displayName: raw.displayName,
    mail: raw.scoredEmailAddresses?.[0]?.address ?? null,
    jobTitle: raw.jobTitle ?? null,
    officeLocation: raw.officeLocation ?? null,
    personType: raw.personType?.subclass ?? raw.personType?.class ?? "Person",
  };
}

/**
 * Returns the top people most relevant to the authenticated user,
 * ranked by Microsoft 365 interaction signals.
 * Requires People.Read delegated scope.
 */
export async function getRelevantPeople(
  accessToken: string,
  limit = 20,
): Promise<RelevantPerson[]> {
  const res = await userGraphGet<{ value: GraphPerson[] }>(
    `/me/people?$select=id,displayName,scoredEmailAddresses,jobTitle,officeLocation,personType&$top=${Math.min(limit, 50)}`,
    accessToken,
  );
  return res.value
    .filter((p) => p.personType?.class === "Person")
    .map(normalizePerson);
}
