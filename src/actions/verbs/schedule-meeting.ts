// schedule_meeting — create a calendar event on the staff user's calendar.
//
// Like send_mail this is a delegated (OBO) write: the event is created in
// the human's own calendar via POST /me/events, so ctx.userToken is
// mandatory (fails closed with 'delegated_required' when absent). start /
// end are ISO-8601 datetimes; they are sent in UTC.

import type { ActionVerb } from "../framework";
import { graph } from "../../graph/client";
import { delegatedGraphToken } from "../../graph/delegated";
import {
  asObject,
  clip,
  optString,
  reqString,
  reqStringArray,
  type GraphDeps,
} from "./_util";

export interface ScheduleMeetingParams {
  subject: string;
  attendees: string[];
  start: string;
  end: string;
  body?: string;
}

export function makeScheduleMeetingVerb(
  deps: GraphDeps = { graph, delegatedGraphToken },
): ActionVerb<ScheduleMeetingParams> {
  return {
    name: "schedule_meeting",
    defaultLevel: "confirm",

    parse(raw): ScheduleMeetingParams {
      const o = asObject(raw);
      const body = optString(o, "body");
      return {
        subject: reqString(o, "subject"),
        attendees: reqStringArray(o, "attendees"),
        start: reqString(o, "start"),
        end: reqString(o, "end"),
        ...(body !== undefined ? { body } : {}),
      };
    },

    describe(p): string {
      return `Schedule "${clip(p.subject)}" with ${p.attendees.length} attendee(s) from ${p.start} to ${p.end}`;
    },

    async execute(ctx, p) {
      if (!ctx.userToken) return { ok: false, error: "delegated_required" };
      const token = await deps.delegatedGraphToken(ctx.env, ctx.userToken);
      const created = await deps.graph(ctx.env, {
        method: "POST",
        path: "/me/events",
        token,
        body: {
          subject: p.subject,
          start: { dateTime: p.start, timeZone: "UTC" },
          end: { dateTime: p.end, timeZone: "UTC" },
          attendees: p.attendees.map((address) => ({
            emailAddress: { address },
            type: "required",
          })),
          ...(p.body !== undefined
            ? { body: { contentType: "Text", content: p.body } }
            : {}),
        },
      });
      const eventId =
        typeof created === "object" &&
        created !== null &&
        typeof (created as { id?: unknown }).id === "string"
          ? (created as { id: string }).id
          : undefined;
      return {
        ok: true,
        detail: { subject: p.subject, ...(eventId ? { eventId } : {}) },
      };
    },
  };
}

export const scheduleMeetingVerb = makeScheduleMeetingVerb();
