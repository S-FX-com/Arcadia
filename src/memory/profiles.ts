// P3 profiles — person + customer longitudinal models (EXECUTION-PLAN §Phase 3
// item 2; SOUL.md §profiles).
//
// Two kinds of profile:
//
//   Person profile   — communication style, focus areas, working patterns,
//                       relationships. Built from the subject's own episodic
//                       memories, refreshed on the every-N-messages cadence
//                       SOUL.md describes, persisted to users.profile_json.
//                       ACL: admin-or-self only (SOUL.md §privacy — profiles
//                       are never surfaced laterally between peers).
//
//   Customer profile — contacts, topics, sentiment, recent context. Built
//                       passively from customer-scoped memories + recent
//                       mentions. Stored AS a consolidated semantic memory
//                       (scope customer/<normalized-name>) so it lives in the
//                       same substrate as the raw signals it distils.
//
// Storage choice for customer profiles (documented per task): the consolidated
// profile is written as a single semantic memory row via a direct D1 upsert
// into `memories` (source_resource_type = 'customer_profile'), NOT through
// MemoryStore.add. Two reasons: (1) it is retrieved by exact scope lookup, not
// semantic search, so a Vectorize embedding of a JSON blob would add no recall
// value and only churn the index; (2) it keeps the write path simulatable under
// miniflare (which binds neither Workers AI nor Vectorize). Visibility is
// granted by writing a resource_acl tenant grant on ('customer', <name>) the
// first time the profile is created, so in-tenant staff can query customers
// they are entitled to via the normal ACL gate (customer scope is otherwise
// default-deny like every non-user/non-tenant scope).
//
// The Router is injected via a complete-fn seam so tests can feed canned JSON
// without a live provider.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import type { CompleteRequest, CompleteResponse } from "../ai/types";
import { Router } from "../ai/router";
import { injectCharter } from "../charter/inject";
import { ResourceAcl } from "../acl/resource-acl";
import { config } from "../lib/config";

/** Injectable router seam — defaults to the real tiered Router. */
export type ProfileCompleteFn = (
  req: CompleteRequest,
) => Promise<CompleteResponse>;

export interface PersonProfile {
  communicationStyle: string;
  focusAreas: string[];
  workingPatterns: string[];
  relationships: string[];
  confidence: number;
  updatedAt: string;
}

export interface CustomerProfile {
  name: string;
  contacts: string[];
  topics: string[];
  sentiment: string;
  recentContext: string;
  confidence: number;
  updatedAt: string;
}

/** Viewer identity for the person-profile ACL gate (admin-or-self only). */
export interface PersonViewer {
  aadId: string;
  isAdmin: boolean;
}

/** Viewer identity for the customer-profile ACL gate (tenant-scoped). */
export interface CustomerViewer {
  aadId: string;
  tenantId: string;
  isAdmin: boolean;
}

export interface ProfileStoreOpts {
  /** Injectable router seam. Defaults to a real Router bound to `env`. */
  complete?: ProfileCompleteFn;
  /** Minimum recent memories before a person profile is (re)built. */
  minPersonMemories?: number;
}

const PERSON_MEMORY_LOOKBACK = 30;
const CUSTOMER_MEMORY_LOOKBACK = 30;
const CUSTOMER_MENTION_LOOKBACK = 20;
const CUSTOMER_PROFILE_MARKER = "customer_profile";

export class ProfileStore {
  private readonly complete: ProfileCompleteFn;
  private readonly minPersonMemories: number;

  constructor(
    private readonly env: Env,
    opts: ProfileStoreOpts = {},
  ) {
    if (opts.complete) {
      this.complete = opts.complete;
    } else {
      const router = new Router(env);
      this.complete = (req) => router.complete(req);
    }
    this.minPersonMemories =
      opts.minPersonMemories ?? config(env).profileMinMemories;
  }

  // -------------------------------------------------------------------------
  // Person profiles
  // -------------------------------------------------------------------------

