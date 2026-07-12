// Integration tests for src/webapp/actions-api.ts (the P5 admin control
// plane over the action framework) via the real route table in routes.ts.
//
// Sessions are minted the same way proposals-api.test.ts / sources-api.test.ts
// do: a local RSA keypair stands in for Microsoft's tenant JWKS (keyResolver
// seam), a real access token is signed against it, and exchangeAndSeal()
// yields the same sealed session cookie /auth/exchange would.

import { createExecutionContext, env } from "cloudflare:test";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import { isKillSwitchOn } from "../../src/actions/framework";
import { ActionPolicyStore } from "../../src/actions/policy";
import { exchangeAndSeal } from "../../src/webapp/auth";
import { handleWebapp } from "../../src/webapp/routes";

const testEnv = env as unknown as Env;
const log = logger();

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  keyResolver = (() => pair.publicKey) as unknown as JWTVerifyGetKey;
});

async function mintCookie(oid: string): Promise<string> {
  const token = await new SignJWT({ tid: testEnv.GRAPH_TENANT_ID, oid })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(`https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`)
    .setAudience(testEnv.WEBAPP_CLIENT_ID)
    .sign(privateKey);
  const { cookie } = await exchangeAndSeal(testEnv, token, { keyResolver });
  return cookie.split(";")[0] ?? "";
}

