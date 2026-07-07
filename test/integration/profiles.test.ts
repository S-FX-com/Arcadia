import { env, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import type { CompleteRequest, CompleteResponse } from "../../src/ai/types";
import {
  ProfileStore,
  recordMessageForProfile,
  type ProfileCompleteFn,
} from "../../src/memory/profiles";
import { tools } from "../../src/mcp/tools";
import { logger } from "../../src/lib/logger";

// P3 profiles (EXECUTION-PLAN §Phase 3 item 2). The Router is not simulatable
// under miniflare, so ProfileStore takes an injectable complete-fn seam; we
// feed canned JSON and run everything else (D1 persistence + ACL) against the
// real migrated bindings.

const testEnv = env as unknown as Env;
const log = logger();

const PERSON_JSON = JSON.stringify({
  communicationStyle: "Direct and concise; leads with the ask.",
  focusAreas: ["infrastructure", "hiring"],
  workingPatterns: ["heads-down in the mornings", "async-first"],
  relationships: ["works closely with Dana on platform"],
  confidence: 0.82,
});

const CUSTOMER_JSON = JSON.stringify({
  contacts: ["Jane (procurement)"],
  topics: ["renewal", "pricing"],
  sentiment: "positive — happy with recent delivery",
  recentContext: "Q3 renewal under active discussion.",
  confidence: 0.77,
});

// Branch on the prompt so one fake serves both profile kinds.
const fakeComplete: ProfileCompleteFn = async (
  req: CompleteRequest,
): Promise<CompleteResponse> => {
  const userText = req.messages.map((m) => m.content).join(" ");
  const text = userText.includes("Signals mentioning")
    ? CUSTOMER_JSON
    : PERSON_JSON;
  return { text, model: "fake", tier: "deep" };
};

function makeStore(minPersonMemories = 5): ProfileStore {
  return new ProfileStore(testEnv, { complete: fakeComplete, minPersonMemories });
}

let seq = 0;
async function insertMemory(opts: {
  kind: string;
  scopeType: string;
  scopeId: string;
  content: string;
  subjectAadId?: string;
  sourceResourceType?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO memories
       (id, kind, scope_type, scope_id, subject_aad_id, content,
        source_resource_type, confidence, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?, ?)`,
  )
    .bind(
      `mem-profile-${seq++}`,
      opts.kind,
      opts.scopeType,
      opts.scopeId,
      opts.subjectAadId ?? null,
      opts.content,
      opts.sourceResourceType ?? null,
      now,
      now,
      now,
    )
    .run();
}

beforeAll(async () => {
  // Person-1: enough evidence to build a profile.
  for (let i = 0; i < 6; i++) {
    await insertMemory({
      kind: "episodic",
      scopeType: "channel",
      scopeId: "chan-profiles",
      subjectAadId: "person-1",
      content: `person-1 said something #${i} about infra and hiring`,
    });
  }
  // Person-thin: below the evidence floor.
  for (let i = 0; i < 2; i++) {
    await insertMemory({
      kind: "episodic",
      scopeType: "channel",
      scopeId: "chan-profiles",
      subjectAadId: "person-thin",
      content: `person-thin note #${i}`,
    });
  }
  // Customer signals: customer-scoped memories + a cross-scope mention.
  await insertMemory({
    kind: "semantic",
    scopeType: "customer",
    scopeId: "gnc",
    content: "GNC primary contact is Jane in procurement.",
  });
  await insertMemory({
    kind: "observation",
    scopeType: "customer",
    scopeId: "gnc",
    content: "GNC renewal conversation is ongoing.",
  });
  await insertMemory({
    kind: "episodic",
    scopeType: "channel",
    scopeId: "chan-profiles",
    content: "Thread about GNC pricing for the Q3 renewal.",
  });
});

