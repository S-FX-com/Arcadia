// The navigation model and the rail that renders it.
//
// Structure follows ChartRoom's sidebar: a logo lockup, one primary CTA,
// grouped sections with an uppercase eyebrow label and icon items, and the
// signed-in person at the foot with the administrative actions behind them.
// One active-state treatment, defined once in theme.ts and reused — a second
// one for tabs or sub-nav is how a surface starts looking like two apps.
//
// Items are capability-gated here as a courtesy only. Every route re-checks
// server-side (src/lib/rbac.ts); hiding a link is not authorization.

import type { JSX } from "preact";
import {
  ArcadiaMark,
  BookOpen,
  Briefcase,
  CalendarClock,
  ChevronUp,
  Dashboard,
  GraduationCap,
  LogOut,
  Network,
  Pulse,
  ShieldCheck,
  Sparkles,
  Target,
  UserPlus,
  Workflow,
  type IconComponent,
} from "./icons";
import { can, type Capability, type UserRecord } from "../lib/rbac";

export type NavKey =
  | "chat"
  // Agency
  | "leadership"
  | "processes"
  | "objectives"
  | "schedule"
  | "education"
  // Clients
  | "clients-active"
  | "clients-onboarding"
  | "clients-health"
  // Operations — the surfaces that are already live
  | "ops"
  | "doctrine"
  | "admin";

export interface NavItem {
  to: string;
  label: string;
  key: NavKey;
  icon: IconComponent;
  /** Hidden unless the caller holds this. The route still enforces it. */
  needs?: Capability;
}

export interface NavSection {
  group: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    group: "Agency",
    items: [
      { to: "/agency/leadership", label: "Leadership", key: "leadership", icon: Network },
      { to: "/agency/processes", label: "Processes", key: "processes", icon: Workflow },
      { to: "/agency/objectives", label: "Objectives", key: "objectives", icon: Target },
      { to: "/agency/schedule", label: "Schedule", key: "schedule", icon: CalendarClock },
      {
        to: "/agency/continuing-education",
        label: "Continuing Education",
        key: "education",
        icon: GraduationCap,
      },
    ],
  },
  {
    group: "Clients",
    items: [
      { to: "/clients/active", label: "Active Clients", key: "clients-active", icon: Briefcase },
      { to: "/clients/onboarding", label: "Client Onboarding", key: "clients-onboarding", icon: UserPlus },
      { to: "/clients/health", label: "Client Health", key: "clients-health", icon: Pulse },
    ],
  },
  {
    // Everything Arcadia already does. Kept in the rail rather than buried:
    // the approval queue, the accountability board and the certification
    // ledger are the working parts of the instrument.
    group: "Operations",
    items: [
      { to: "/approval/ops", label: "Operations", key: "ops", icon: Dashboard },
      { to: "/approval/doctrine", label: "Doctrine", key: "doctrine", icon: BookOpen, needs: "ratify_doctrine" },
    ],
  },
];

function visibleItems(section: NavSection, user: UserRecord): NavItem[] {
  return section.items.filter((item) => !item.needs || can(user, item.needs));
}

/** Two letters for the avatar: initials where there is a name, else the local part. */
export function initials(user: UserRecord): string {
  const source = user.displayName?.trim() || user.email.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : source.slice(0, 2);
  return letters.toUpperCase() || "··";
}

/**
 * The person, and what they can administer. ChartRoom keeps tenancy actions
 * here rather than in the nav for the same reason Arcadia should: a superadmin
 * opening the app wants Arcadia, not model routing.
 *
 * A <details> disclosure, so the menu opens with no client JS.
 */
function UserChip(props: { user: UserRecord }): JSX.Element {
  const { user } = props;
  const canAdmin = can(user, "admin_models") || can(user, "admin_users");
  return (
    <details class="usermenu">
      <summary>
        <span class="avatar">{initials(user)}</span>
        <span class="idn">
          <b>{user.displayName ?? user.email}</b>
          <span>
            {user.role}
            {user.leadEmail ? ` · lead ${user.leadEmail}` : ""}
          </span>
        </span>
        <ChevronUp size={15} />
      </summary>
      <div class="menu">
        {canAdmin ? (
          <a href="/approval/admin">
            <ShieldCheck size={15} /> Admin
          </a>
        ) : null}
        <a class="out" href="/auth/logout">
          <LogOut size={15} /> Sign out
        </a>
      </div>
    </details>
  );
}

/** The rail: brand, Ask Arcadia, grouped nav, signed-in person. */
export function Sidebar(props: { user: UserRecord; current?: NavKey }): JSX.Element {
  const { user, current } = props;
  return (
    <aside class="sidebar">
      <a class="brand" href="/">
        <ArcadiaMark size={30} />
        <span>
          <span class="word">Arcadia</span>
          <span class="sub">S-FX OPERATIONS</span>
        </span>
      </a>

      <a class={current === "chat" ? "cta active" : "cta"} href="/">
        <Sparkles size={17} /> Ask Arcadia
      </a>

      <nav class="sidebar-nav">
        {NAV_SECTIONS.map((section) => {
          const items = visibleItems(section, user);
          if (items.length === 0) return null;
          return (
            <div class="navgroup">
              <p class="navgroup-label">{section.group}</p>
              <ul>
                {items.map((item) => (
                  <li>
                    <a
                      class={current === item.key ? "navitem active" : "navitem"}
                      href={item.to}
                      {...(current === item.key ? { "aria-current": "page" } : {})}
                    >
                      <item.icon size={17} />
                      <span>{item.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      <div class="sidebar-foot">
        <UserChip user={user} />
      </div>
    </aside>
  );
}
