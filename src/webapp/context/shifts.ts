// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Teams Shifts Context Provider
//
// Fetches the authenticated user's upcoming shifts across all their Teams
// using the delegated Schedule.Read.All permission. Teams that have not
// enabled Shifts/scheduling return 403/404 and are silently skipped.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet } from "../graph-delegated.js";
import type { TeamsShift } from "../types.js";

interface GraphShift {
  id: string;
  userId: string;
  schedulingGroupId: string | null;
  sharedShift: {
    displayName: string | null;
    startDateTime: string;
    endDateTime: string;
    theme: string | null;
    notes: string | null;
    activities: Array<{ displayName: string; startDateTime: string; endDateTime: string }>;
  } | null;
  draftShift: null | unknown;
}

interface GraphSchedule {
  enabled: boolean;
}

function normalizeShift(raw: GraphShift, teamId: string): TeamsShift | null {
  const shift = raw.sharedShift;
  if (!shift) return null;
  return {
    id: raw.id,
    teamId,
    userId: raw.userId,
    displayName: shift.displayName ?? "Shift",
    startDateTime: shift.startDateTime,
    endDateTime: shift.endDateTime,
    theme: shift.theme ?? null,
    notes: shift.notes ?? null,
  };
}

/**
 * Returns the schedule-enabled subset of the provided team IDs.
 * Teams without Shifts provisioned return 404/403 — those are skipped.
 */
async function getScheduledTeamIds(teamIds: string[], accessToken: string): Promise<string[]> {
  const results = await Promise.allSettled(
    teamIds.map(async (teamId) => {
      const schedule = await userGraphGet<GraphSchedule>(
        `/teams/${teamId}/schedule?$select=enabled`,
        accessToken,
      );
      return schedule.enabled ? teamId : null;
    }),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<string | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((id): id is string => id !== null);
}

/**
 * Fetches upcoming shifts (next 14 days) for the current user across the
 * provided teams. Teams without Shifts enabled are silently skipped.
 */
export async function getUserShifts(
  accessToken: string,
  userId: string,
  teamIds: string[],
): Promise<TeamsShift[]> {
  if (teamIds.length === 0) return [];

  const now = new Date();
  const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const startFilter = now.toISOString();
  const endFilter = twoWeeksOut.toISOString();

  // Only query teams that actually have scheduling enabled
  const scheduledIds = await getScheduledTeamIds(teamIds.slice(0, 8), accessToken);
  if (scheduledIds.length === 0) return [];

  const allShifts: TeamsShift[] = [];

  await Promise.allSettled(
    scheduledIds.map(async (teamId) => {
      try {
        const res = await userGraphGet<{ value: GraphShift[] }>(
          `/teams/${teamId}/schedule/shifts?$filter=sharedShift/startDateTime ge ${startFilter} and sharedShift/startDateTime le ${endFilter}`,
          accessToken,
        );
        for (const raw of res.value) {
          // With ScheduleItem.Read the API already filters to the current user,
          // but double-check in case Schedule.Read.All returns all users.
          if (raw.userId !== userId) continue;
          const shift = normalizeShift(raw, teamId);
          if (shift) allShifts.push(shift);
        }
      } catch {
        // Scheduling may not be provisioned for this team — skip silently
      }
    }),
  );

  return allShifts.sort((a, b) => a.startDateTime.localeCompare(b.startDateTime));
}
