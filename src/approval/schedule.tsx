// Schedule — Teams Shifts (§4.2 v5 Standing items). Department-wide: which
// Team hosts the schedule lives in config('schedule.team_id'), set once by a
// superadmin, not a per-project or per-client binding.
//
// Three things this page deliberately does NOT do, all stated on the page
// itself rather than silently:
//   - It never approves or declines a time-off request. A human does that
//     natively in Shifts (CLAUDE.md §1); this page only reads the result.
//   - It never writes Availability. shiftPreferences is a Graph BETA
//     resource with no v1.0 equivalent, and writing it is documented as
//     unsupported for an application-only caller regardless (CLAUDE.md §11).
//     Reading it is best-effort and shown as such.
//   - It never invents a number. A person with nothing recorded shows
//     nothing, not a zero — matching the standard the old Client Health
//     placeholder held itself to.

import {
  mintScheduleScope,
  openScheduleSession,
  type ShiftLite,
  type TimeOffLite,
  type TimeOffReasonLite,
} from "../gatekeepers/graph";
import { graphAvailable, graphUserDisplayName } from "../integrations/graph";
import {
  approvedDaysByPerson,
  dayLabel,
  daysInRange,
  daySpan,
  formatDateParam,
  groupByDay,
  isoWithinRange,
  parseDateParam,
  rangeFor,
  shiftPeriod,
  timeLabel,
  type CalendarView,
} from "../lib/schedule";
import { appendAudit } from "../lib/audit";
import {
  can,
  canViewPersonRecord,
  listUsers,
  requireCapability,
  UnauthorizedError,
  type Identity,
  type UserRecord,
} from "../lib/rbac";
import { html, Pill, rejectCrossOrigin, Shell } from "./shell";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface TimeOffRow {
  id: string;
  graph_request_id: string | null;
  requested_by: string;
  reason: string | null;
  start_date: string;
  end_date: string;
  status: "pending" | "approved" | "declined";
  filed_at: string;
  last_synced_at: string | null;
}

interface AvailabilityRow {
  email: string;
  display_name: string | null;
  summary: string;
  synced_at: string;
}

function navHref(view: CalendarView, date: Date): string {
  return `/agency/schedule?view=${view}&date=${formatDateParam(date)}`;
}

function nameFor(id: string | undefined, names: Record<string, string>): string {
  if (!id) return "unassigned";
  return names[id] ?? "unknown specialist";
}

// ---------------------------------------------------------------------------
// Calendar grid
// ---------------------------------------------------------------------------

