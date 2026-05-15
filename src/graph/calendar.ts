// Calendar reads.
//
// App-only calendarView walks for a specific user. Uses Graph's
// calendarView which expands recurring series so we don't have to
// expand them ourselves.

import type { Env } from "../env";
import { graph } from "./client";

export interface CalendarEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  organizer?: { emailAddress?: { address?: string; name?: string } };
  attendees?: {
    type?: "required" | "optional" | "resource";
    status?: { response?: string };
    emailAddress?: { address?: string; name?: string };
  }[];
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  onlineMeeting?: { joinUrl?: string } | null;
  isOnlineMeeting?: boolean;
  webLink?: string;
  isCancelled?: boolean;
}

export interface CalendarPage {
  value: CalendarEvent[];
  "@odata.nextLink"?: string;
}

/**
 * Calendar view for a user between two ISO timestamps. Returns
 * concrete event instances (recurring series are expanded).
 */
export async function calendarView(
  env: Env,
  userAadId: string,
  startIso: string,
  endIso: string,
  opts: { top?: number } = {},
): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let url: string | undefined;
  do {
    const page: CalendarPage = url
      ? await graph<CalendarPage>(env, { path: url })
      : await graph<CalendarPage>(env, {
          path: `/users/${userAadId}/calendarView`,
          query: {
            startDateTime: startIso,
            endDateTime: endIso,
            $top: opts.top ?? 50,
            $orderby: "start/dateTime",
          },
        });
    for (const e of page.value) {
      if (e.isCancelled) continue;
      out.push(e);
    }
    url = page["@odata.nextLink"];
  } while (url);
  return out;
}