describe("person profiles", () => {
  it("builds, persists to users.profile_json, and enforces admin-or-self ACL", async () => {
    const store = makeStore(5);
    const built = await store.updatePersonProfile("person-1", log);
    expect(built).not.toBeNull();
    expect(built?.communicationStyle).toContain("Direct");
    expect(built?.focusAreas).toContain("hiring");

    // Persisted to the users row.
    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT profile_json, profile_updated_at FROM users WHERE aad_id = ?`,
    )
      .bind("person-1")
      .first<{ profile_json: string | null; profile_updated_at: string | null }>();
    expect(row?.profile_json).toBeTruthy();
    expect(row?.profile_updated_at).toBeTruthy();

    // Self can read it.
    const asSelf = await store.getPersonProfile("person-1", {
      aadId: "person-1",
      isAdmin: false,
    });
    expect(asSelf?.focusAreas).toContain("infrastructure");

    // Admin can read it.
    const asAdmin = await store.getPersonProfile("person-1", {
      aadId: "admin-aad-id",
      isAdmin: true,
    });
    expect(asAdmin).not.toBeNull();

    // A non-admin peer must NEVER receive another person's profile.
    const asPeer = await store.getPersonProfile("person-1", {
      aadId: "person-2",
      isAdmin: false,
    });
    expect(asPeer).toBeNull();
  });

  it("skips when there is too little evidence (< min)", async () => {
    const store = makeStore(5);
    const built = await store.updatePersonProfile("person-thin", log);
    expect(built).toBeNull();
  });
});

describe("customer profiles", () => {
  it("writes a consolidated profile and gates reads by ACL", async () => {
    const store = makeStore();
    const built = await store.updateCustomerProfile("GNC", log);
    expect(built).not.toBeNull();
    expect(built?.name).toBe("gnc");
    expect(built?.topics).toContain("renewal");

    // In-tenant staff (non-admin) can read via the tenant grant written at
    // creation.
    const entitled = await store.getCustomerProfile("GNC", {
      aadId: "staff-1",
      tenantId: testEnv.GRAPH_TENANT_ID,
      isAdmin: false,
    });
    expect(entitled?.contacts).toContain("Jane (procurement)");

    // Out-of-tenant, non-admin caller is denied → null.
    const denied = await store.getCustomerProfile("GNC", {
      aadId: "outsider",
      tenantId: "some-other-tenant",
      isAdmin: false,
    });
    expect(denied).toBeNull();

    // Admin bypasses the gate.
    const asAdmin = await store.getCustomerProfile("GNC", {
      aadId: "admin-aad-id",
      tenantId: "some-other-tenant",
      isAdmin: true,
    });
    expect(asAdmin).not.toBeNull();
  });

  it("returns null for an unknown customer", async () => {
    const store = makeStore();
    const p = await store.getCustomerProfile("no-such-co", {
      aadId: "admin-aad-id",
      tenantId: testEnv.GRAPH_TENANT_ID,
      isAdmin: true,
    });
    expect(p).toBeNull();
  });
});

describe("query_customer MCP tool", () => {
  it("returns the profile for an entitled caller", async () => {
    // Ensure the profile exists (idempotent rebuild).
    await makeStore().updateCustomerProfile("GNC", log);

    const tool = tools.find((t) => t.name === "query_customer");
    expect(tool).toBeDefined();

    const ctx = createExecutionContext();
    const result = (await tool!.handler(
      {
        env: testEnv,
        ctx,
        log,
        caller: {
          aadId: "staff-1",
          tenantId: testEnv.GRAPH_TENANT_ID,
          isAdmin: false,
        },
      },
      { name: "GNC" },
    )) as { found: boolean; profile?: { name: string } };

    expect(result.found).toBe(true);
    expect(result.profile?.name).toBe("gnc");
  });

  it("reports no-profile-yet for an unknown customer", async () => {
    const tool = tools.find((t) => t.name === "query_customer");
    const ctx = createExecutionContext();
    const result = (await tool!.handler(
      {
        env: testEnv,
        ctx,
        log,
        caller: {
          aadId: "admin-aad-id",
          tenantId: testEnv.GRAPH_TENANT_ID,
          isAdmin: true,
        },
      },
      { name: "Nonexistent Corp" },
    )) as { found: boolean; message?: string };

    expect(result.found).toBe(false);
    expect(result.message).toContain("No profile yet");
  });
});

describe("message-count cadence", () => {
  it("triggers a refresh every N messages and resets", async () => {
    const aad = `counter-${Date.now()}`;
    const r1 = await recordMessageForProfile(testEnv, aad, { every: 3 });
    expect(r1.shouldRefresh).toBe(false);
    const r2 = await recordMessageForProfile(testEnv, aad, { every: 3 });
    expect(r2.shouldRefresh).toBe(false);
    const r3 = await recordMessageForProfile(testEnv, aad, { every: 3 });
    expect(r3.shouldRefresh).toBe(true);
    // Counter reset → next cycle starts over.
    const r4 = await recordMessageForProfile(testEnv, aad, { every: 3 });
    expect(r4.shouldRefresh).toBe(false);
  });
});
