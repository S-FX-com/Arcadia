// Continuing Education — a chronicle of courses and certifications.
// Not the Certification Ledger. No expiry list, no completion rate.
//
// The route stays reachable. Rows are temporary-audience superadmin only
// (27 September 2026).

import type { JSX } from "preact";
import { appendAudit } from "../lib/audit";
import { canAddContinuingEducation, canReadContinuingEducation, validateEducationInput } from "../lib/education";
import type { UserRecord } from "../lib/rbac";
import { html, Pill, rejectCrossOrigin, Shell } from "./shell";

interface Subject {
  aad_id: string;
  mail: string | null;
  display_name: string | null;
}

interface Entry {
  id: string;
  subject_email: string | null;
  display_name: string | null;
  kind: string;
  title: string;
  completed_on: string;
  provider: string | null;
  note: string | null;
  added_by: string;
  added_at: string;
}

function ClosedPage(props: { user: UserRecord }): JSX.Element {
  return (
    <Shell
      title="Arcadia — continuing education"
      heading="Continuing Education"
      user={props.user}
      current="education"
      lede="Courses and certifications people have completed."
      status={<Pill tone="idle">Superadmin for now</Pill>}
    >
      <p class="empty">
        The chronicle is limited to superadmin for now. It is not a score, and it is not the
        certification ledger.
      </p>
    </Shell>
  );
}

function EducationPage(props: {
  user: UserRecord;
  subjects: Subject[];
  entries: Entry[];
  notice?: string;
}): JSX.Element {
  const { user, subjects, entries, notice } = props;
  return (
    <Shell
      title="Arcadia — continuing education"
      heading="Continuing Education"
      user={user}
      current="education"
      lede="A course or a certification, the day it was completed, and who entered it. No expiry board and no ranking."
      status={<Pill tone={entries.length ? "ok" : "idle"}>{entries.length} entries</Pill>}
    >
      {notice ? <p class="banner">{notice}</p> : null}
      {subjects.length === 0 ? (
        <div class="banner warn">
          <span>
            <strong>Directory has not been synced.</strong> A subject has to be an active member user.
            Sync the directory before adding an accomplishment.
          </span>
        </div>
      ) : (
        <>
          <h2>Add an Accomplishment</h2>
          <form method="post" action="/agency/continuing-education">
            <p>
              <select name="subject">
                {subjects.map((subject) => (
                  <option value={subject.aad_id}>{subject.display_name ?? subject.mail ?? subject.aad_id}</option>
                ))}
              </select>{" "}
              <select name="kind">
                <option value="course">Course</option>
                <option value="certification">Certification</option>
              </select>{" "}
              <input type="text" name="title" placeholder="title" required />{" "}
              <input type="date" name="completedOn" required />
            </p>
            <p>
              <input type="text" name="provider" placeholder="provider (optional)" />{" "}
              <input type="text" name="note" placeholder="note (optional)" size={40} />{" "}
              <button type="submit" class="primary">
                Add an Accomplishment
              </button>
            </p>
          </form>
        </>
      )}
      <h2>Chronicle</h2>
      {entries.length === 0 ? (
        <p class="empty">No accomplishments yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Type</th>
              <th>Title</th>
              <th>Completed</th>
              <th>Provider</th>
              <th>Entered by</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr>
                <td>{entry.display_name ?? entry.subject_email ?? "—"}</td>
                <td>{entry.kind === "certification" ? "Certification" : "Course"}</td>
                <td>
                  {entry.title}
                  {entry.note ? (
                    <>
                      <br />
                      <small class="muted">{entry.note}</small>
                    </>
                  ) : null}
                </td>
                <td>{entry.completed_on}</td>
                <td>{entry.provider ?? "—"}</td>
                <td>
                  <small class="muted">
                    {entry.added_by} · {entry.added_at}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}

export async function handleEducationRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/agency/continuing-education") return undefined;

  // Temporary audience (27 September 2026): superadmin only.
  if (!canReadContinuingEducation(user)) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    return html(<ClosedPage user={user} />);
  }

  const subjects = (
    await env.DB.prepare(
      `SELECT aad_id, mail, display_name FROM directory_profiles
        WHERE account_enabled = 1 AND user_type = 'Member' ORDER BY display_name, mail`
    ).all<Subject>()
  ).results;
  const entries = (
    await env.DB.prepare(
      `SELECT e.id, e.subject_email, p.display_name, e.kind, e.title, e.completed_on, e.provider, e.note, e.added_by, e.added_at
         FROM continuing_education e
         LEFT JOIN directory_profiles p ON p.aad_id = e.subject_aad_id
        ORDER BY e.completed_on DESC, e.added_at DESC`
    ).all<Entry>()
  ).results;

  if (request.method === "GET") {
    return html(<EducationPage user={user} subjects={subjects} entries={entries} />);
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const form = await request.formData();
  const subjectId = String(form.get("subject") ?? "");
  const subject = subjects.find((row) => row.aad_id === subjectId);
  const allowed = canAddContinuingEducation(user, { activeMember: Boolean(subject) });
  if (!allowed.ok) return new Response(allowed.reason, { status: 403 });
  const parsed = validateEducationInput({
    kind: String(form.get("kind") ?? ""),
    title: String(form.get("title") ?? ""),
    completedOn: String(form.get("completedOn") ?? ""),
  });
  if (!parsed.ok) return new Response(parsed.reason, { status: 400 });
  const provider = String(form.get("provider") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  await env.DB.prepare(
    `INSERT INTO continuing_education
       (id, subject_aad_id, subject_email, kind, title, completed_on, provider, note, added_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(
      crypto.randomUUID(),
      subjectId,
      subject?.mail ?? null,
      parsed.kind,
      parsed.title,
      parsed.completedOn,
      provider || null,
      note || null,
      user.email
    )
    .run();
  await appendAudit(env.DB, {
    actor: user.email,
    action: "continuing_education_added",
    subject: subject?.mail ?? subjectId,
    detail: `${parsed.kind}: ${parsed.title} (${parsed.completedOn}), entered by ${user.email}`,
  });
  const fresh = (
    await env.DB.prepare(
      `SELECT e.id, e.subject_email, p.display_name, e.kind, e.title, e.completed_on, e.provider, e.note, e.added_by, e.added_at
         FROM continuing_education e
         LEFT JOIN directory_profiles p ON p.aad_id = e.subject_aad_id
        ORDER BY e.completed_on DESC, e.added_at DESC`
    ).all<Entry>()
  ).results;
  return html(<EducationPage user={user} subjects={subjects} entries={fresh} notice="Entry added." />);
}
