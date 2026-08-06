// Client Project Context Gatekeeper (Cloudflare OS integration plan,
// workstream A). The mandated path for project and person memory — code that
// wants `sfx-project-{id}` or `sfx-person-{id}` goes through a session from
// this module, never through the memory driver directly.
//
// Isolation is by construction, not by check: a session's profile name is
// fixed at mint from the single id it was opened for, so one client's session
// cannot address another client's profile — and no session minted here can
// address doctrine at all. Canonical stays promotion-only through the
// ratification workflow (§5.6.1); this module has no path to it.
//
// Person profiles are the sensitive layer (§5.7): the person themselves,
// their lead, and the founder roles — enforced here at mint, on top of the
// query-level checks the dashboard already does.

import type { ListFilter, Memory, Profile, RecallOpts, RecallResult } from "../memory/driver";
import { personProfile, projectProfile } from "../memory/driver";
import { canViewPersonRecord, type UserRecord } from "../lib/rbac";
import { D1GatekeeperQueue } from "./log";
import {
  GatekeeperDeniedError,
  type ActionKind,
  type ArcadiaActionQueue,
  type GatekeeperContext,
} from "./types";

export const CONTEXT_ACTION_KINDS = {
  /** Project profiles auto-commit facts (§5.2) — never client-visible. */
  rememberFact: { tag: "memory.remember_fact", label: "Record project fact" },
} satisfies Record<string, ActionKind>;

/**
 * The memory driver reaches Durable Objects through the agents SDK, which
 * only loads inside the Workers runtime. Importing it lazily keeps this
 * module's policy code loadable (and unit-testable) anywhere; wrangler still
 * bundles the target statically.
 */
async function memoryProfile(env: Env, name: string): Promise<Profile> {
  const { SelfHostedMemoryDriver } = await import("../memory/self-hosted");
  return new SelfHostedMemoryDriver(env).getProfile(name);
}

/** Conservative id shape so a mangled id cannot smuggle a surprising DO name. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,120}$/;

function assertSafeId(id: string, what: string): void {
  if (!SAFE_ID.test(id)) {
    throw new GatekeeperDeniedError(`${what} "${id}" is not a valid id`, "project-context");
  }
}

// ---------------------------------------------------------------------------
// Project session — recall/list plus the auto-commit fact write.
// ---------------------------------------------------------------------------

export interface ProjectContextSession {
  readonly profileName: string;
  /** Recall from this project's profile only. Observation. */
  recall(query: string, opts?: RecallOpts): Promise<RecallResult>;
  /** List this project's memories. Observation. */
  list(filter?: ListFilter): Promise<Memory[]>;
  /**
   * Record a fact on this project. Auto-applies (§5.2 write policy: project
   * profiles auto-commit facts) but is still submitted and logged like every
   * side effect. There is no forget here — supersession, never deletion.
   */
  rememberFact(content: string, source?: string): Promise<Memory>;
}

export interface ProjectContextPorts {
  queue: ArcadiaActionQueue;
  profile: Pick<Profile, "recall" | "list" | "remember">;
}

export function projectContextFromPorts(
  profileName: string,
  ports: ProjectContextPorts
): ProjectContextSession {
  return {
    profileName,

    async recall(query, opts) {
      const result = await ports.profile.recall(query, opts);
      await ports.queue.authorizeObservation({
        title: `Recalled from ${profileName}`,
        description: `"${query.slice(0, 120)}" → ${result.memories.length} memories${result.belowConfidenceFloor ? " (below confidence floor)" : ""}`,
      });
      return result;
    },

    async list(filter) {
      const memories = await ports.profile.list(filter);
      await ports.queue.authorizeObservation({
        title: `Listed ${profileName}`,
        description: `${memories.length} memories${filter?.kind ? ` (kind ${filter.kind})` : ""}`,
      });
      return memories;
    },

    async rememberFact(content, source) {
      const digest = content.slice(0, 40).replace(/\s+/g, " ");
      const actionKey = `${CONTEXT_ACTION_KINDS.rememberFact.tag}:${digest}`;
      await ports.queue.submitAction(actionKey, {
        title: `Fact on ${profileName}`,
        description: content.slice(0, 500),
        implementsRevert: false, // superseded, never deleted (§5.6.3)
        autoApprovable: true,
        actionKind: CONTEXT_ACTION_KINDS.rememberFact,
      });
      try {
        await ports.queue.recordDecision(actionKey);
        const memory = await ports.profile.remember({
          content,
          ...(source ? { sessionId: source } : {}),
        });
        await ports.queue.recordApplied(actionKey, `memory ${memory.id}`);
        return memory;
      } catch (err) {
        await ports.queue.recordFailed(actionKey, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
  };
}

/** Mint a session for exactly one project. */
export async function openProjectContext(
  env: Env,
  ctx: GatekeeperContext,
  projectId: string
): Promise<ProjectContextSession> {
  assertSafeId(projectId, "project id");
  const profileName = projectProfile(projectId);
  const profile = await memoryProfile(env, profileName);
  return projectContextFromPorts(profileName, {
    queue: new D1GatekeeperQueue(env.DB, "project-context", `memory:${profileName}`, ctx),
    profile,
  });
}

// ---------------------------------------------------------------------------
// Person session — read-only (§5.2: auto-observes, never auto-acts).
// ---------------------------------------------------------------------------

export interface PersonContextSession {
  readonly profileName: string;
  recall(query: string, opts?: RecallOpts): Promise<RecallResult>;
  list(filter?: ListFilter): Promise<Memory[]>;
}

/**
 * Mint a read session on one person's profile. §5.7 access — the person,
 * their lead, Shane — is enforced HERE, before any capability exists at all.
 */
export async function openPersonContext(
  env: Env,
  ctx: GatekeeperContext,
  viewer: UserRecord,
  subjectEmail: string
): Promise<PersonContextSession> {
  assertSafeId(subjectEmail, "person id");
  const subject = await env.DB.prepare(`SELECT lead_email FROM users WHERE lower(email) = ?1`)
    .bind(subjectEmail.toLowerCase())
    .first<{ lead_email: string | null }>();
  if (!canViewPersonRecord(viewer, subjectEmail, subject?.lead_email ?? undefined)) {
    throw new GatekeeperDeniedError(
      `${viewer.email} may not read ${subjectEmail}'s person record (§5.7)`,
      "project-context"
    );
  }
  const profileName = personProfile(subjectEmail.toLowerCase());
  const profile = await memoryProfile(env, profileName);
  const queue = new D1GatekeeperQueue(env.DB, "project-context", `memory:${profileName}`, ctx);
  return {
    profileName,
    async recall(query, opts) {
      const result = await profile.recall(query, opts);
      await queue.authorizeObservation({
        title: `Recalled from ${profileName}`,
        description: `by ${viewer.email}: "${query.slice(0, 120)}" → ${result.memories.length} memories`,
        prohibitAllSharing: true, // person data never rides into anything shareable
      });
      return result;
    },
    async list(filter) {
      const memories = await profile.list(filter);
      await queue.authorizeObservation({
        title: `Listed ${profileName}`,
        description: `by ${viewer.email}: ${memories.length} memories`,
        prohibitAllSharing: true,
      });
      return memories;
    },
  };
}
