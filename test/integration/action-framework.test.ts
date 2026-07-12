import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import {
  executeAction,
  setKillSwitch,
  type ActionContext,
  type ActionScope,
  type ActionVerb,
  type Ladder,
} from "../../src/actions/framework";

// Framework-level integration tests. These exercise executeAction's choke
// point (kill switch → ladder → budget → audit) with a FAKE verb whose
// execute() is a spy — no real Graph write. Each test uses a unique verb
// name so its action_policy row and action_log rows never collide with a
// sibling test in the same miniflare D1.

const testEnv = env as unknown as Env;
const log = logger();

interface FakeParams {
  v: string;
}

function fakeVerb(defaultLevel: Ladder): {
  verb: ActionVerb<FakeParams>;
  calls: FakeParams[];
} {
  const calls: FakeParams[] = [];
  const name = `fake_${crypto.randomUUID().slice(0, 8)}`;
  const verb: ActionVerb<FakeParams> = {
    name,
    defaultLevel,
    parse(raw): FakeParams {
      const o = raw as { v?: unknown };
      if (typeof o?.v !== "string") throw new Error("v required");
      return { v: o.v };
    },
    describe(p): string {
      return `fake ${p.v}`;
    },
    async execute(_ctx, p) {
      calls.push(p);
      return { ok: true, detail: { echoed: p.v } };
    },
  };
  return { verb, calls };
}

const scope: ActionScope = { type: "tenant", id: "framework-test-tenant" };
const ctx: ActionContext = {
  env: testEnv,
  log,
  actorAadId: "framework-actor",
};

async function seedPolicy(verb: string, level: Ladder): Promise<void> {
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO action_policy (verb, scope_type, scope_id, level)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(verb, scope.type, scope.id, level)
    .run();
}

async function logRow(
  verb: string,
): Promise<{ status: string; level: string } | null> {
  return testEnv.ARCADIA_DB.prepare(
    `SELECT status, level FROM action_log WHERE verb = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(verb)
    .first<{ status: string; level: string }>();
}

describe("executeAction ladder + safety rails", () => {
  it("observe → rejected, no side effect, logged", async () => {
    const { verb, calls } = fakeVerb("confirm");
    await seedPolicy(verb.name, "observe");

    const out = await executeAction(ctx, verb, scope, { v: "x" });

    expect(out.status).toBe("rejected");
    expect(calls).toHaveLength(0);
    expect((await logRow(verb.name))?.status).toBe("rejected");
  });

  it("draft → drafted, no side effect", async () => {
    const { verb, calls } = fakeVerb("confirm");
    await seedPolicy(verb.name, "draft");

    const out = await executeAction(ctx, verb, scope, { v: "x" });

    expect(out.status).toBe("drafted");
    expect(calls).toHaveLength(0);
    expect((await logRow(verb.name))?.status).toBe("drafted");
  });

  it("confirm without confirmed → awaiting_confirmation", async () => {
    const { verb, calls } = fakeVerb("confirm");
    await seedPolicy(verb.name, "confirm");

    const out = await executeAction(ctx, verb, scope, { v: "x" });

    expect(out.status).toBe("awaiting_confirmation");
    expect(calls).toHaveLength(0);
    expect((await logRow(verb.name))?.status).toBe("awaiting_confirmation");
  });

  it("confirm with confirmed:true → executes", async () => {
    const { verb, calls } = fakeVerb("confirm");
    await seedPolicy(verb.name, "confirm");

    const out = await executeAction(
      ctx,
      verb,
      scope,
      { v: "go" },
      { confirmed: true },
    );

    expect(out.status).toBe("executed");
    expect(out.result?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.v).toBe("go");
    expect((await logRow(verb.name))?.status).toBe("executed");
  });

  it("auto → executes", async () => {
    const { verb, calls } = fakeVerb("confirm");
    await seedPolicy(verb.name, "auto");

    const out = await executeAction(ctx, verb, scope, { v: "auto" });

    expect(out.status).toBe("executed");
    expect(calls).toHaveLength(1);
  });

  it("kill switch on → blocked before the ladder", async () => {
    const { verb, calls } = fakeVerb("confirm");
    await seedPolicy(verb.name, "auto");
    await setKillSwitch(testEnv, true);
    try {
      const out = await executeAction(ctx, verb, scope, { v: "x" });
      expect(out.status).toBe("blocked");
      expect(calls).toHaveLength(0);
      expect((await logRow(verb.name))?.status).toBe("blocked");
    } finally {
      await setKillSwitch(testEnv, false);
    }
  });

  it("budget exhausted → blocked", async () => {
    const { verb, calls } = fakeVerb("confirm");
    await seedPolicy(verb.name, "auto");
    const day = "2099-01-02";
    // Seed the day's counter at the default cap (50).
    await testEnv.ARCADIA_CACHE.put(`actions:budget:${day}`, "50");

    const out = await executeAction(ctx, verb, scope, { v: "x" }, {}, day);

    expect(out.status).toBe("blocked");
    expect(calls).toHaveLength(0);
    expect((await logRow(verb.name))?.status).toBe("blocked");
  });

  it("idempotencyKey replay returns the prior outcome without re-executing", async () => {
    const { verb, calls } = fakeVerb("confirm");
    await seedPolicy(verb.name, "auto");
    const key = `idem-${crypto.randomUUID()}`;

    const first = await executeAction(
      ctx,
      verb,
      scope,
      { v: "once" },
      { idempotencyKey: key },
    );
    expect(first.status).toBe("executed");
    expect(calls).toHaveLength(1);

    const replay = await executeAction(
      ctx,
      verb,
      scope,
      { v: "once" },
      { idempotencyKey: key },
    );
    expect(replay.status).toBe("executed");
    expect(replay.actionId).toBe(first.actionId);
    expect(replay.result?.ok).toBe(true);
    // execute() must not have run a second time.
    expect(calls).toHaveLength(1);
  });
});