  /**
   * Rebuild the person profile for `aadId` from their recent episodic memories
   * and persist it to users.profile_json / profile_updated_at. Returns the new
   * profile, or null when there is too little evidence (< minPersonMemories).
   */
  async updatePersonProfile(
    aadId: string,
    log: Logger,
  ): Promise<PersonProfile | null> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT content, kind, occurred_at, created_at
         FROM memories
        WHERE subject_aad_id = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY COALESCE(occurred_at, created_at) DESC
        LIMIT ?`,
    )
      .bind(aadId, new Date().toISOString(), PERSON_MEMORY_LOOKBACK)
      .all<{ content: string }>();

    if (rows.results.length < this.minPersonMemories) {
      log.info("person_profile_skipped", {
        aadId,
        memories: rows.results.length,
        min: this.minPersonMemories,
      });
      return null;
    }

    const block = rows.results.map((r) => `- ${r.content}`).join("\n");
    const system = await injectCharter(
      this.env,
      "You are Arcadia building a longitudinal profile of a person from their " +
        "recent interactions. Produce nested, evidence-grounded structure — " +
        "not flat observations. Hold it lightly. Output STRICT JSON only:\n" +
        '{ "communicationStyle": "<one paragraph>", "focusAreas": ["<area>"], ' +
        '"workingPatterns": ["<pattern>"], "relationships": ["<who + how they ' +
        'work together>"], "confidence": 0.0-1.0 }\n' +
        "Base every field on the evidence. If evidence is thin, lower the " +
        "confidence. No filler, no preamble.",
    );

    const reply = await this.complete({
      system,
      messages: [
        {
          role: "user",
          content: `Recent interactions for this person:\n${block}`,
        },
      ],
      tier: "deep",
      maxTokens: 700,
      temperature: 0,
    });

    const parsed = parsePersonProfile(reply.text);
    if (!parsed) {
      log.warn("person_profile_parse_failed", { aadId });
      return null;
    }

    const profile: PersonProfile = {
      ...parsed,
      updatedAt: new Date().toISOString(),
    };

    // Upsert: ON CONFLICT touches only the profile columns, so an existing
    // row's tenant/identity/admin fields are preserved. tenant_id is only
    // consumed on a first-seen insert.
    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO users (aad_id, tenant_id, profile_json, profile_updated_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(aad_id) DO UPDATE SET
         profile_json = excluded.profile_json,
         profile_updated_at = excluded.profile_updated_at`,
    )
      .bind(
        aadId,
        this.env.GRAPH_TENANT_ID,
        JSON.stringify(profile),
        profile.updatedAt,
      )
      .run();

    log.info("person_profile_updated", {
      aadId,
      confidence: profile.confidence,
    });
    return profile;
  }

  /**
   * Read a person's profile. ACL: admin-or-self only. A non-admin, non-subject
   * viewer NEVER receives another person's profile (returns null) — SOUL.md
   * §privacy: profile data is not shared laterally between peers.
   */
  async getPersonProfile(
    aadId: string,
    viewer: PersonViewer,
  ): Promise<PersonProfile | null> {
    if (!viewer.isAdmin && viewer.aadId !== aadId) return null;

    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT profile_json FROM users WHERE aad_id = ?`,
    )
      .bind(aadId)
      .first<{ profile_json: string | null }>();

    if (!row?.profile_json) return null;
    return parseStoredPersonProfile(row.profile_json);
  }

  // -------------------------------------------------------------------------
  // Customer profiles
  // -------------------------------------------------------------------------

  /**
   * Rebuild the customer profile for `name` from customer-scoped memories plus
   * recent mentions across all scopes, and store it as a consolidated semantic
   * memory. Grants the customer scope a tenant ACL the first time so in-tenant
   * staff can query it. Returns the new profile, or null when there is no
   * material to build from.
   */
  async updateCustomerProfile(
    name: string,
    log: Logger,
  ): Promise<CustomerProfile | null> {
    const norm = normalizeCustomerName(name);
    if (!norm) return null;
    const now = new Date().toISOString();

    const scoped = await this.env.ARCADIA_DB.prepare(
      `SELECT content FROM memories
        WHERE scope_type = 'customer' AND scope_id = ?
          AND (source_resource_type IS NULL OR source_resource_type != ?)
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY COALESCE(occurred_at, created_at) DESC
        LIMIT ?`,
    )
      .bind(norm, CUSTOMER_PROFILE_MARKER, now, CUSTOMER_MEMORY_LOOKBACK)
      .all<{ content: string }>();

    const mentions = await this.env.ARCADIA_DB.prepare(
      `SELECT content FROM memories
        WHERE scope_type != 'customer'
          AND content LIKE ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY COALESCE(occurred_at, created_at) DESC
        LIMIT ?`,
    )
      .bind(`%${name.trim()}%`, now, CUSTOMER_MENTION_LOOKBACK)
      .all<{ content: string }>();

    const material = dedupeContents([
      ...scoped.results.map((r) => r.content),
      ...mentions.results.map((r) => r.content),
    ]);
    if (material.length === 0) {
      log.info("customer_profile_skipped", { customer: norm });
      return null;
    }

    const block = material.map((c) => `- ${c}`).join("\n");
    const system = await injectCharter(
      this.env,
      "You are Arcadia building passive CRM intelligence about a customer/" +
        "organisation from the work already happening. Produce nested, " +
        "evidence-grounded structure. Output STRICT JSON only:\n" +
        '{ "contacts": ["<name + role if known>"], "topics": ["<recurring ' +
        'topic>"], "sentiment": "<positive|neutral|negative|mixed + one ' +
        'clause of why>", "recentContext": "<what is happening now, 1-3 ' +
        'sentences>", "confidence": 0.0-1.0 }\n' +
        "Base every field on the evidence. No filler, no preamble.",
    );

    const reply = await this.complete({
      system,
      messages: [
        {
          role: "user",
          content: `Signals mentioning "${name.trim()}":\n${block}`,
        },
      ],
      tier: "deep",
      maxTokens: 700,
      temperature: 0,
    });

    const parsed = parseCustomerProfile(reply.text);
    if (!parsed) {
      log.warn("customer_profile_parse_failed", { customer: norm });
      return null;
    }

    const profile: CustomerProfile = {
      ...parsed,
      name: norm,
      updatedAt: now,
    };

    // Replace any prior consolidated profile row (not vector-indexed, so no
    // Vectorize cleanup is required) and write the fresh one.
    await this.env.ARCADIA_DB.prepare(
      `DELETE FROM memories
        WHERE scope_type = 'customer' AND scope_id = ?
          AND source_resource_type = ?`,
    )
      .bind(norm, CUSTOMER_PROFILE_MARKER)
      .run();

    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO memories
         (id, kind, scope_type, scope_id, content, source_resource_type,
          confidence, occurred_at, created_at, updated_at)
       VALUES (?, 'semantic', 'customer', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        norm,
        JSON.stringify(profile),
        CUSTOMER_PROFILE_MARKER,
        profile.confidence,
        now,
        now,
        now,
      )
      .run();

    // Grant tenant visibility on first creation so entitled in-tenant staff
    // can read the customer scope through the normal ACL gate.
    await new ResourceAcl(this.env).grant("customer", norm, {
      type: "tenant",
      id: this.env.GRAPH_TENANT_ID,
    });

    log.info("customer_profile_updated", {
      customer: norm,
      confidence: profile.confidence,
    });
    return profile;
  }

  /**
   * Read a customer profile through the normal ACL gate. Admins bypass; every
   * other viewer must hold a grant on the ('customer', <name>) scope (the
   * tenant grant written at creation covers in-tenant staff). Returns null when
   * the viewer is not entitled or no profile exists yet.
   */
  async getCustomerProfile(
    name: string,
    viewer: CustomerViewer,
  ): Promise<CustomerProfile | null> {
    const norm = normalizeCustomerName(name);
    if (!norm) return null;

    if (!viewer.isAdmin) {
      const allowed = await new ResourceAcl(this.env).canAccess(
        "customer",
        norm,
        { viewerAadId: viewer.aadId, tenantId: viewer.tenantId },
      );
      if (!allowed) return null;
    }

    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT content FROM memories
        WHERE scope_type = 'customer' AND scope_id = ?
          AND source_resource_type = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY COALESCE(occurred_at, created_at) DESC
        LIMIT 1`,
    )
      .bind(norm, CUSTOMER_PROFILE_MARKER, new Date().toISOString())
      .first<{ content: string }>();

    if (!row?.content) return null;
    return parseStoredCustomerProfile(row.content);
  }
}

