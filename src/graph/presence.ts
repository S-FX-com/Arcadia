// Microsoft Graph presence — app-only lookups for the nudge engine.
//
// EXECUTION-PLAN.md Phase 3 item 4: "the nudge engine checks presence
// before pinging, as v2 always promised." Presence.Read.All is an
// app-only permission that may not be consented in every tenant, so every
// lookup here is fail-open: a missing/forbidden presence answer is treated
// as "reachable" rather than used to suppress a nudge. Never let a Graph
// permission gap silence the nudge engine.
//
// Batch lookups go through /communications/getPresencesByUserId (max 650
// ids per call per Graph limits — chunked transparently). Single lookups go
// through /users/{id}/presence and exist mainly for completeness / ad-hoc
// use; the nudge engine only calls the batch form.

import type { Env } from "../env";
import { graph, GraphError, type GraphRequest } from "./client";

const MAX_BATCH = 650;

export interface Presence {
  availability: string;
  activity: string;
}

const UNKNOWN_PRESENCE: Presence = {
  availability: "Unknown",
  activity: "Unknown",
};

// ---------------------------------------------------------------------------
// Injectable Graph seam (mirrors RegistryDeps in ./registry)
// ---------------------------------------------------------------------------

export interface PresenceDeps {
  graph: <T = unknown>(env: Env, req: GraphRequest) => Promise<T>;
}

const defaultDeps: PresenceDeps = { graph };

interface GraphPresence {
  id?: string;
  availability?: string;
  activity?: string;
}

/**
 * Fetch a single user's presence. On 403/404 (Presence.Read.All not
 * consented, or the user has no presence answer) returns a synthetic
 * "Unknown" presence rather than throwing — `isReachable` treats Unknown
 * as reachable, so callers never need a try/catch to stay fail-open.
 */
export async function getPresence(
  env: Env,
  aadId: string,
  deps: PresenceDeps = defaultDeps,
): Promise<Presence> {
  try {
    const res = await deps.graph<GraphPresence>(env, {
      path: `/users/${aadId}/presence`,
      query: { $select: "availability,activity" },
    });
    return {
      availability: res.availability ?? "Unknown",
      activity: res.activity ?? "Unknown",
    };
  } catch (e) {
    if (e instanceof GraphError && (e.status === 403 || e.status === 404)) {
      return UNKNOWN_PRESENCE;
    }
    throw e;
  }
}

/**
 * Batch presence lookup via /communications/getPresencesByUserId, chunked
 * to the API's 650-id-per-call limit. Returns a map keyed by aadId; ids
 * Graph doesn't answer for (unknown user, no presence) are simply absent
 * from the map — callers pass the missing entry to `isReachable` as
 * `undefined`, which is reachable by definition.
 *
 * On 403/404 (Presence.Read.All not consented in this tenant) the whole
 * call fails open: an empty map is returned so every candidate is treated
 * as reachable rather than aborting the nudge cycle.
 */
export async function getPresenceBatch(
  env: Env,
  aadIds: string[],
  deps: PresenceDeps = defaultDeps,
): Promise<Map<string, Presence>> {
  const result = new Map<string, Presence>();
  const unique = Array.from(new Set(aadIds));
  if (unique.length === 0) return result;

  for (const ids of chunkIds(unique, MAX_BATCH)) {
    let value: GraphPresence[];
    try {
      const res = await deps.graph<{ value?: GraphPresence[] }>(env, {
        method: "POST",
        path: "/communications/getPresencesByUserId",
        body: { ids },
      });
      value = res.value ?? [];
    } catch (e) {
      if (e instanceof GraphError && (e.status === 403 || e.status === 404)) {
        // Fail open for the entire lookup, not just this chunk — a missing
        // consent grant applies tenant-wide, so partial results from
        // earlier chunks would be misleading (some owners "known reachable",
        // others silently unresolved). Every candidate stays reachable.
        return new Map();
      }
      throw e;
    }
    for (const item of value) {
      if (!item.id) continue;
      result.set(item.id, {
        availability: item.availability ?? "Unknown",
        activity: item.activity ?? "Unknown",
      });
    }
  }

  return result;
}

function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

const UNREACHABLE_AVAILABILITY = new Set([
  "Busy",
  "DoNotDisturb",
  "InAMeeting",
  "Presenting",
]);

const UNREACHABLE_ACTIVITY = new Set([
  "InAConferenceCall",
  "Presenting",
  "InACall",
  "InAMeeting",
]);

/**
 * Whether a nudge should be sent given `p`. Unknown/undefined presence is
 * reachable by design — presence is a courtesy signal to delay a nudge,
 * never a reason to suppress one outright.
 */
export function isReachable(p: Presence | undefined): boolean {
  if (!p) return true;
  if (UNREACHABLE_AVAILABILITY.has(p.availability)) return false;
  if (UNREACHABLE_ACTIVITY.has(p.activity)) return false;
  return true;
}
