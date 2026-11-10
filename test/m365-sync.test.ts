import { describe, expect, it } from "vitest";
import { directoryLastError, formatSyncedAt, kickIfNeverSynced, plainDirectoryFailure, shouldAutoSync } from "../src/lib/m365-sync";

describe("never-synced auto-run", () => {
  it("starts a sync on open only when nothing has synced and Microsoft 365 is connected", async () => {
    const starts: string[] = [];
    const start = async () => {
      starts.push("yes");
    };
    expect(shouldAutoSync({ hasRun: false, connected: true })).toBe(true);
    expect(shouldAutoSync({ hasRun: true, connected: true })).toBe(false);
    expect(shouldAutoSync({ hasRun: false, connected: false })).toBe(false);
    expect(await kickIfNeverSynced({ hasRun: false, connected: true, start })).toBe("started");
    expect(await kickIfNeverSynced({ hasRun: true, connected: true, start })).toBe("skipped");
    expect(await kickIfNeverSynced({ hasRun: false, connected: false, start })).toBe("skipped");
    expect(starts).toEqual(["yes"]);
  });

  it("turns a refused read into one plain sentence and stays quiet on a clean or skipped run", () => {
    expect(directoryLastError(null)).toBeNull();
    expect(directoryLastError({ manager_proof: "succeeded", detail: "41 active member user(s)." })).toBeNull();
    expect(directoryLastError({ manager_proof: "skipped", detail: "Graph credentials are not configured." })).toBeNull();
    expect(directoryLastError({ manager_proof: "failed", detail: "HTTP 403 Authorization_RequestDenied" })).toBe(
      "Microsoft 365 refused the directory read. Consent for User.Read.All is missing."
    );
    expect(directoryLastError({ manager_proof: "failed", detail: plainDirectoryFailure(403) })).toBe(plainDirectoryFailure(403));
    expect(directoryLastError({ manager_proof: "failed", detail: "socket hang up" })).toBe(
      "The directory sync did not finish. Microsoft 365 returned an error."
    );
  });

  it("formats the last sync time for the panel", () => {
    expect(formatSyncedAt(null)).toBe("Never");
    expect(formatSyncedAt("2026-11-09T06:15:00.000Z")).toBe("2026-11-09 06:15:00 UTC");
  });
});