// ===========================================================================
// Message-count cadence (SOUL.md: refresh a person profile every ~N messages)
// ===========================================================================

/**
 * Increment the per-subject message counter in KV and report whether the
 * profile is due for a refresh. When the count crosses `every`, the counter is
 * reset to 0 and `shouldRefresh` is true. Kept as a standalone, side-effect-
 * contained function so the cadence is testable without the activity handler.
 */
export async function recordMessageForProfile(
  env: Env,
  aadId: string,
  opts: { every?: number } = {},
): Promise<{ count: number; shouldRefresh: boolean }> {
  const every = opts.every ?? config(env).profileRefreshEvery;
  const key = `profile:msgcount:${aadId}`;
  const raw = await env.ARCADIA_CACHE.get(key);
  const prev = raw ? Number(raw) : 0;
  const count = (Number.isFinite(prev) ? prev : 0) + 1;

  if (every > 0 && count >= every) {
    await env.ARCADIA_CACHE.put(key, "0");
    return { count, shouldRefresh: true };
  }
  await env.ARCADIA_CACHE.put(key, String(count));
  return { count, shouldRefresh: false };
}

// ===========================================================================
// Parsing / normalization helpers
// ===========================================================================

export function normalizeCustomerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupeContents(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1));
    if (!obj || typeof obj !== "object") return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map((x) => x.trim());
}

