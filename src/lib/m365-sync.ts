// When a repository page should sync itself, and how the shared panel
// describes the last run. The decision is pure so a page open can be tested
// without Microsoft 365 or the agent.

export function shouldAutoSync(input: { hasRun: boolean; connected: boolean }): boolean {
  return input.connected && !input.hasRun;
}

/**
 * Never-synced pages start the job. A page that already has a run, and a
 * page whose credentials are missing, do not. The caller supplies `start`,
 * which schedules on the agent when it can and otherwise runs inline.
 */
export async function kickIfNeverSynced(input: {
  hasRun: boolean;
  connected: boolean;
  start: () => Promise<void>;
}): Promise<"skipped" | "started"> {
  if (!shouldAutoSync(input)) return "skipped";
  await input.start();
  return "started";
}

export function formatSyncedAt(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export interface DirectoryRunSnapshot {
  manager_proof: string;
  users_seen: number;
  detail: string | null;
}

/** The last directory error, in one plain sentence. A clean run returns null. */
export function directoryLastError(run: DirectoryRunSnapshot | null): string | null {
  if (!run) return null;
  const detail = run.detail ?? "";
  if (detail.startsWith("Microsoft 365 refused")) return detail;
  if (detail.includes("later manager read was refused")) {
    return "Microsoft 365 refused a manager read. Lines already read still stand.";
  }
  if (run.manager_proof === "skipped" || run.manager_proof === "succeeded") return null;
  if (/403|401|Authorization_RequestDenied|consent/i.test(detail)) {
    return "Microsoft 365 refused the directory read. Consent for User.Read.All is missing.";
  }
  if (run.users_seen > 0) {
    return "Manager was not read from Microsoft 365. The chart uses an Arcadia line or the staff record.";
  }
  return "The directory sync did not finish. Microsoft 365 returned an error.";
}

/** The last plan-index error, in one plain sentence. A clean run returns null. */
export function planLastError(detail: string | null | undefined): string | null {
  if (!detail) return null;
  if (detail.includes("Unified group")) return null;
  if (detail.includes("not configured")) return null;
  return detail;
}

export function plainDirectoryFailure(status: number | undefined): string {
  if (status === 401 || status === 403) {
    return "Microsoft 365 refused the directory read. Consent for User.Read.All is missing.";
  }
  return "The directory sync did not finish. Microsoft 365 returned an error.";
}

export function plainPlanFailure(status: number | undefined): string {
  if (status === 401 || status === 403) {
    return "Microsoft 365 refused the plan index. Consent for GroupMember.Read.All or Tasks.Read.All is missing.";
  }
  return "The plan index did not finish. Microsoft 365 returned an error.";
}
