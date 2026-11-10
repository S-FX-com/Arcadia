// Schedule — Teams Shifts, read live. Department-wide: which Team hosts the
// schedule lives in config('schedule.team_id'), set by an admin_users holder.
// Phase 7 rebuilds or removes this page.
//
// Two things this page deliberately does NOT do, both stated on the page
// itself rather than silently:
//   - It never approves or declines a time-off request. A human does that
//     natively in Shifts; this page only reads the result.
//   - It never invents a number. A person with nothing recorded shows
//     nothing, not a zero — matching the standard the old Client Health
//     placeholder held itself to.

import {
  createTimeOffRequest,
  graphAvailable,
  listShifts,
  listTeams,
  listTimeOffReasons,
  listTimeOffRequests,
  listTimesOff,
  userDisplayName,
  type ShiftLite,
  type TeamLite,
  type TimeOffLite,
  type TimeOffReasonLite,
} from "../integrations/graph";
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
  requireCapability,
  UnauthorizedError,
  type Identity,
  type UserRecord,
} from "../lib/rbac";
import { scheduleTeamId } from "../schedule/post-patterns";
import { handlePatternRoutes, loadPatternContext, PatternSection } from "./patterns";
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
  management: Array<{ email: string; displayName: string | null; days: number }>;
  canAdmin: boolean;
  actionError?: string;
  /** Graph group id stored as schedule.team_id, when an admin has set one. */
  currentTeamId?: string;
  teamOptions: TeamLite[];
  teamOptionsSource: "graph" | "local" | "none";
  /** The pattern form, for admin_users holders. */
  showPatterns?: boolean;
  patterns?: Awaited<ReturnType<typeof loadPatternContext>>;
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
    management,
    canAdmin,
    actionError,
    currentTeamId,
    teamOptions,
    teamOptionsSource,
  } = props;

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
            <strong>Graph is not connected.</strong> Credentials or consent are missing —
            this page has nothing live to show.
          </span>
        </div>
      ) : null}
      {!configured ? <p>schedule.team_id is not set.</p> : null}
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
          {currentTeamId ? (
            <p>
              <small class="muted">
                Currently: <code>{currentTeamId}</code>
                {teamOptions.find((t: TeamLite) => t.id === currentTeamId)
                  ? ` — ${teamOptions.find((t: TeamLite) => t.id === currentTeamId)?.displayName}`
                  : ""}
              </small>
            </p>
          ) : null}
          <form class="inline" method="post" action="/agency/schedule/config">
            {teamOptions.length > 0 ? (
              <>
                <select name="teamId">
                  <option value="">— choose a Team —</option>
                  {teamOptions.map((t: TeamLite) => (
                    <option value={t.id} selected={t.id === currentTeamId}>
                      {t.displayName}
                    </option>
                  ))}
                </select>{" "}
              </>
            ) : null}
            <input
              type="text"
              name="teamIdManual"
              placeholder={teamOptions.length > 0 ? "or paste a different group id" : "Graph group id of the Team"}
              size={32}
            />{" "}
            <button type="submit">Save</button>
          </form>
          <p>
            <small class="muted">
              {teamOptionsSource === "graph"
                ? `${teamOptions.length} Team${teamOptions.length === 1 ? "" : "s"} read live from Microsoft 365.`
                : teamOptionsSource === "local"
                  ? `${teamOptions.length} Team${teamOptions.length === 1 ? "" : "s"} already bound to a client. The full tenant list needs Group.Read.All consent, not yet granted — until then this is drawn from what's already been bound.`
                  : "No Teams to pick from yet — paste the Graph group id directly."}
            </small>
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
      {aadId && configured && graphOk ? (
        <form class="inline" method="post" action="/agency/schedule/sync">
          <button type="submit">Refresh request status from Shifts</button>
        </form>
      ) : null}
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
              Visible to each person, their lead, and Shane — the same rule person records
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

      {props.showPatterns && props.patterns ? (
        <PatternSection
          configured={configured}
          patterns={props.patterns.patterns}
          posts={props.patterns.posts}
          people={props.patterns.people}
          groups={props.patterns.groups}
        />
      ) : null}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadCalendarData(env: Env, range: ReturnType<typeof rangeFor>) {
  const teamId = await scheduleTeamId(env);
  const graphOk = graphAvailable(env);
  const empty = {
    teamId,
    graphOk,
    shiftsByDay: new Map<string, ShiftLite[]>(),
    timeOffByDay: new Map<string, TimeOffLite[]>(),
    names: {} as Record<string, string>,
    reasons: [] as TimeOffReasonLite[],
    loadError: undefined as string | undefined,
  };
  if (!teamId || !graphOk) return empty;

  try {
    const [allShifts, allTimeOff, reasons] = await Promise.all([
      listShifts(env, teamId),
      listTimesOff(env, teamId),
      listTimeOffReasons(env, teamId).catch(() => [] as TimeOffReasonLite[]),
    ]);
    const shifts = allShifts.filter((s) => isoWithinRange(s.startDateTime, range));
    const timeOff = allTimeOff.filter((t) => isoWithinRange(t.startDateTime, range));
    const ids = [...new Set([...shifts.map((s) => s.userId), ...timeOff.map((t) => t.userId)])].filter(
      (id): id is string => Boolean(id)
    );
    const resolved = await Promise.all(
      ids.map(async (id) => [id, await userDisplayName(env, id).catch(() => undefined)] as const)
    );
    const names = Object.fromEntries(resolved.filter((entry): entry is [string, string] => Boolean(entry[1])));
    return {
      teamId,
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

interface TeamOptionsResult {
  options: TeamLite[];
  source: "graph" | "local" | "none";
}

/**
 * Options for the config picker. Live tenant enumeration first (needs
 * Group.Read.All, which may not be granted); falling back to Teams already
 * bound to a client when that comes back empty. The manual text field on the
 * page covers whatever is in neither list — this never blocks configuration,
 * it only helps find the id.
 */
async function loadTeamOptions(env: Env): Promise<TeamOptionsResult> {
  const tenantWide = await listTeams(env);
  if (tenantWide.length > 0) return { options: tenantWide, source: "graph" };

  const known = (
    await env.DB.prepare(
      `SELECT external_id AS id, MIN(label) AS displayName FROM client_bindings WHERE type = 'team' GROUP BY external_id ORDER BY displayName`
    ).all<TeamLite>()
  ).results;
  return { options: known, source: known.length > 0 ? "local" : "none" };
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

  const calendar = await loadCalendarData(env, range);
  const myRequests = (
    await env.DB.prepare(
      `SELECT * FROM time_off_requests WHERE lower(requested_by) = ?1 ORDER BY start_date DESC LIMIT 50`
    )
      .bind(user.email.toLowerCase())
      .all<TimeOffRow>()
  ).results;
  const canAdmin = can(user, "admin_users");
  const management = await loadManagementLog(env, user);
  const teamOptions = canAdmin ? await loadTeamOptions(env) : { options: [], source: "none" as const };
  const patterns = canAdmin ? await loadPatternContext(env) : undefined;

  return html(
    <SchedulePage
      user={user}
      {...(identity.aadId ? { aadId: identity.aadId } : {})}
      configured={Boolean(calendar.teamId)}
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
      management={management}
      canAdmin={canAdmin}
      showPatterns={canAdmin}
      {...(patterns ? { patterns } : {})}
      {...(actionError ? { actionError } : {})}
      {...(calendar.teamId ? { currentTeamId: calendar.teamId } : {})}
      teamOptions={teamOptions.options}
      teamOptionsSource={teamOptions.source}
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
  const teamId = await scheduleTeamId(env);
  if (teamId && graphAvailable(env)) {
    try {
      const created = await createTimeOffRequest(
        env,
        teamId,
        {
          senderUserId: identity.aadId,
          startDateTime: `${startDate}T00:00:00.000Z`,
          endDateTime: `${endDate}T23:59:59.000Z`,
          ...(timeOffReasonId ? { timeOffReasonId } : {}),
        },
        user.email
      );
      graphId = created.graphId;
    } catch (err) {
      filingError = err instanceof Error ? err.message : "filing in Shifts failed";
    }
  }

  // Recorded regardless of whether Shifts filing succeeded: the ask itself
  // must not silently disappear because Graph hiccuped (surface, never
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

/** Refresh the status of the signed-in person's own pending requests from Shifts. */
async function syncSelf(env: Env, user: UserRecord): Promise<Response> {
  requireCapability(user, "view_board");
  const teamId = await scheduleTeamId(env);
  if (!teamId || !graphAvailable(env)) return backToSchedule("myrequests");

  // Status only moves on an unambiguous 'approved'/'declined' from Graph —
  // anything else stays 'pending' rather than guessing (never invent).
  const mine = (
    await env.DB.prepare(
      `SELECT id, graph_request_id FROM time_off_requests
        WHERE lower(requested_by) = ?1 AND status = 'pending' AND graph_request_id IS NOT NULL`
    )
      .bind(user.email.toLowerCase())
      .all<{ id: string; graph_request_id: string }>()
  ).results;
  if (mine.length > 0) {
    const graphRequests = await listTimeOffRequests(env, teamId);
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
  return backToSchedule("myrequests");
}

async function setScheduleTeam(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "admin_users");
  // A pasted id always wins over the dropdown — the dropdown is a convenience
  // over two best-effort lists, not the only way to name a Team.
  const manual = String(form.get("teamIdManual") ?? "").trim();
  const teamId = manual || String(form.get("teamId") ?? "").trim();
  if (!teamId) return new Response("choose a Team or paste a group id", { status: 400 });
  await env.DB.prepare(
    `INSERT INTO config (key, value, updated_by) VALUES ('schedule.team_id', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
  )
    .bind(teamId, user.email)
    .run();
  await appendAudit(env.DB, { actor: user.email, action: "schedule_team_configured", subject: teamId });
  return backToSchedule();
}

const POST_PATHS = new Set(["/agency/schedule/request-time-off", "/agency/schedule/sync", "/agency/schedule/config"]);

/** Router for /agency/schedule*. Returns undefined for paths it does not own. */
export async function handleScheduleRoutes(
  request: Request,
  env: Env,
  user: UserRecord,
  identity: Identity
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== "/agency/schedule" && !path.startsWith("/agency/schedule/")) return undefined;

  try {
    // The calendar is work-level (who's scheduled, who's off), not a person
    // record, so every role reads it. The management time-off total is the
    // one part gated per row by canViewPersonRecord.
    requireCapability(user, "view_board");

    const patternResponse = await handlePatternRoutes(request, env, user);
    if (patternResponse) return patternResponse;

    if (request.method === "GET" && path === "/agency/schedule") {
      return await renderSchedulePage(env, user, identity, url);
    }

    if (!POST_PATHS.has(path)) return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
    const form = await request.formData();

    switch (path) {
      case "/agency/schedule/request-time-off":
        return await fileTimeOff(env, user, identity, form);
      case "/agency/schedule/sync":
        return await syncSelf(env, user);
      default:
        return await setScheduleTeam(env, user, form);
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response(`Forbidden: ${err.message}`, { status: 403 });
    }
    throw err;
  }
}
