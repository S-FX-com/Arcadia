// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Calendar Context Provider
//
// Fetches the authenticated user's Outlook calendar events for the next 7 days
// using the delegated Calendars.Read scope.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet } from "../graph-delegated.js";
import type { CalendarEvent } from "../types.js";

interface GraphEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  location?: { displayName: string };
  organizer?: { emailAddress: { name: string } };
  attendees?: unknown[];
  isOnlineMeeting: boolean;
  bodyPreview?: string;
}

function normalizeEvent(raw: GraphEvent): CalendarEvent {
  return {
    id: raw.id,
    subject: raw.subject,
    startDateTime: raw.start.dateTime,
    endDateTime: raw.end.dateTime,
    isAllDay: raw.isAllDay ?? false,
    location: raw.location?.displayName ?? null,
    organizer: raw.organizer?.emailAddress?.name ?? null,
    attendeeCount: Array.isArray(raw.attendees) ? raw.attendees.length : 0,
    isOnlineMeeting: raw.isOnlineMeeting ?? false,
    bodyPreview: raw.bodyPreview?.slice(0, 200) ?? null,
  };
}

/**
 * Returns the user's calendar events for the next 7 days, ordered by start time.
 * Requires Calendars.Read delegated scope.
 */
export async function getUpcomingEvents(
  accessToken: string,
  daysAhead = 7,
): Promise<CalendarEvent[]> {
  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const startParam = now.toISOString();
  const endParam = end.toISOString();

  const res = await userGraphGet<{ value: GraphEvent[] }>(
    `/me/calendarView?startDateTime=${startParam}&endDateTime=${endParam}&$select=id,subject,start,end,isAllDay,location,organizer,attendees,isOnlineMeeting,bodyPreview&$top=50&$orderby=start/dateTime`,
    accessToken,
  );

  return res.value.map(normalizeEvent);
}
