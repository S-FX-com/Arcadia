import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import { runNudgeCycle, type NudgeDeps } from "../../src/intelligence/nudge";
import type { Presence } from "../../src/graph/presence";
import type { ConversationRef, BotActor } from "../../src/runtime/bot-outbound";
import type { AdaptiveCard } from "../../src/cards/types";
import type { Logger } from "../../src/lib/logger";

// Integration test: seeds at-risk tasks in the real miniflare D1, then runs
// runNudgeCycle with an injected presence map and a spy in place of the
// real Bot Framework postCard (which would otherwise need a live
// serviceUrl). Asserts the presence gate — not the SQL candidate query,
// which is unit-tested implicitly by the existing nudge behaviour — skips
// exactly the Busy owner without touching that task's last_nudge_at, while
// the Available and Unknown-presence owners both get nudged and stamped.

const testEnv = env as unknown as Env;
const log = logger();

const CHANNEL_ID = "presence-nudge-channel";
const SERVICE_URL = "https://smba.example/v3";
const CONVERSATION_ID = "presence-nudge-conversation";

const OWNER_BUSY = "presence-owner-busy";
const OWNER_AVAILABLE = "presence-owner-available";
const OWNER_UNKNOWN = "presence-owner-unknown";

interface SentCard {
  targetAadId: string | undefined;
  conversationId: string;
}

/** Builds an injectable NudgeDeps: a fixed presence map plus a postCard spy
 *  that never touches the network — it just records what would have been
 *  sent. Mirrors the RegistryDeps injection pattern in registry.ts. */
function fakeDeps(presence: Map<string, Presence>): {
  deps: NudgeDeps;
  sent: SentCard[];
} {
  const sent: SentCard[] = [];
  const deps: NudgeDeps = {
    getPresenceBatch: async (_env: Env, _aadIds: string[]) => presence,
    postCard: async (
      _env: Env,
      ref: ConversationRef,
      card: AdaptiveCard,
      _log: Logger,
      _opts?: { from?: BotActor; summary?: string },
    ): Promise<void> => {
      sent.push({
        targetAadId: card.refresh?.userIds?.[0],
        conversationId: ref.conversationId,
      });
    },
  };
  return { deps, sent };
}

async function seedChannel(): Promise<void> {
  await testEnv.ARCADIA_DB.prepare(
    `INSERT OR IGNORE INTO channels
       (channel_id, team_id, tenant_id, service_url, conversation_id, enabled)
     VALUES (?, 'team-1', ?, ?, ?, 1)`,
  )
    .bind(CHANNEL_ID, testEnv.GRAPH_TENANT_ID, SERVICE_URL, CONVERSATION_ID)
    .run();
}

async function seedTask(
  id: string,
  ownerAadId: string,
  deadlineOffsetHours: number,
): Promise<void> {
  const deadline = new Date(
    Date.now() + deadlineOffsetHours * 3600 * 1000,
  ).toISOString();
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO tasks
       (id, channel_id, title, owner_aad_id, deadline_at, priority, status, last_nudge_at)
     VALUES (?, ?, ?, ?, ?, 'normal', 'open', NULL)`,
  )
    .bind(id, CHANNEL_ID, `Task for ${ownerAadId}`, ownerAadId, deadline)
    .run();
}

async function lastNudgeAt(taskId: string): Promise<string | null> {
  const row = await testEnv.ARCADIA_DB.prepare(
    `SELECT last_nudge_at FROM tasks WHERE id = ?`,
  )
    .bind(taskId)
    .first<{ last_nudge_at: string | null }>();
  return row?.last_nudge_at ?? null;
}

describe("presence-aware nudging", () => {
  it("skips the Busy owner without consuming cooldown, nudges Available and Unknown-presence owners", async () => {
    await seedChannel();

    const busyTaskId = "presence-task-busy";
    const availTaskId = "presence-task-available";
    const unknownTaskId = "presence-task-unknown";

    await seedTask(busyTaskId, OWNER_BUSY, 1);
    await seedTask(availTaskId, OWNER_AVAILABLE, 2);
    await seedTask(unknownTaskId, OWNER_UNKNOWN, 3);

    const presence = new Map<string, Presence>([
      [OWNER_BUSY, { availability: "Busy", activity: "Available" }],
      [OWNER_AVAILABLE, { availability: "Available", activity: "Available" }],
      [OWNER_UNKNOWN, { availability: "Unknown", activity: "Unknown" }],
    ]);
    const { deps, sent } = fakeDeps(presence);

    const result = await runNudgeCycle(testEnv, log, deps);

    // Sent: Available + Unknown-presence owners. Skipped: Busy owner only.
    expect(result.nudgesSent).toBe(2);
    expect(result.skippedPresence).toBe(1);
    expect(result.failures).toBe(0);

    const sentTargets = sent.map((s) => s.targetAadId).sort();
    expect(sentTargets).toEqual([OWNER_AVAILABLE, OWNER_UNKNOWN].sort());
    expect(sent.every((s) => s.conversationId === CONVERSATION_ID)).toBe(
      true,
    );

    // Busy owner: presence-skipped, last_nudge_at must remain untouched
    // (cooldown not consumed — the task is reconsidered next cycle).
    expect(await lastNudgeAt(busyTaskId)).toBeNull();

    // Available + Unknown owners: actually nudged, last_nudge_at stamped.
    expect(await lastNudgeAt(availTaskId)).not.toBeNull();
    expect(await lastNudgeAt(unknownTaskId)).not.toBeNull();
  });

  it("presence lookup missing an owner entirely (fail-open) still nudges them", async () => {
    await seedChannel();

    const taskId = "presence-task-missing-entry";
    const owner = "presence-owner-missing-entry";
    await seedTask(taskId, owner, 1);

    // No entry for `owner` at all — isReachable(undefined) is true.
    const { deps, sent } = fakeDeps(new Map<string, Presence>());

    const result = await runNudgeCycle(testEnv, log, deps);

    expect(result.skippedPresence).toBe(0);
    expect(sent.some((s) => s.targetAadId === owner)).toBe(true);
    expect(await lastNudgeAt(taskId)).not.toBeNull();
  });
});
