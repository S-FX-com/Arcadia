// Accounts a superadmin marked Ignore: distribution lists and shared
// inboxes. The row lives in Arcadia. The account stays in Microsoft 365.
// Staff lists omit these ids. Deleting the row puts the account back.

export function partitionIgnored<T extends { aadId: string }>(
  people: readonly T[],
  ignoredIds: Iterable<string>
): { visible: T[]; ignored: T[] } {
  const ignored = new Set(ignoredIds);
  const visible: T[] = [];
  const held: T[] = [];
  for (const person of people) {
    if (ignored.has(person.aadId)) held.push(person);
    else visible.push(person);
  }
  return { visible, ignored: held };
}

// The outer column has to be qualified. A bare `aad_id` binds to
// directory_ignored inside the subquery, and one ignored row would hide
// every person.
const AAD_COLUMNS = ["p.aad_id", "directory_profiles.aad_id"] as const;
export type AadColumn = (typeof AAD_COLUMNS)[number];

/** Active-member queries append this so an ignored account is not a person in the list. */
export function notIgnoredSql(aadColumn: AadColumn): string {
  return `NOT EXISTS (SELECT 1 FROM directory_ignored i WHERE i.aad_id = ${aadColumn})`;
}
