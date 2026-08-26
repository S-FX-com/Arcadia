// Agency — the surfaces that are scaffolded but not built.
//
// Every one of these pages says so plainly, names what it will show, and names
// what it needs first. None of them renders a sample row, a placeholder figure
// or an example chart: an invented number reads as analysis, and a screen that
// looks populated is how a surface gets trusted before it is true.
//
// Routes and nav entries are live now so the shape of the app is settled;
// wiring each page to its source is the work that follows. Leadership
// (approval/leadership.tsx), Objectives (approval/objectives.tsx), the
// Clients workspaces (approval/clients.tsx, v5.0) and Schedule
// (approval/schedule.tsx) have had that done and live in their own modules,
// not here.

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
 * Router for the /agency* placeholders. Returns undefined for paths it does
 * not own. Read-only: these pages accept no input, so there is nothing to
 * authorize beyond the session every route already requires. /clients* is
 * owned by approval/clients.tsx since v5.0.
 */
export function handleSectionRoutes(request: Request, user: UserRecord): Response | undefined {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/agency")) return undefined;
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

  // The group root lands on the group's first page rather than 404ing.
  if (path === "/agency" || path === "/agency/") {
    return new Response(null, { status: 302, headers: { Location: "/agency/leadership" } });
  }

  const section = SECTIONS.find((s) => s.path === path);
  if (!section) return undefined;
  return html(<SectionPage user={user} section={section} />);
}