function clampConfidence(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.max(0, Math.min(1, v))
    : 0.5;
}

/** Parse a freshly-generated person profile (no updatedAt yet). */
function parsePersonProfile(
  raw: string,
): Omit<PersonProfile, "updatedAt"> | null {
  const obj = extractJson(raw);
  if (!obj) return null;
  const communicationStyle = str(obj.communicationStyle);
  const focusAreas = strArray(obj.focusAreas);
  const workingPatterns = strArray(obj.workingPatterns);
  const relationships = strArray(obj.relationships);
  if (
    !communicationStyle &&
    focusAreas.length === 0 &&
    workingPatterns.length === 0 &&
    relationships.length === 0
  ) {
    return null;
  }
  return {
    communicationStyle,
    focusAreas,
    workingPatterns,
    relationships,
    confidence: clampConfidence(obj.confidence),
  };
}

/** Parse a freshly-generated customer profile (name/updatedAt set by caller). */
function parseCustomerProfile(
  raw: string,
): Omit<CustomerProfile, "name" | "updatedAt"> | null {
  const obj = extractJson(raw);
  if (!obj) return null;
  const contacts = strArray(obj.contacts);
  const topics = strArray(obj.topics);
  const sentiment = str(obj.sentiment);
  const recentContext = str(obj.recentContext);
  if (
    contacts.length === 0 &&
    topics.length === 0 &&
    !sentiment &&
    !recentContext
  ) {
    return null;
  }
  return {
    contacts,
    topics,
    sentiment,
    recentContext,
    confidence: clampConfidence(obj.confidence),
  };
}

function parseStoredPersonProfile(json: string): PersonProfile | null {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    return {
      communicationStyle: str(obj.communicationStyle),
      focusAreas: strArray(obj.focusAreas),
      workingPatterns: strArray(obj.workingPatterns),
      relationships: strArray(obj.relationships),
      confidence: clampConfidence(obj.confidence),
      updatedAt: str(obj.updatedAt),
    };
  } catch {
    return null;
  }
}

function parseStoredCustomerProfile(json: string): CustomerProfile | null {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    return {
      name: str(obj.name),
      contacts: strArray(obj.contacts),
      topics: strArray(obj.topics),
      sentiment: str(obj.sentiment),
      recentContext: str(obj.recentContext),
      confidence: clampConfidence(obj.confidence),
      updatedAt: str(obj.updatedAt),
    };
  } catch {
    return null;
  }
}