function CalendarGrid(props: {
  view: CalendarView;
  days: Date[];
  shiftsByDay: Map<string, ShiftLite[]>;
  timeOffByDay: Map<string, TimeOffLite[]>;
  names: Record<string, string>;
}) {
  const { view, days, shiftsByDay, timeOffByDay, names } = props;
  return (
    <div class={`schedule-grid schedule-${view}`}>
      {days.map((day) => {
        const key = formatDateParam(day);
        const shifts = shiftsByDay.get(key) ?? [];
        const timeOff = timeOffByDay.get(key) ?? [];
        return (
          <div class="schedule-day">
            <h4>{dayLabel(day)}</h4>
            {shifts.length === 0 && timeOff.length === 0 ? (
              <p class="empty">nothing scheduled</p>
            ) : (
              <>
                {shifts.map((s) => (
                  <p class="schedule-shift">
                    <small class="muted">
                      {timeLabel(s.startDateTime)}–{timeLabel(s.endDateTime)}
                    </small>{" "}
                    {nameFor(s.userId, names)}
                    {s.displayName ? <small class="muted"> · {s.displayName}</small> : null}
                  </p>
                ))}
                {timeOff.map((t) => (
                  <p class="schedule-timeoff">
                    <span class="tag">off</span> {nameFor(t.userId, names)}
                  </p>
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SchedulePage(props: {
  user: UserRecord;
  aadId?: string;
  configured: boolean;
  graphOk: boolean;
  view: CalendarView;
  date: Date;
  days: Date[];
  shiftsByDay: Map<string, ShiftLite[]>;
  timeOffByDay: Map<string, TimeOffLite[]>;
  names: Record<string, string>;
  loadError?: string;
  reasons: TimeOffReasonLite[];
  myRequests: TimeOffRow[];
  availability: AvailabilityRow[];
  management: Array<{ email: string; displayName: string | null; days: number }>;
  canAdmin: boolean;
  actionError?: string;
}) {
  const {
    user,
    aadId,
    configured,
    graphOk,
    view,
    date,
    days,
    shiftsByDay,
    timeOffByDay,
    names,
    loadError,
    reasons,
    myRequests,
    availability,
    management,
    canAdmin,
    actionError,
  } = props;
  const myAvailability = availability.find((a) => a.email === user.email.toLowerCase());
  const otherAvailability = availability.filter((a) => a.email !== user.email.toLowerCase());

  return (
    <Shell
      title="Arcadia — schedule"
      heading="Schedule"
      user={user}
      current="schedule"
      lede="Teams Shifts, read live. Arcadia files a time-off request; a human approves it in Shifts, same as always — she reads the result back, she does not decide."
      status={
        !graphOk ? (
          <Pill tone="warn">Graph · not connected</Pill>
        ) : !configured ? (
          <Pill tone="warn">Shifts team · not configured</Pill>
        ) : (
          <Pill tone="ok">Connected</Pill>
        )
      }
    >
      {!graphOk ? (
        <div class="banner warn">
          <span>
            <strong>Graph is not connected.</strong> Credentials or consent are missing (CLAUDE.md §9) —
            this page has nothing live to show.
          </span>
        </div>
      ) : !configured ? (
        <div class="banner warn">
          <span>
            <strong>No Shifts team configured.</strong> A superadmin names the M365 Team that hosts the
            department's schedule below before this page can show anything live.
          </span>
        </div>
      ) : null}
      {loadError ? (
        <div class="banner warn">
          <span>
            <strong>Schedule read failed.</strong> {loadError}
          </span>
        </div>
      ) : null}
      {actionError ? (
        <p class="banner warn">{actionError}</p>
      ) : null}

      {canAdmin ? (
        <section class="card">
          <h3>Configure the Shifts team</h3>
          <form class="inline" method="post" action="/agency/schedule/config">
            <input type="text" name="teamId" placeholder="Graph group id of the Team" required size={40} />{" "}
            <button type="submit">Save</button>
          </form>
          <p>
            <small class="muted">The Graph group id of the M365 Team that has Shifts enabled for S-FX.</small>
          </p>
        </section>
      ) : null}

      <h2 id="calendar">
        Shifts — {view === "week" ? "week" : "month"} of {formatDateParam(days[0] ?? date)}
      </h2>
      <p class="jump">
        <a href={navHref(view, shiftPeriod(view, date, -1))}>← previous</a>
        <a href={navHref("week", new Date())}>today</a>
        <a href={navHref(view, shiftPeriod(view, date, 1))}>next →</a>
        <a href={navHref(view === "week" ? "month" : "week", date)}>
          switch to {view === "week" ? "month" : "week"} view
        </a>
      </p>
      {configured && graphOk ? (
        <CalendarGrid view={view} days={days} shiftsByDay={shiftsByDay} timeOffByDay={timeOffByDay} names={names} />
      ) : (
        <p class="empty">Nothing to show until Schedule is connected and configured.</p>
      )}

      <h2 id="availability">Availability</h2>
      <p>
        <small class="muted">
          Best effort — Microsoft's Availability API (Shifts' own preference-setting feature) is a beta
          resource with no stable release, and Arcadia cannot write to it on anyone's behalf even in beta.
          Set yours natively: open Teams → Shifts → your profile → Availability. Sync below to read back
          whatever you've set.
        </small>
      </p>
      {aadId ? (
        <form class="inline" method="post" action="/agency/schedule/sync">
          <button type="submit">Sync my availability &amp; requests</button>
        </form>
      ) : null}
      {myAvailability ? (
        <p>
          <strong>You:</strong> {myAvailability.summary}{" "}
          <small class="muted">(synced {myAvailability.synced_at})</small>
        </p>
      ) : (
        <p class="empty">Nothing synced for you yet.</p>
      )}
      {otherAvailability.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Availability</th>
              <th>Synced</th>
            </tr>
          </thead>
          <tbody>
            {otherAvailability.map((a) => (
              <tr>
                <td>{a.display_name ?? a.email}</td>
                <td>{a.summary}</td>
                <td>
                  <small class="muted">{a.synced_at}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canAdmin ? (
        <form class="inline" method="post" action="/agency/schedule/sync-availability-all">
          <button type="submit">Sync availability for all active staff</button>{" "}
          <small class="muted">One Graph read per person — an admin action, not a background sweep.</small>
        </form>
      ) : null}

      <h2 id="request">Request time off</h2>
      {aadId ? (
        <section class="card">
          <form method="post" action="/agency/schedule/request-time-off">
            <p>
              <label>
                Start <input type="date" name="startDate" required />
              </label>{" "}
              <label>
                End <input type="date" name="endDate" required />
              </label>
            </p>
            {reasons.length > 0 ? (
              <p>
                <select name="timeOffReasonId">
                  <option value="">(no reason category)</option>
                  {reasons.map((r) => (
                    <option value={r.id}>{r.displayName ?? r.id}</option>
                  ))}
                </select>
              </p>
            ) : null}
            <p>
              <input type="text" name="reason" placeholder="A note for your manager (optional)" size={40} />
            </p>
            <button class="primary" type="submit">
              File request
            </button>
            <p>
              <small class="muted">
                Filing is not a commitment — nothing changes until your manager approves it in Shifts.
              </small>
            </p>
          </form>
        </section>
      ) : (
        <p class="banner warn">Sign in through Microsoft (not the dev bypass) to file a time-off request.</p>
      )}

      <h3 id="myrequests">Your requests ({myRequests.length})</h3>
      {myRequests.length === 0 ? (
        <p class="empty">Nothing filed.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Dates</th>
              <th>Days</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Filed</th>
            </tr>
          </thead>
          <tbody>
            {myRequests.map((r) => (
              <tr>
                <td>
                  {r.start_date} – {r.end_date}
                </td>
                <td>{daySpan(r.start_date, r.end_date)}</td>
                <td>
                  <small class="muted">{r.reason ?? "—"}</small>
                </td>
                <td>
                  <Pill tone={r.status === "approved" ? "ok" : r.status === "declined" ? "danger" : "warn"}>
                    {r.status}
                    {!r.graph_request_id ? " · not filed in Shifts" : ""}
                  </Pill>
                </td>
                <td>
                  <small class="muted">{r.filed_at}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {management.length > 0 ? (
        <>
          <h2 id="management">Approved time off — management</h2>
          <p>
            <small class="muted">
              Visible to each person, their lead, and Shane (CLAUDE.md §5.7) — the same rule person records
              use everywhere else. Approved days only; pending and declined requests carry no total.
            </small>
          </p>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Approved days off</th>
              </tr>
            </thead>
            <tbody>
              {management.map((m) => (
                <tr>
                  <td>{m.displayName ?? m.email}</td>
                  <td>{m.days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadCalendarData(env: Env, actor: string, range: ReturnType<typeof rangeFor>) {
  const scope = await mintScheduleScope(env);
  const graphOk = graphAvailable(env);
  const empty = {
    scope,
    graphOk,
    shiftsByDay: new Map<string, ShiftLite[]>(),
    timeOffByDay: new Map<string, TimeOffLite[]>(),
    names: {} as Record<string, string>,
    reasons: [] as TimeOffReasonLite[],
    loadError: undefined as string | undefined,
  };
  if (!scope || !graphOk) return empty;

  try {
    const session = openScheduleSession(env, { sessionId: `schedule:${crypto.randomUUID()}`, actor }, scope);
    const [allShifts, allTimeOff, reasons] = await Promise.all([
      session.shifts(),
      session.timesOff(),
      session.timeOffReasons().catch(() => [] as TimeOffReasonLite[]),
    ]);
    const shifts = allShifts.filter((s) => isoWithinRange(s.startDateTime, range));
    const timeOff = allTimeOff.filter((t) => isoWithinRange(t.startDateTime, range));
    const ids = [...new Set([...shifts.map((s) => s.userId), ...timeOff.map((t) => t.userId)])].filter(
      (id): id is string => Boolean(id)
    );
    const resolved = await Promise.all(
      ids.map(async (id) => [id, await graphUserDisplayName(env, id).catch(() => undefined)] as const)
    );
    const names = Object.fromEntries(resolved.filter((entry): entry is [string, string] => Boolean(entry[1])));
    return {
      scope,
      graphOk,
      shiftsByDay: groupByDay(shifts, (s) => s.startDateTime),
      timeOffByDay: groupByDay(timeOff, (t) => t.startDateTime),
      names,
      reasons,
      loadError: undefined,
    };
  } catch (err) {
    return { ...empty, loadError: err instanceof Error ? err.message : "Schedule read failed" };
  }
}

async function loadManagementLog(env: Env, viewer: UserRecord) {
  const rows = (
    await env.DB.prepare(
      `SELECT t.requested_by, t.start_date, t.end_date, t.status, u.display_name, u.lead_email
         FROM time_off_requests t
         LEFT JOIN users u ON lower(u.email) = lower(t.requested_by)
        WHERE t.status = 'approved'`
    ).all<{
      requested_by: string;
      start_date: string;
      end_date: string;
      status: string;
      display_name: string | null;
      lead_email: string | null;
    }>()
  ).results;
  const totals = approvedDaysByPerson(rows);
  const byEmail = new Map(rows.map((r) => [r.requested_by.toLowerCase(), r]));
  return [...totals.entries()]
    .filter(([email]) => {
      const row = byEmail.get(email);
      return canViewPersonRecord(viewer, email, row?.lead_email ?? undefined);
    })
    .map(([email, days]) => ({ email, displayName: byEmail.get(email)?.display_name ?? null, days }))
    .sort((a, b) => b.days - a.days);
}

async function renderSchedulePage(
  env: Env,
  user: UserRecord,
  identity: Identity,
  url: URL,
  actionError?: string
): Promise<Response> {
  const view: CalendarView = url.searchParams.get("view") === "month" ? "month" : "week";
  const date = parseDateParam(url.searchParams.get("date"), new Date());
  const range = rangeFor(view, date);
  const days = daysInRange(range);

  const calendar = await loadCalendarData(env, user.email, range);
  const myRequests = (
    await env.DB.prepare(
      `SELECT * FROM time_off_requests WHERE lower(requested_by) = ?1 ORDER BY start_date DESC LIMIT 50`
    )
      .bind(user.email.toLowerCase())
      .all<TimeOffRow>()
  ).results;
  const availability = (
    await env.DB.prepare(`SELECT email, display_name, summary, synced_at FROM schedule_availability_cache ORDER BY email`).all<AvailabilityRow>()
  ).results;
  const canAdmin = can(user, "admin_users");
  const management = await loadManagementLog(env, user);

  return html(
    <SchedulePage
      user={user}
      {...(identity.aadId ? { aadId: identity.aadId } : {})}
      configured={Boolean(calendar.scope)}
      graphOk={calendar.graphOk}
      view={view}
      date={date}
      days={days}
      shiftsByDay={calendar.shiftsByDay}
      timeOffByDay={calendar.timeOffByDay}
      names={calendar.names}
      {...(calendar.loadError ? { loadError: calendar.loadError } : {})}
      reasons={calendar.reasons}
      myRequests={myRequests}
      availability={availability}
      management={management}
      canAdmin={canAdmin}
      {...(actionError ? { actionError } : {})}
    />
  );
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function backToSchedule(anchor?: string): Response {
  return new Response(null, { status: 303, headers: { Location: `/agency/schedule${anchor ? `#${anchor}` : ""}` } });
}

async function fileTimeOff(env: Env, user: UserRecord, identity: Identity, form: FormData): Promise<Response> {
  requireCapability(user, "view_board");
  if (!identity.aadId) {
    return await renderSchedulePage(
      env,
      user,
      identity,
      new URL("https://arcadia.s-fx.com/agency/schedule"),
      "Sign in through Microsoft to file a time-off request."
    );
  }
  const startDate = String(form.get("startDate") ?? "");
  const endDate = String(form.get("endDate") ?? "");
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || endDate < startDate) {
    return await renderSchedulePage(
      env,
      user,
      identity,
      new URL("https://arcadia.s-fx.com/agency/schedule"),
      "Enter a valid start and end date, with the end on or after the start."
    );
  }
  const reason = String(form.get("reason") ?? "").trim().slice(0, 500) || undefined;
  const timeOffReasonId = String(form.get("timeOffReasonId") ?? "").trim() || undefined;

  const id = crypto.randomUUID();
  let graphId: string | undefined;
  let filingError: string | undefined;
  const scope = await mintScheduleScope(env);
  if (scope && graphAvailable(env)) {
    try {
      const session = openScheduleSession(
        env,
        { sessionId: `schedule:${crypto.randomUUID()}`, actor: user.email },
        scope
      );
      const created = await session.createTimeOffRequest({
        senderUserId: identity.aadId,
        startDateTime: `${startDate}T00:00:00.000Z`,
        endDateTime: `${endDate}T23:59:59.000Z`,
        ...(timeOffReasonId ? { timeOffReasonId } : {}),
      });
      graphId = created.graphId;
    } catch (err) {
      filingError = err instanceof Error ? err.message : "filing in Shifts failed";
    }
  }

  // Recorded regardless of whether Shifts filing succeeded: the ask itself
  // must not silently disappear because Graph hiccuped (§1 — surface, never
  // absorb). A row with no graph_request_id renders as "not filed in Shifts"
  // so nobody mistakes it for something a manager has actually seen.
  await env.DB.prepare(
    `INSERT INTO time_off_requests (id, graph_request_id, requested_by, reason, start_date, end_date)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(id, graphId ?? null, user.email, reason ?? null, startDate, endDate)
    .run();
  await appendAudit(env.DB, {
    actor: user.email,
    action: "time_off_requested",
    subject: id,
    detail: `${startDate} – ${endDate}${reason ? `: ${reason}` : ""}${filingError ? ` (Shifts filing failed: ${filingError})` : ""}`,
  });

  if (filingError) {
    return await renderSchedulePage(
      env,
      user,
      identity,
      new URL("https://arcadia.s-fx.com/agency/schedule"),
      `Recorded, but filing in Shifts failed: ${filingError}. Tell your manager directly for now.`
    );
  }
  return backToSchedule("myrequests");
}

async function syncSelf(env: Env, user: UserRecord, identity: Identity): Promise<Response> {
  requireCapability(user, "view_board");
  const scope = await mintScheduleScope(env);
  if (!scope || !graphAvailable(env)) return backToSchedule();

  const session = openScheduleSession(
    env,
    { sessionId: `schedule:${crypto.randomUUID()}`, actor: user.email },
    scope
  );

  const summary = await session.userAvailability(identity.aadId ?? user.email);
  if (summary) {
    await env.DB.prepare(
      `INSERT INTO schedule_availability_cache (email, display_name, summary)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name, summary = excluded.summary, synced_at = datetime('now')`
    )
      .bind(user.email.toLowerCase(), user.displayName ?? null, summary)
      .run();
  }

  // Status only moves on an unambiguous 'approved'/'declined' from Graph —
  // anything else stays 'pending' rather than guessing (§1: never invent).
  const mine = (
    await env.DB.prepare(
      `SELECT id, graph_request_id FROM time_off_requests
        WHERE lower(requested_by) = ?1 AND status = 'pending' AND graph_request_id IS NOT NULL`
    )
      .bind(user.email.toLowerCase())
      .all<{ id: string; graph_request_id: string }>()
  ).results;
  if (mine.length > 0) {
    const graphRequests = await session.timeOffRequests();
    for (const row of mine) {
      const match = graphRequests.find((r) => r.id === row.graph_request_id);
      const state = match?.state?.toLowerCase();
      if (state === "approved" || state === "declined") {
        await env.DB.prepare(
          `UPDATE time_off_requests SET status = ?2, decided_at = datetime('now'), last_synced_at = datetime('now') WHERE id = ?1`
        )
          .bind(row.id, state)
          .run();
      } else {
        await env.DB.prepare(`UPDATE time_off_requests SET last_synced_at = datetime('now') WHERE id = ?1`)
          .bind(row.id)
          .run();
      }
    }
  }

  await appendAudit(env.DB, { actor: user.email, action: "schedule_synced", subject: user.email });
  return backToSchedule("availability");
}

async function syncAllAvailability(env: Env, user: UserRecord): Promise<Response> {
  requireCapability(user, "admin_users");
  const scope = await mintScheduleScope(env);
  if (!scope || !graphAvailable(env)) return backToSchedule();

  const session = openScheduleSession(
    env,
    { sessionId: `schedule:${crypto.randomUUID()}`, actor: user.email },
    scope
  );
  const staff = (await listUsers(env)).filter((s) => s.active);
  // Sequential, deliberately: this walks a BETA endpoint of undocumented
  // rate-limit behavior (CLAUDE.md §11); an admin-triggered, occasional
  // action does not need the concurrency Objectives' per-team fetch uses.
  let synced = 0;
  for (const person of staff) {
    const summary = await session.userAvailability(person.email);
    if (!summary) continue;
    await env.DB.prepare(
      `INSERT INTO schedule_availability_cache (email, display_name, summary)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name, summary = excluded.summary, synced_at = datetime('now')`
    )
      .bind(person.email.toLowerCase(), person.displayName ?? null, summary)
      .run();
    synced++;
  }
  await appendAudit(env.DB, {
    actor: user.email,
    action: "schedule_availability_bulk_synced",
    detail: `${synced} of ${staff.length} active staff`,
  });
  return backToSchedule("availability");
}

async function setScheduleTeam(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "admin_users");
  const teamId = String(form.get("teamId") ?? "").trim();
  if (!teamId) return new Response("team id is required", { status: 400 });
  await env.DB.prepare(
    `INSERT INTO config (key, value, updated_by) VALUES ('schedule.team_id', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
  )
    .bind(teamId, user.email)
    .run();
  await appendAudit(env.DB, { actor: user.email, action: "schedule_team_configured", subject: teamId });
  return backToSchedule();
}

/** Router for /agency/schedule*. Returns undefined for paths it does not own. */
export async function handleScheduleRoutes(
  request: Request,
  env: Env,
  user: UserRecord,
  identity: Identity
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/agency/schedule")) return undefined;

  try {
    // Pod-level visibility, same rule as Objectives and the accountability
    // board: the calendar is work-level (who's scheduled, who's off), not a
    // person record. The management time-off total below is the one part
    // gated per row by canViewPersonRecord (§5.7).
    requireCapability(user, "view_board");

    if (request.method === "GET" && path === "/agency/schedule") {
      return await renderSchedulePage(env, user, identity, url);
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
    const form = await request.formData();

    switch (path) {
      case "/agency/schedule/request-time-off":
        return await fileTimeOff(env, user, identity, form);
      case "/agency/schedule/sync":
        return await syncSelf(env, user, identity);
      case "/agency/schedule/sync-availability-all":
        return await syncAllAvailability(env, user);
      case "/agency/schedule/config":
        return await setScheduleTeam(env, user, form);
      default:
        return new Response("not found", { status: 404 });
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response(`Forbidden: ${err.message}`, { status: 403 });
    }
    throw err;
  }
}