function req(
  cookie: string,
  suffix: string,
  init: RequestInit = {},
): Request {
  return new Request(`https://arcadia.test/api/webapp/actions${suffix}`, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function run(request: Request): Promise<Response> {
  return handleWebapp(request, testEnv, createExecutionContext(), log);
}

async function seedLog(row: {
  verb: string;
  status: string;
  level?: string;
  scopeType?: string;
  scopeId?: string;
  createdAt?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO action_log
       (id, verb, actor_aad_id, on_behalf, scope_type, scope_id, level,
        params_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      row.verb,
      "seed-actor",
      "app-only",
      row.scopeType ?? "tenant",
      row.scopeId ?? "*",
      row.level ?? "auto",
      "{}",
      row.status,
      row.createdAt ?? new Date().toISOString(),
    )
    .run();
  return id;
}

interface PolicyBody {
  policies: {
    verb: string;
    scopeType: string;
    scopeId: string;
    level: string;
  }[];
}
interface LogBody {
  log: { id: string; verb: string; status: string }[];
}

describe("actions admin control plane — non-admin", () => {
  it("returns 403 on every endpoint", async () => {
    const cookie = await mintCookie("actions-nonadmin-1");
    const cases: Request[] = [
      req(cookie, "/policy"),
      req(cookie, "/policy", {
        method: "PUT",
        body: JSON.stringify({ verb: "v", scopeType: "tenant", scopeId: "*", level: "auto" }),
      }),
      req(cookie, "/policy", {
        method: "DELETE",
        body: JSON.stringify({ verb: "v", scopeType: "tenant", scopeId: "*" }),
      }),
      req(cookie, "/kill"),
      req(cookie, "/kill", { method: "PUT", body: JSON.stringify({ on: true }) }),
      req(cookie, "/log"),
    ];
    for (const c of cases) {
      const res = await run(c);
      expect(res.status).toBe(403);
    }
  });
});

describe("policy set / update / delete", () => {
  it("admin upserts a policy, re-set updates the level, then deletes", async () => {
    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);
    const verb = `verb-${crypto.randomUUID().slice(0, 8)}`;
    const store = new ActionPolicyStore(testEnv);

    // Create at 'draft'.
    let res = await run(
      req(cookie, "/policy", {
        method: "PUT",
        body: JSON.stringify({ verb, scopeType: "channel", scopeId: "*", level: "draft" }),
      }),
    );
    expect(res.status).toBe(200);
    let rows = await store.list();
    let mine = rows.filter((r) => r.verb === verb);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.level).toBe("draft");
    expect(mine[0]?.updatedBy).toBe(testEnv.ADMIN_USER_AAD_ID);

    // Re-set same key → update, not duplicate.
    res = await run(
      req(cookie, "/policy", {
        method: "PUT",
        body: JSON.stringify({ verb, scopeType: "channel", scopeId: "*", level: "auto" }),
      }),
    );
    expect(res.status).toBe(200);
    rows = await store.list();
    mine = rows.filter((r) => r.verb === verb);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.level).toBe("auto");

    // GET reflects it.
    res = await run(req(cookie, "/policy"));
    const listed = (await res.json()) as PolicyBody;
    expect(listed.policies.some((p) => p.verb === verb && p.level === "auto")).toBe(true);

    // Delete → gone.
    res = await run(
      req(cookie, "/policy", {
        method: "DELETE",
        body: JSON.stringify({ verb, scopeType: "channel", scopeId: "*" }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { removed: boolean }).toMatchObject({ removed: true });
    rows = await store.list();
    expect(rows.some((r) => r.verb === verb)).toBe(false);
  });

  it("rejects a bad level and a bad scope type with 400", async () => {
    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);

    const badLevel = await run(
      req(cookie, "/policy", {
        method: "PUT",
        body: JSON.stringify({ verb: "v", scopeType: "tenant", scopeId: "*", level: "nope" }),
      }),
    );
    expect(badLevel.status).toBe(400);

    const badScope = await run(
      req(cookie, "/policy", {
        method: "PUT",
        body: JSON.stringify({ verb: "v", scopeType: "galaxy", scopeId: "*", level: "auto" }),
      }),
    );
    expect(badScope.status).toBe(400);
  });
});

describe("kill switch", () => {
  it("GET/PUT round-trips and isKillSwitchOn reflects it", async () => {
    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);

    // Ensure a known baseline.
    await run(req(cookie, "/kill", { method: "PUT", body: JSON.stringify({ on: false }) }));
    let res = await run(req(cookie, "/kill"));
    expect((await res.json()) as { on: boolean }).toEqual({ on: false });
    expect(await isKillSwitchOn(testEnv)).toBe(false);

    // Engage.
    res = await run(req(cookie, "/kill", { method: "PUT", body: JSON.stringify({ on: true }) }));
    expect((await res.json()) as { on: boolean }).toEqual({ on: true });
    expect(await isKillSwitchOn(testEnv)).toBe(true);

    res = await run(req(cookie, "/kill"));
    expect((await res.json()) as { on: boolean }).toEqual({ on: true });

    // Disengage (leave clean for other tests).
    res = await run(req(cookie, "/kill", { method: "PUT", body: JSON.stringify({ on: false }) }));
    expect((await res.json()) as { on: boolean }).toEqual({ on: false });
    expect(await isKillSwitchOn(testEnv)).toBe(false);
  });

  it("rejects a non-boolean body with 400", async () => {
    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);
    const res = await run(req(cookie, "/kill", { method: "PUT", body: JSON.stringify({ on: "yes" }) }));
    expect(res.status).toBe(400);
  });
});

describe("audit log", () => {
  it("returns seeded rows filtered by status and verb, newest first", async () => {
    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);
    const verb = `logverb-${crypto.randomUUID().slice(0, 8)}`;

    const executedId = await seedLog({ verb, status: "executed", createdAt: "2020-01-01T00:00:00.000Z" });
    const blockedId = await seedLog({ verb, status: "blocked", createdAt: "2020-01-02T00:00:00.000Z" });

    // Filter by verb → both, newest first.
    let res = await run(req(cookie, `/log?verb=${verb}`));
    expect(res.status).toBe(200);
    let body = (await res.json()) as LogBody;
    const ids = body.log.filter((r) => r.verb === verb).map((r) => r.id);
    expect(ids).toContain(executedId);
    expect(ids).toContain(blockedId);
    expect(ids.indexOf(blockedId)).toBeLessThan(ids.indexOf(executedId));

    // Filter by status + verb → only executed.
    res = await run(req(cookie, `/log?verb=${verb}&status=executed`));
    body = (await res.json()) as LogBody;
    const filtered = body.log.filter((r) => r.verb === verb);
    expect(filtered.map((r) => r.id)).toEqual([executedId]);
  });
});
