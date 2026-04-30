// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Teams Shifts Context Provider
//
// Fetches the authenticated user's upcoming shifts across all their Teams
// using the delegated Schedule.Read.All permission. Teams that have not
// enabled Shifts/scheduling return 403/404 and are silently skipped.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet } from "../graph-delegated.js";
import type { TeamsShift, OpenShift, TimeOff, SwapRequest, SchedulingGroup } from "../types.js";

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

/**
 * Fetches open shifts (available for anyone to pick up) across scheduled teams.
 */
export async function getOpenShifts(
  accessToken: string,
  scheduledTeamIds: string[],
): Promise<OpenShift[]> {
  const results: OpenShift[] = [];
  const now = new Date().toISOString();

  await Promise.allSettled(
    scheduledTeamIds.slice(0, 8).map(async (teamId) => {
      try {
        const res = await userGraphGet<{
          value: Array<{
            id: string;
            openSlotCount: number;
            sharedOpenShift: {
              displayName: string | null;
              startDateTime: string;
              endDateTime: string;
              theme: string | null;
              notes: string | null;
            } | null;
          }>;
        }>(`/teams/${teamId}/schedule/openShifts`, accessToken);

        for (const s of res.value) {
          const shared = s.sharedOpenShift;
          if (!shared || shared.startDateTime < now) continue;
          results.push({
            id: s.id,
            teamId,
            displayName: shared.displayName,
            startDateTime: shared.startDateTime,
            endDateTime: shared.endDateTime,
            theme: shared.theme,
            notes: shared.notes,
            openSlotCount: s.openSlotCount,
          });
        }
      } catch {
        // Team may not have open shifts
      }
    }),
  );

  return results.sort((a, b) => a.startDateTime.localeCompare(b.startDateTime));
}

/**
 * Fetches approved time-off entries for the next 30 days across scheduled teams.
 */
export async function getTimesOff(
  accessToken: string,
  scheduledTeamIds: string[],
): Promise<TimeOff[]> {
  const results: TimeOff[] = [];
  const now = new Date().toISOString();
  const thirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await Promise.allSettled(
    scheduledTeamIds.slice(0, 8).map(async (teamId) => {
      try {
        const res = await userGraphGet<{
          value: Array<{
            id: string;
            userId: string;
            sharedTimeOff: {
              startDateTime: string;
              endDateTime: string;
              theme: string | null;
            } | null;
          }>;
        }>(`/teams/${teamId}/schedule/timesOff`, accessToken);

        for (const t of res.value) {
          const shared = t.sharedTimeOff;
          if (!shared) continue;
          if (shared.endDateTime < now || shared.startDateTime > thirtyDays) continue;
          results.push({
            id: t.id,
            teamId,
            userId: t.userId,
            startDateTime: shared.startDateTime,
            endDateTime: shared.endDateTime,
            theme: shared.theme,
          });
        }
      } catch {
        // Team may not have time-off data
      }
    }),
  );

  return results;
}

/**
 * Fetches pending shift-swap requests across scheduled teams.
 */
export async function getSwapRequests(
  accessToken: string,
  scheduledTeamIds: string[],
): Promise<SwapRequest[]> {
  const results: SwapRequest[] = [];

  await Promise.allSettled(
    scheduledTeamIds.slice(0, 8).map(async (teamId) => {
      try {
        const res = await userGraphGet<{
          value: Array<{
            id: string;
            senderUserId: string;
            recipientUserId: string;
            state: string;
            createdDateTime: string;
          }>;
        }>(`/teams/${teamId}/schedule/swapRequests?$filter=state eq 'pending'`, accessToken);

        for (const r of res.value) {
          results.push({
            id: r.id,
            teamId,
            senderUserId: r.senderUserId,
            recipientUserId: r.recipientUserId,
            state: r.state,
            createdDateTime: r.createdDateTime,
          });
        }
      } catch {
        // Team may not have swap requests
      }
    }),
  );

  return results;
}

/**
 * Fetches active scheduling groups (e.g. "Kitchen", "Floor") for scheduled teams.
 */
export async function getSchedulingGroups(
  accessToken: string,
  scheduledTeamIds: string[],
): Promise<SchedulingGroup[]> {
  const results: SchedulingGroup[] = [];

  await Promise.allSettled(
    scheduledTeamIds.slice(0, 8).map(async (teamId) => {
      try {
        const res = await userGraphGet<{
          value: Array<{ id: string; displayName: string; isActive: boolean }>;
        }>(`/teams/${teamId}/schedule/schedulingGroups`, accessToken);

        for (const g of res.value) {
          if (!g.isActive) continue;
          results.push({ id: g.id, teamId, displayName: g.displayName, isActive: g.isActive });
        }
      } catch {
        // Team may not have scheduling groups
      }
    }),
  );

  return results;
}
