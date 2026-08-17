// Agency and Clients — the surfaces that are scaffolded but not built.
//
// Every one of these pages says so plainly, names what it will show, and names
// what it needs first. None of them renders a sample row, a placeholder figure
// or an example chart: an invented number reads as analysis, and a screen that
// looks populated is how a surface gets trusted before it is true.
//
// Routes and nav entries are live now so the shape of the app is settled;
// wiring each page to its source is the work that follows.

import type { JSX } from "preact";
import { html, Pill, Shell } from "./shell";
import type { NavKey } from "./nav";
import { Hammer } from "./icons";
import type { UserRecord } from "../lib/rbac";

type PillTone = "ok" | "warn" | "danger" | "idle";

interface Planned {
  label: string;
  detail: string;
}

interface SectionDef {
  path: string;
  key: NavKey;
  heading: string;
  lede: string;
  /** Top-right pill. States the real position — never a fabricated freshness. */
  status: { tone: PillTone; text: string };
  purpose: string;
  renders: Planned[];
  /** What has to exist before the page can carry data. */
  blocked: string;
}

export const SECTIONS: SectionDef[] = [
  {
    path: "/agency/leadership",
    key: "leadership",
    heading: "Leadership",
    lede: "Reporting lines for the department: who owns the work, who signs for it, and whose name a day-7 stall lands under.",
    status: { tone: "idle", text: "Not built" },
    purpose:
      "An organizational chart of the department, drawn from the reporting line each staff record already carries — not a second copy of it kept by hand.",
    renders: [
      { label: "The chart", detail: "Every specialist under their lead, every lead under the founder." },
      {
        label: "Escalation target",
        detail:
          "The lead a day-7 stall is filed under. Same edge Radar uses, so the chart and the escalation ladder cannot disagree.",
      },
      {
        label: "Coverage gaps",
        detail: "Anyone with no lead recorded. Their stalls have nowhere to escalate, which is worth seeing.",
      },
    ],
    blocked:
      "Nothing new. The reporting edges live on the staff records and are set in Admin; Entra's manager chain fills the rest once Graph is consented.",
  },
  {
    path: "/agency/processes",
    key: "processes",
    heading: "Processes",
    lede: "The stages work moves through, the checklist each stage signs, and the SLA that escalates when it does not.",
    status: { tone: "idle", text: "Not built" },
    purpose:
      "A readable map of the review chain that is already encoded — Development → QA (Allie) → Tech Review (Diego) → Pre-Launch (Shane) — with each stage's checklist and SLA attached.",
    renders: [
      {
        label: "The chain, in order",
        detail: "Stages cannot be skipped. Each names its reviewer and the hours it has before the SLA breaches.",
      },
      {
        label: "What each stage signs",
        detail:
          "The launch checklists — web build, SEO deliverable, social post, IT ticket close, client-facing document — and which items Arcadia verifies independently.",
      },
      {
        label: "Pass-through flags",
        detail:
          "A stage that approves faster than a real review takes, or approves work that fails downstream, is named here.",
      },
    ],
    blocked: "Nothing new. The chain, its SLAs and the checklists are already defined in code; this page reads them.",
  },
  {
    path: "/agency/objectives",
    key: "objectives",
    heading: "Objectives",
    lede: "Microsoft Planner is the system of record for task state. This page reads it, and writes back to it.",
    status: { tone: "warn", text: "Planner · not connected" },
    purpose:
      "Plans, buckets and tasks per registered project, with the ability to write a task's state back to Planner rather than keeping a second list here.",
    renders: [
      {
        label: "Read",
        detail: "Plans and tasks for each project. Planner task transitions are already one of Radar's stall signals.",
      },
      { label: "Write back", detail: "Status, assignee and due date, applied to the plan the project points at." },
      {
        label: "A write is an action, not a side effect",
        detail:
          "It goes through the Graph gatekeeper, needs a dispatch rule naming a human, and is logged either way. A pending or failed action row is the guardrail firing, not a fault.",
      },
    ],
    blocked:
      "Application-scoped Graph permission Tasks.ReadWrite.All on the existing Entra registration, plus each project's plan id in its sources. The credentials are in place; the consent grant is not.",
  },
  {
    path: "/agency/schedule",
    key: "schedule",
    heading: "Schedule",
    lede: "The department's working hours in one calendar, with shift changes and time off filed from here.",
    status: { tone: "warn", text: "Shifts · not connected" },
    purpose:
      "A calendar of who is working when, read from Microsoft Shifts, with schedule changes and time-off requests filed back to it.",
    renders: [
      { label: "Calendar display", detail: "Shifts per person and per pod, on a week and a month view." },
      { label: "Set a work schedule", detail: "Assign or change a shift against the team's Shifts schedule." },
      {
        label: "Request time off",
        detail:
          "Filed as a request, and it stays one. Arcadia files it; a human approves it. She may flag and escalate — she does not decide.",
      },
      {
        label: "Why Radar wants this",
        detail: "A project that went quiet while its owner was off is not a stall. Schedule is the fact that tells those two apart.",
      },
    ],
    blocked:
      "Graph permissions Arcadia does not currently hold: Schedule.Read.All and Schedule.ReadWrite.All, plus Group.Read.All for team membership. That is a new consent grant, not a re-use of the existing one.",
  },
  {
    path: "/agency/continuing-education",
    key: "education",
    heading: "Continuing Education",
    lede: "What each specialist is certified in, what expires when, and what the department still owes.",
    status: { tone: "warn", text: "No source of record" },
    purpose:
      "Certifications and required training per person, with expiry dates and an overdue list that carries names rather than a completion percentage.",
    renders: [
      { label: "Per person", detail: "Certifications held, issue and expiry dates, and anything past due." },
      {
        label: "Per requirement",
        detail: "Who still owes a required course — named, and visible to their lead.",
      },
      {
        label: "Read access follows the person rule",
        detail:
          "A person's record is visible to that person, their lead, and Shane. Nobody else, enforced in the query rather than by hiding the link.",
      },
    ],
    blocked:
      "A system of record. There is not one today — certificates sit in inboxes and folders. Until one is named (a Credly or Learn export, a SharePoint list, or a table Arcadia owns), this page has nothing true to show.",
  },
  {
    path: "/clients/active",
    key: "clients-active",
    heading: "Active Clients",
    lede: "One row per engagement, grouped by client, with the last ground-truth signal on each.",
    status: { tone: "idle", text: "Not built" },
    purpose:
      "The projects Radar already watches, grouped by the client they belong to, with owner, lead and pod on every row.",
    renders: [
      { label: "Grouped by client", detail: "Every active engagement, with the named owner and their lead." },
      {
        label: "Last real signal",
        detail:
          "File change, Planner transition, channel velocity, commit, staging diff. Never self-reported status — that is the mechanism that already failed.",
      },
      { label: "Stalls in context", detail: "Which of a client's projects are on the escalation ladder, and at which rung." },
    ],
    blocked:
      "Projects registered with their client and their sources. The table and the signals exist; the client column is only as good as what has been registered against it.",
  },
  {
    path: "/clients/onboarding",
    key: "clients-onboarding",
    heading: "Client Onboarding",
    lede: "The steps a new engagement moves through, who owns each one, and what is outstanding.",
    status: { tone: "idle", text: "Not built" },
    purpose:
      "An intake track per new client — each step with a named owner, a due date, and a state that came from something other than someone saying it was done.",
    renders: [
      { label: "The steps", detail: "Each with a named owner and a due date." },
      { label: "What is outstanding", detail: "Named, with the number of days it has sat there." },
      {
        label: "Signed, not assumed",
        detail:
          "Steps that gate delivery end in a signed certification, so “onboarding complete” carries a name and a timestamp.",
      },
    ],
    blocked:
      "An onboarding checklist that matches how S-FX actually starts an engagement. The certification ledger can carry it the day those steps are written down.",
  },
  {
    path: "/clients/health",
    key: "clients-health",
    heading: "Client Health",
    lede: "Per client: the signals that predict trouble, before the client is the one who raises it.",
    status: { tone: "idle", text: "Not built" },
    purpose:
      "Open stalls and their age, false certifications on that client's work, review-stage breaches, and time since the last delivery — per engagement.",
    renders: [
      {
        label: "The signals",
        detail: "Stall count and age, false-certification events, stage SLA breaches, days since last delivery.",
      },
      {
        label: "Inputs stay visible",
        detail:
          "If a score ever appears here, every number behind it is on the same screen. A composite that cannot be taken apart is not evidence.",
      },
      {
        label: "No figure without data",
        detail:
          "A client with nothing recorded shows nothing — not a zero, not a placeholder. An invented number reads as analysis and is worse than a blank.",
      },
    ],
    blocked:
      "Nothing new for the raw signals: stalls, false certifications and stage breaches are already recorded per project. What is missing is a delivery date per engagement to measure the last one against.",
  },
];

