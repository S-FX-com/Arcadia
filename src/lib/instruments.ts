// Dormant accountability instruments (§1, §4.3).
//
// v5 launches with the accountability instruments dormant: detection stays
// live as a PM signal (stall_events, verification results), but nothing names
// a person publicly and nothing accumulates person-level scores while the
// posture holds. Dormant is a per-instrument flag in the config table,
// default OFF — an absent row is dormant, so a fresh database wakes nothing.
//
// Re-enablement is the §4.3 protocol, not a toggle: Shane decides adoption is
// proven, staff are told before the flag flips, and counters start at zero
// from the announcement date. The flag is config key 'instrument.<name>'
// with the literal value 'on'; anything else stays dormant.

export type Instrument = "escalation_ladder" | "certification_ledger" | "dispatch_enforcement";

/** What each flag wakes, for the admin surface and the audit trail. */
export const INSTRUMENTS: Record<Instrument, string> = {
  escalation_ladder:
    "Radar escalation ladder — day 3/5/7 filings, pod posts, founder digests, the public board",
  certification_ledger:
    "Certification Ledger — signing as a stage gate, false-certification events per person",
  dispatch_enforcement:
    "Dispatch enforcement — stage SLAs, breach escalation, idle-staff pings, pass-through detection",
};

/** The subset of D1 this module needs — injectable for tests. */
interface ConfigDb {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null> };
  };
}

export async function instrumentEnabled(db: ConfigDb, instrument: Instrument): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM config WHERE key = ?1`)
    .bind(`instrument.${instrument}`)
    .first<{ value: string }>();
  return row?.value === "on";
}
