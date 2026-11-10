// The navigation model and the rail that renders it.
//
// Structure follows ChartRoom's sidebar: a logo lockup, grouped sections with
// an uppercase eyebrow label and icon items, and the signed-in person at the
// foot with the administrative actions behind them. One active-state
// treatment, defined once in theme.ts and reused — a second one for tabs or
// sub-nav is how a surface starts looking like two apps.
//
// A page that does not exist yet has no item: no placeholders. The Ask
// Arcadia CTA returns with Phase 6.
//
// The Admin link is capability-gated here as a courtesy only. Every route
// re-checks server-side (src/lib/rbac.ts); hiding a link is not authorization.

import type { JSX } from "preact";
import {
  ArcadiaMark,
  CalendarClock,
  ChevronUp,
  GraduationCap,
  LogOut,
  Users,
  ShieldCheck,
  type IconComponent,
} from "./icons";
import { can, type UserRecord } from "../lib/rbac";

export type NavKey = "directory" | "schedule" | "education" | "admin";

export interface NavItem {
  to: string;
  label: string;
  key: NavKey;
  icon: IconComponent;
}

export interface NavSection {
  group: string;
  items: NavItem[];
}

/**
 * Every active staff member sees the same rail: each page here is open to
 * every active session. Clients (/clients) stays out of the nav until the
 * Phase 4 CRM; Settings arrives in Phase 2.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    group: "Agency",
    items: [
      { to: "/agency/directory", label: "Directory", key: "directory", icon: Users },
      { to: "/agency/schedule", label: "Schedule", key: "schedule", icon: CalendarClock },
      { to: "/agency/education", label: "Continuing Education", key: "education", icon: GraduationCap },
    ],
  },
];

/** Labels the rail shows to this person. Empty for a deactivated account. */
export function navLabelsFor(user: UserRecord): string[] {
  if (!user.active) return [];
  return NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.label));
}

/** True when the user menu carries the Admin link (model routing, roles). */
export function canSeeAdmin(user: UserRecord): boolean {
  return can(user, "admin_models") || can(user, "admin_users");
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
        {canSeeAdmin(user) ? (
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

/** The rail: brand, grouped nav, signed-in person. */
export function Sidebar(props: { user: UserRecord; current?: NavKey }): JSX.Element {
  const { user, current } = props;
  return (
    <aside class="sidebar">
      <a class="brand" href="/agency/directory">
        <ArcadiaMark size={30} />
        <span>
          <span class="word">Arcadia</span>
          <span class="sub">S-FX STAFF HUB</span>
        </span>
      </a>

      <nav class="sidebar-nav">
        {NAV_SECTIONS.map((section) => {
          const items = user.active ? section.items : [];
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