function SectionPage(props: { user: UserRecord; section: SectionDef }): JSX.Element {
  const { user, section } = props;
  return (
    <Shell
      title={`Arcadia — ${section.heading.toLowerCase()}`}
      heading={section.heading}
      user={user}
      current={section.key}
      lede={section.lede}
      status={<Pill tone={section.status.tone}>{section.status.text}</Pill>}
    >
      <section class="card planned">
        <span class="glyph">
          <Hammer size={20} />
        </span>
        <div>
          <h3>
            Not built yet <span class="badge">Placeholder</span>
          </h3>
          <p>{section.purpose}</p>
          <p>
            <small class="muted">
              Nothing on this page reads live data. It shows what the surface will carry, not a preview of it.
            </small>
          </p>
        </div>
      </section>

      <h2>What this page will show</h2>
      <div class="cardgrid">
        {section.renders.map((r) => (
          <section class="card feature">
            <h3>{r.label}</h3>
            <p>{r.detail}</p>
          </section>
        ))}
      </div>

      <h2>Before it can carry data</h2>
      <section class="card">
        <p class="lede">{section.blocked}</p>
      </section>

      <p class="jump">
        <a href="/">Ask Arcadia</a>
        <a href="/approval/ops">Operations</a>
      </p>
    </Shell>
  );
}

/**
 * Router for /agency* and /clients*. Returns undefined for paths it does not
 * own. Read-only: these pages accept no input, so there is nothing to
 * authorize beyond the session every route already requires.
 */
export function handleSectionRoutes(request: Request, user: UserRecord): Response | undefined {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/agency") && !path.startsWith("/clients")) return undefined;
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

  // Group roots land on the group's first page rather than 404ing.
  if (path === "/agency" || path === "/agency/") {
    return new Response(null, { status: 302, headers: { Location: "/agency/leadership" } });
  }
  if (path === "/clients" || path === "/clients/") {
    return new Response(null, { status: 302, headers: { Location: "/clients/active" } });
  }

  const section = SECTIONS.find((s) => s.path === path);
  if (!section) return undefined;
  return html(<SectionPage user={user} section={section} />);
}
