// Shift patterns. Superadmin turns one on. The job posts a rolling horizon
// of real shift instances and skips confirmed time off. Delete of a posted
// shift is its own action. Availability is not written. Time off is not
// approved here.
//
// Temporary audience (27 September 2026): superadmin only. The calendar
// page the team already uses does not show these rows.

import type { JSX } from "preact";
import { mintScheduleScope, openScheduleSession } from "../gatekeepers/graph";
import { graphAvailable } from "../integrations/graph";
import { appendAudit } from "../lib/audit";
import { isRepositoryAudience } from "../lib/repository-audience";
import { parseWeekdays, weekdayLabels } from "../lib/shift-pattern";
import { postShiftPatterns } from "../schedule/post-patterns";
import type { UserRecord } from "../lib/rbac";
import { html, Pill, rejectCrossOrigin, Shell } from "./shell";

interface PatternRow {
  id: string;
  user_id: string;
  weekdays: string;
  start_time: string;
  end_time: string;
  scheduling_group_id: string;
  label: string | null;
  enabled: number;
  enabled_by: string;
  stopped_by: string | null;
}

interface PostRow {
  id: string;
  pattern_id: string;
  shift_date: string;
  graph_shift_id: string | null;
  deleted_at: string | null;
}

const WEEKDAYS = [
  { value: "1", label: "Mon" },
  { value: "2", label: "Tue" },
  { value: "3", label: "Wed" },
  { value: "4", label: "Thu" },
  { value: "5", label: "Fri" },
  { value: "6", label: "Sat" },
  { value: "0", label: "Sun" },
];

interface PersonOption {
  aad_id: string;
  display_name: string | null;
  mail: string | null;
}

interface GroupOption {
  id: string;
  displayName?: string;
}

