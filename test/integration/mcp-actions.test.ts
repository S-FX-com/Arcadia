// Integration tests for the MCP action surface (EXECUTION-PLAN §Phase 5):
//   perform_action  — general autonomy entry point, ladder-gated.
//   assign_task     — verb behind the ladder (confirm → awaiting).
//   confirm_action  — approve/reject a pending action (actor/admin only).
//   query_routines  — read-only, caller-scoped.
//
// Callers are minted the same way mcp-auth.test.ts does: a local RSA keypair
// stands in for Microsoft's tenant JWKS (keyResolver seam), a real bearer
// token is signed against it, and handleMcp verifies it server-side. Each
// test uses a distinct caller oid so its per-scope action_policy rows and
// action_log rows never collide with a sibling in the shared miniflare D1.

import { env, createExecutionContext } from "cloudflare:test";
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { handleMcp } from "../../src/mcp/server";
import { TaskStore } from "../../src/tasks/store";
import { RoutineStore } from "../../src/routines/store";
import { logger } from "../../src/lib/logger";

const testEnv = env as unknown as Env;
const log = logger();

let keyResolver: JWTVerifyGetKey;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  keyResolver = (() => pair.publicKey) as unknown as JWTVerifyGetKey;
});

async function mintToken(oid: string): Promise<string> {
  return new SignJWT({ tid: testEnv.GRAPH_TENANT_ID, oid })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(
      `https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`,
    )
    .setAudience(testEnv.WEBAPP_CLIENT_ID)
    .sign(privateKey);
}

interface CallResult {
  isError: boolean;
  text: string;
  json: Record<string, unknown> | null;
}

async function call(
  oid: string,
  name: string,
  args: Record<string, unknown>,
  id = 1,
): Promise<CallResult> {
  const ctx = createExecutionContext();
  const token = await mintToken(oid);
  const res = await handleMcp(
    new Request("https://arcadia.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    testEnv,
    ctx,
    log,
    { keyResolver },
  );
  const body = (await res.json()) as {
    result?: { isError?: boolean; content?: { text: string }[] };
  };
  const text = body.result?.content?.[0]?.text ?? "";
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { isError: body.result?.isError === true, text, json };
}

async function seedPolicy(
  verb: string,
  scopeType: string,
  scopeId: string,
  level: string,
): Promise<void> {
  await testEnv.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO action_policy (verb, scope_type, scope_id, level)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(verb, scopeType, scopeId, level)
    .run();
}

async function countTasksByTitle(title: string): Promise<number> {
  const row = await testEnv.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE title = ?`,
  )
    .bind(title)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("MCP perform_action — ladder gating", () => {
  it("'observe' policy → rejected, no side effect", async () => {
    const oid = "mcp-act-observe";
    await seedPolicy("create_task", "user", oid, "observe");
    const title = `observe-${crypto.randomUUID()}`;

    const r = await call(oid, "perform_action", {
      verb: "create_task",
      scope: { type: "user", id: oid },
      params: { title },
    });

    expect(r.isError).toBe(false);
    expect(r.json?.status).toBe("rejected");
    expect(await countTasksByTitle(title)).toBe(0);
  });

  it("'auto' policy → executes and writes a tasks row", async () => {
    const oid = "mcp-act-auto";
    await seedPolicy("create_task", "user", oid, "auto");
    const title = `auto-${crypto.randomUUID()}`;

    const r = await call(oid, "perform_action", {
      verb: "create_task",
      scope: { type: "user", id: oid },
      params: { title },
    });

    expect(r.isError).toBe(false);
    expect(r.json?.status).toBe("executed");
    expect(await countTasksByTitle(title)).toBe(1);
  });

  it("rejects an unknown verb", async () => {
    const r = await call("mcp-act-unknown", "perform_action", {
      verb: "obliterate_everything",
      params: {},
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unknown verb");
  });
});

describe("MCP assign_task + confirm_action", () => {
  it("assign_task at 'confirm' → awaiting_confirmation + action_id", async () => {
    const oid = "mcp-act-confirm";
    // No policy row → assign_task defaults to 'confirm'.
    const r = await call(oid, "assign_task", {
      task_id: "no-such-task",
      owner_aad_id: "someone",
    });

    expect(r.isError).toBe(false);
    expect(r.json?.status).toBe("awaiting_confirmation");
    expect(typeof r.json?.action_id).toBe("string");
  });

  it("confirm_action approve → executes; a second approve is a no-op", async () => {
    const actor = "mcp-act-approver";
    const store = new TaskStore(testEnv);
    const task = await store.create(
      { title: `assignable-${crypto.randomUUID()}`, ownerAadId: "orig-owner" },
      "test",
    );

    // 1. assign_task parks an awaiting_confirmation action.
    const parked = await call(actor, "assign_task", {
      task_id: task.id,
      owner_aad_id: "new-owner",
    });
    expect(parked.json?.status).toBe("awaiting_confirmation");
    const actionId = String(parked.json?.action_id);

    // 2. The actor approves → the verb executes.
    const approved = await call(actor, "confirm_action", {
      action_id: actionId,
      decision: "approve",
    });
    expect(approved.isError).toBe(false);
    expect(approved.json?.status).toBe("executed");

    const after = await store.byId(task.id);
    expect(after?.ownerAadId).toBe("new-owner");

    // 3. A second approve replays the prior outcome (idempotency key =
    //    actionId) — it must not execute a second time.
    const again = await call(actor, "confirm_action", {
      action_id: actionId,
      decision: "approve",
    });
    expect(again.json?.status).toBe("executed");

    const executedRows = await testEnv.ARCADIA_DB.prepare(
      `SELECT COUNT(*) AS n FROM action_log
        WHERE idempotency_key = ? AND status = 'executed'`,
    )
      .bind(actionId)
      .first<{ n: number }>();
    expect(executedRows?.n).toBe(1);
  });

  it("confirm_action by a non-actor non-admin → denied", async () => {
    const actor = "mcp-act-owner";
    const parked = await call(actor, "assign_task", {
      task_id: "any-task",
      owner_aad_id: "x",
    });
    const actionId = String(parked.json?.action_id);

    const intruder = "mcp-act-intruder";
    const r = await call(intruder, "confirm_action", {
      action_id: actionId,
      decision: "approve",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("access_denied");
  });
});

describe("MCP query_routines — caller scoping", () => {
  it("returns only the caller's routines (non-admin)", async () => {
    const oid = "mcp-act-routines";
    const store = new RoutineStore(testEnv);
    const mine = await store.create(
      oid,
      {
        name: `mine-${crypto.randomUUID()}`,
        trigger: { kind: "manual" },
        steps: [{ kind: "ai_complete", prompt: "hi", as: "out" }],
      },
      true,
    );
    const theirs = await store.create(
      "someone-else",
      {
        name: `theirs-${crypto.randomUUID()}`,
        trigger: { kind: "manual" },
        steps: [{ kind: "ai_complete", prompt: "hi", as: "out" }],
      },
      true,
    );

    const r = await call(oid, "query_routines", {});
    expect(r.isError).toBe(false);
    const routines = (r.json?.routines ?? []) as { id: string }[];
    const ids = routines.map((x) => x.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });
});
