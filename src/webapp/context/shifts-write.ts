// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Shift Write Provider (Phase 12)
//
// Translates Arcadia shift templates into Teams Shifts Graph API calls.
// Teams has no native recurrence — each shift instance must be POSTed
// individually. Sequential writes with throttle delays avoid Graph rate limits.
//
// Requires Schedule.ReadWrite.All delegated scope on the user's access token.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet, userGraphPost, userGraphDelete } from "../graph-delegated.js";
import type { RecurrenceRule, ShiftTemplateRow } from "../types.js";

export interface ShiftInstance {
  assigneeId: string;
  startUtc: Date;
  endUtc: Date;
}

export interface PushResult extends ShiftInstance {
  graphShiftId: string | null;
  error?: string;
}

interface GraphShiftBody {
  userId: string;
  schedulingGroupId?: string;
  sharedShift: {
    displayName: string;
    startDateTime: string;
    endDateTime: string;
    theme: string;
    notes?: string;
    activities: [];
  };
}

/** Converts local HH:MM time to a UTC ISO string for a given date in a timezone. */
function toIsoString(date: Date, timeStr: string, timezone: string): string {
  const [hours, minutes] = timeStr.split(":").map(Number);
  // Build a date string in the target timezone using Intl
  const localDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  // Combine into a string that the Date constructor will parse as the local time
  const localStr = `${localDateStr}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
  // Find the UTC offset at this moment in the target timezone
  const testDate = new Date(localStr + "Z"); // treat as UTC temporarily
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(testDate);
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  const utcOffsetMs = testDate.getTime() - new Date(
    `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`
  ).getTime();

  // Reconstruct with the correct date (account for DST by using the actual date)
  const yyyy = localDateStr.slice(0, 4);
  const mm = localDateStr.slice(5, 7);
  const dd = localDateStr.slice(8, 10);
  const naive = new Date(`${yyyy}-${mm}-${dd}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00Z`);
  return new Date(naive.getTime() + utcOffsetMs).toISOString();
}

/**
 * Expands a recurrence rule into individual shift instances within [fromDate, toDate].
 * Returns at most maxInstances total across all assignees.
 */
export function expandRecurrence(
  rule: RecurrenceRule,
  fromDate: Date,
  toDate: Date,
  maxInstances = 500,
): ShiftInstance[] {
  const instances: ShiftInstance[] = [];
  const cursor = new Date(fromDate);
  // Start from the beginning of the from-day
  cursor.setUTCHours(0, 0, 0, 0);

  while (cursor <= toDate && instances.length < maxInstances) {
    // Get the ISO day of week in the target timezone (1=Mon … 7=Sun)
    const localDay = new Intl.DateTimeFormat("en-US", {
      timeZone: rule.timezone,
      weekday: "short",
    }).format(cursor);
    const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const isoDay = dayMap[localDay] ?? 0;

    if (rule.days.includes(isoDay)) {
      for (const assigneeId of rule.assignees) {
        const startIso = toIsoString(cursor, rule.start_time, rule.timezone);
        const endIso = toIsoString(cursor, rule.end_time, rule.timezone);
        instances.push({
          assigneeId,
          startUtc: new Date(startIso),
          endUtc: new Date(endIso),
        });
        if (instances.length >= maxInstances) break;
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return instances;
}

/**
 * Verifies the team's schedule is provisioned before writing.
 * Returns an error string if not ready, null if ready.
 */
async function checkScheduleProvisioned(teamId: string, accessToken: string): Promise<string | null> {
  try {
    const res = await userGraphGet<{ enabled: boolean; provisioningStatus?: string }>(
      `/teams/${teamId}/schedule`,
      accessToken,
    );
    if (!res.enabled) return "Team schedule is not enabled";
    if (res.provisioningStatus && res.provisioningStatus !== "Completed") {
      return `Team schedule provisioning not complete (status: ${res.provisioningStatus})`;
    }
    return null;
  } catch {
    return "Could not verify team schedule — ensure the admin is a team owner with Shifts enabled";
  }
}

/** Throttle: wait ms milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pushes expanded shift instances to the Teams Shifts Graph API sequentially.
 * Each POST is separated by a ~1100ms delay to respect Graph throttle limits.
 *
 * Requires: Schedule.ReadWrite.All delegated scope + admin must be team owner.
 */
export async function pushShiftsToTeams(
  template: ShiftTemplateRow,
  fromDate: Date,
  toDate: Date,
  accessToken: string,
): Promise<PushResult[]> {
  const provisionError = await checkScheduleProvisioned(template.team_id, accessToken);
  if (provisionError) {
    throw new Error(provisionError);
  }

  const rule = JSON.parse(template.recurrence_rule) as RecurrenceRule;
  const instances = expandRecurrence(rule, fromDate, toDate);
  const results: PushResult[] = [];

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    try {
      const body: GraphShiftBody = {
        userId: inst.assigneeId,
        ...(template.scheduling_group_id ? { schedulingGroupId: template.scheduling_group_id } : {}),
        sharedShift: {
          displayName: template.display_name ?? template.name,
          startDateTime: inst.startUtc.toISOString(),
          endDateTime: inst.endUtc.toISOString(),
          theme: template.theme,
          ...(template.notes ? { notes: template.notes } : {}),
          activities: [],
        },
      };

      const created = await userGraphPost<{ id: string }>(
        `/teams/${template.team_id}/schedule/shifts`,
        body,
        accessToken,
      );

      results.push({ ...inst, graphShiftId: created.id });
    } catch (err) {
      results.push({
        ...inst,
        graphShiftId: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Throttle: skip delay after the last item
    if (i < instances.length - 1) {
      await wait(1100);
    }
  }

  return results;
}

/**
 * Deletes a previously pushed shift from Teams.
 * Requires Schedule.ReadWrite.All and team ownership.
 */
export async function deleteShiftFromTeams(
  teamId: string,
  graphShiftId: string,
  accessToken: string,
): Promise<void> {
  await userGraphDelete(`/teams/${teamId}/schedule/shifts/${graphShiftId}`, accessToken);
}