export function PatternSection(props: {
  configured: boolean;
  patterns: PatternRow[];
  posts: PostRow[];
  people: PersonOption[];
  groups: GroupOption[];
}): JSX.Element {
  const { configured, patterns, posts, people, groups } = props;
  const nameOf = (id: string) => people.find((person) => person.aad_id === id)?.display_name ?? id;
  return (
    <section id="patterns">
      <h2>Shift pattern</h2>
      {patterns.length === 0 ? (
        <p class="empty">No pattern yet. Apply one to post the next eight weeks.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>When</th>
              <th>Group</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {patterns.map((pattern) => (
              <tr>
                <td>
                  {nameOf(pattern.user_id)}
                  {pattern.label ? (
                    <>
                      <br />
                      <small class="muted">{pattern.label}</small>
                    </>
                  ) : null}
                </td>
                <td>
                  {weekdayLabels(pattern.weekdays)} · {pattern.start_time}–{pattern.end_time}
                </td>
                <td>
                  <small class="muted">{groups.find((group) => group.id === pattern.scheduling_group_id)?.displayName ?? pattern.scheduling_group_id}</small>
                </td>
                <td>{pattern.enabled ? `on, by ${pattern.enabled_by}` : `stopped by ${pattern.stopped_by ?? "—"}`}</td>
                <td>
                  {pattern.enabled ? (
                    <form method="post" action="/agency/schedule/patterns/stop">
                      <input type="hidden" name="patternId" value={pattern.id} />
                      <button type="submit">Stop</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Apply a pattern</h3>
      <form method="post" action="/agency/schedule/patterns">
        <p>
          {people.length > 0 ? (
            <select name="userId" required>
              {people.map((person) => (
                <option value={person.aad_id}>{person.display_name ?? person.mail ?? person.aad_id}</option>
              ))}
            </select>
          ) : (
            <input type="text" name="userId" placeholder="directory user id" required size={40} />
          )}{" "}
          {groups.length > 0 ? (
            <select name="schedulingGroupId" required>
              {groups.map((group) => (
                <option value={group.id}>{group.displayName ?? group.id}</option>
              ))}
            </select>
          ) : (
            <input type="text" name="schedulingGroupId" placeholder="scheduling group" required size={28} />
          )}
        </p>
        <p>
          {WEEKDAYS.map((day) => (
            <label>
              <input type="checkbox" name="weekday" value={day.value} /> {day.label}{" "}
            </label>
          ))}
        </p>
        <p>
          <input type="time" name="start" required /> to <input type="time" name="end" required />{" "}
          <input type="text" name="label" placeholder="label" />{" "}
          <button type="submit" class="primary" disabled={!configured}>
            Apply
          </button>
        </p>
        <p>
          <small class="muted">
            Apply posts eight weeks of shifts and skips confirmed time off. Approval of time off stays in Shifts. Availability is not written.
          </small>
        </p>
      </form>
      {posts.length > 0 ? (
        <>
          <h3>Posted shifts</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Graph id</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr>
                  <td>{post.shift_date}</td>
                  <td>
                    <small class="muted">{post.deleted_at ? `deleted ${post.deleted_at}` : (post.graph_shift_id ?? "—")}</small>
                  </td>
                  <td>
                    {!post.deleted_at && post.graph_shift_id ? (
                      <form method="post" action="/agency/schedule/patterns/delete">
                        <input type="hidden" name="postId" value={post.id} />
                        <button class="reject" type="submit">
                          Delete shift
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

function PatternsPage(props: {
  user: UserRecord;
  configured: boolean;
  graphOk: boolean;
  patterns: PatternRow[];
  posts: PostRow[];
  people: PersonOption[];
  groups: GroupOption[];
  notice?: string;
}): JSX.Element {
  const { user, configured, graphOk, patterns, posts, people, groups, notice } = props;
  return (
    <Shell
      title="Arcadia — shift patterns"
      heading="Shift patterns"
      user={user}
      current="schedule"
      lede="A pattern posts real shifts for eight weeks and skips any date that overlaps confirmed time off. Stopping it stops new posts. A shift already posted stays until you delete that shift."
      status={
        !graphOk ? (
          <Pill tone="warn">Graph · not connected</Pill>
        ) : !configured ? (
          <Pill tone="warn">Shifts team · not configured</Pill>
        ) : (
          <Pill tone="ok">Pattern record</Pill>
        )
      }
    >
      <p class="jump">
        <a href="/agency/schedule">Back to the calendar</a>
      </p>
      {notice ? <p class="banner">{notice}</p> : null}
      {!configured ? <p>schedule.team_id is not set.</p> : null}
      <PatternSection configured={configured} patterns={patterns} posts={posts} people={people} groups={groups} />
    </Shell>
  );
}

async function load(env: Env): Promise<{ patterns: PatternRow[]; posts: PostRow[] }> {
  const patterns = (
    await env.DB.prepare(
      `SELECT id, user_id, weekdays, start_time, end_time, scheduling_group_id, label, enabled, enabled_by, stopped_by
         FROM shift_patterns ORDER BY enabled DESC, enabled_at DESC`
    ).all<PatternRow>()
  ).results;
  const posts = (
    await env.DB.prepare(
      `SELECT id, pattern_id, shift_date, graph_shift_id, deleted_at
         FROM shift_pattern_posts ORDER BY shift_date DESC LIMIT 80`
    ).all<PostRow>()
  ).results;
  return { patterns, posts };
}

export async function loadPatternContext(env: Env): Promise<{
  patterns: PatternRow[];
  posts: PostRow[];
  people: PersonOption[];
  groups: GroupOption[];
}> {
  const data = await load(env);
  const people = (
    await env.DB.prepare(
      `SELECT aad_id, display_name, mail FROM directory_profiles
        WHERE account_enabled = 1 AND user_type = 'Member' ORDER BY display_name, mail`
    ).all<PersonOption>()
  ).results;
  let groups: GroupOption[] = [];
  const scope = await mintScheduleScope(env);
  if (scope && graphAvailable(env)) {
    try {
      const session = openScheduleSession(env, { sessionId: `schedule:${crypto.randomUUID()}`, actor: "arcadia" }, scope);
      groups = await session.schedulingGroups();
    } catch (err) {
      console.error("scheduling groups", err);
    }
  }
  return { ...data, people, groups };
}

async function page(env: Env, user: UserRecord, notice?: string): Promise<Response> {
  const scope = await mintScheduleScope(env);
  const data = await loadPatternContext(env);
  return html(
    <PatternsPage
      user={user}
      configured={Boolean(scope)}
      graphOk={graphAvailable(env)}
      patterns={data.patterns}
      posts={data.posts}
      people={data.people}
      groups={data.groups}
      {...(notice ? { notice } : {})}
    />
  );
}

/** Temporary audience (27 September 2026): superadmin only. */
function deny(user: UserRecord): Response | undefined {
  if (isRepositoryAudience(user)) return undefined;
  return new Response("Shift patterns are limited to superadmin for now.", { status: 403 });
}

export async function handlePatternRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/agency/schedule/patterns")) return undefined;
  const denied = deny(user);
  if (denied) return denied;

  if (request.method === "GET" && path === "/agency/schedule/patterns") return await page(env, user);
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const form = await request.formData();
  const scope = await mintScheduleScope(env);

  if (path === "/agency/schedule/patterns") {
    if (!scope) return new Response("No Shifts team is configured.", { status: 400 });
    const userId = String(form.get("userId") ?? "").trim();
    const schedulingGroupId = String(form.get("schedulingGroupId") ?? "").trim();
    const start = String(form.get("start") ?? "").trim();
    const end = String(form.get("end") ?? "").trim();
    const label = String(form.get("label") ?? "").trim();
    const weekdays = parseWeekdays(form.getAll("weekday").map(String));
    if (!userId || !schedulingGroupId) return new Response("user and scheduling group are required", { status: 400 });
    if (weekdays.length === 0) return new Response("pick at least one weekday", { status: 400 });
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start === end) {
      return new Response("start and end are times, and they cannot be equal", { status: 400 });
    }
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO shift_patterns
         (id, team_id, user_id, weekdays, start_time, end_time, scheduling_group_id, label, enabled_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
      .bind(id, scope.teamId, userId, JSON.stringify(weekdays), start, end, schedulingGroupId, label || null, user.email)
      .run();
    await appendAudit(env.DB, {
      actor: user.email,
      action: "shift_pattern_enabled",
      subject: id,
      detail: `${userId} ${weekdays.join(",")} ${start}-${end}`,
    });
    const posted = await postShiftPatterns(env, { sessionId: `schedule:${crypto.randomUUID()}`, actor: user.email });
    return await page(env, user, `Pattern applied. ${posted.detail}`);
  }

  if (path === "/agency/schedule/patterns/stop") {
    const patternId = String(form.get("patternId") ?? "");
    await env.DB.prepare(
      `UPDATE shift_patterns SET enabled = 0, stopped_by = ?2, stopped_at = datetime('now') WHERE id = ?1 AND enabled = 1`
    )
      .bind(patternId, user.email)
      .run();
    await appendAudit(env.DB, {
      actor: user.email,
      action: "shift_pattern_stopped",
      subject: patternId,
      detail: "New posts stop. Posted shifts stay.",
    });
    return await page(env, user, "Pattern stopped. Shifts already posted are still on the schedule.");
  }

  if (path === "/agency/schedule/patterns/delete") {
    if (!scope || !graphAvailable(env)) {
      return await page(env, user, "Cannot delete a shift until Graph and the Shifts team are configured.");
    }
    const postId = String(form.get("postId") ?? "");
    const post = await env.DB.prepare(
      `SELECT id, graph_shift_id, deleted_at FROM shift_pattern_posts WHERE id = ?1`
    )
      .bind(postId)
      .first<{ id: string; graph_shift_id: string | null; deleted_at: string | null }>();
    if (!post?.graph_shift_id || post.deleted_at) return new Response("no posted shift to delete", { status: 404 });
    const session = openScheduleSession(
      env,
      { sessionId: `schedule:${crypto.randomUUID()}`, actor: user.email },
      scope
    );
    await session.deleteShift(post.graph_shift_id, {
      kind: "human_approval",
      approvalId: post.id,
      decidedBy: user.email,
    });
    await env.DB.prepare(
      `UPDATE shift_pattern_posts SET deleted_at = datetime('now'), deleted_by = ?2 WHERE id = ?1`
    )
      .bind(post.id, user.email)
      .run();
    await appendAudit(env.DB, {
      actor: user.email,
      action: "shift_deleted",
      subject: post.graph_shift_id,
      detail: "Named delete. The pattern was not edited.",
    });
    return await page(env, user, "Shift deleted. The pattern is unchanged.");
  }

  if (path === "/agency/schedule/patterns/run") {
    const result = await postShiftPatterns(env, {
      sessionId: `schedule:${crypto.randomUUID()}`,
      actor: user.email,
    });
    return await page(env, user, result.detail);
  }

  return new Response("not found", { status: 404 });
}
