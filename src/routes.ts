// Staff-facing routing, after sign-in. src/index.ts has already verified the
// session and re-checked that the account is active; this module decides
// what the path answers. It must not import the agents SDK or anything that
// pulls in cloudflare:workers, so test/routes.test.ts can load it under
// vitest and assert that deleted v5 routes stay gone.
//
// What answers:
//   /                                   302 → /agency/directory
//   /agency/directory*                  Directory (approval/directory.tsx)
//   /agency/schedule*                   Schedule and shift patterns (approval/schedule.tsx)
//   /agency/education                   Continuing Education (approval/education.tsx)
//   /clients*                           manage_clients holders only; 404 for everyone else
//   /approval/admin*                    model routing and roles until Phase 2 moves them to Settings
//   /agency/continuing-education (GET)  301 → /agency/education (the v5 URL)
// Everything else is 404, including every v5 route (chat, operations,
// doctrine, board, ledger, site plans, leadership, objectives, processes,
// run-sheet, gatekeepers, /init, /agents/*).

import { handleAdminRoutes } from "./approval/admin";
import { handleClientRoutes } from "./approval/clients";
import { handleDirectoryRoutes } from "./approval/directory";
import { handleEducationRoutes } from "./approval/education";
import { handleScheduleRoutes } from "./approval/schedule";
import type { Identity, UserRecord } from "./lib/rbac";

/** Where "/" lands until Ask Arcadia ships (Phase 6). */
export const HOME_PATH = "/agency/directory";

/**
 * Pages whose v5 URL moved. Keeps a sub-path's tail and the query.
 * v5 served Directory and Schedule at /agency/* already; only Continuing
 * Education moved.
 */
const MOVED: ReadonlyArray<readonly [from: string, to: string]> = [
  ["/agency/continuing-education", "/agency/education"],
];

const notFound = (): Response => new Response("Not found", { status: 404 });

function redirect(location: string, status: 301 | 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

/** The new location of a moved page, or null. Bookmarks are GETs, so only a GET (or HEAD) moves. */
export function movedLocation(url: URL, method: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  for (const [from, to] of MOVED) {
    if (url.pathname === from || url.pathname.startsWith(`${from}/`)) {
      return `${to}${url.pathname.slice(from.length)}${url.search}`;
    }
  }
  return null;
}

/** Answer a signed-in, active staff member's request. Never returns undefined: unknown paths are 404. */
export async function dispatch(request: Request, env: Env, user: UserRecord, identity: Identity): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/") {
    return request.method === "GET" || request.method === "HEAD" ? redirect(HOME_PATH, 302) : notFound();
  }

  const moved = movedLocation(url, request.method);
  if (moved) return redirect(moved, 301);

  // Every active session reads Directory and Continuing Education; writes
  // re-check capabilities inside each handler.
  const directory = await handleDirectoryRoutes(request, env, user);
  if (directory) return directory;

  const schedule = await handleScheduleRoutes(request, env, user, identity);
  if (schedule) return schedule;

  const education = await handleEducationRoutes(request, env, user);
  if (education) return education;

  // Not in the nav. Without manage_clients every /clients* path is a 404.
  const clients = await handleClientRoutes(request, env, user);
  if (clients) return clients;

  const admin = await handleAdminRoutes(request, env, user);
  if (admin) return admin;

  return notFound();
}
