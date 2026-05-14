import { describe, expect, it } from "vitest";
import { activeCharterBody, injectCharter } from "../../src/charter/inject";
import type { Env } from "../../src/env";

class FakeKV {
  private map = new Map<string, string>();
  async get(
    key: string,
    options?: { type?: "json" },
  ): Promise<unknown> {
    const raw = this.map.get(key);
    if (raw === undefined) return null;
    if (options?.type === "json") return JSON.parse(raw);
    return raw;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

interface FakeDb {
  rows: Map<string, unknown[]>;
  active: { body: string; version: number } | null;
}

function mockEnv(active: FakeDb["active"]): Env {
  const kv = new FakeKV();
  const db = {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return this;
        },
        async first<T>(): Promise<T | null> {
          if (active) {
            return {
              id: "c1",
              version: active.version,
              body: active.body,
              active: 1,
              replaces_id: null,
              created_at: "2025-01-01T00:00:00Z",
            } as unknown as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] };
        },
        async run(): Promise<unknown> {
          return {};
        },
      };
    },
  };
  return {
    ARCADIA_CACHE: kv as unknown as KVNamespace,
    ARCADIA_DB: db as unknown as D1Database,
  } as Env;
}

describe("injectCharter", () => {
  it("returns base unchanged when no charter is published", async () => {
    const env = mockEnv(null);
    const out = await injectCharter(env, "BASE");
    expect(out).toBe("BASE");
  });

  it("prefixes the charter ahead of base", async () => {
    const env = mockEnv({ body: "We ship Tuesdays.", version: 1 });
    const out = await injectCharter(env, "BASE");
    expect(out).toMatch(/^Operator charter/);
    expect(out).toContain("We ship Tuesdays.");
    expect(out.endsWith("BASE")).toBe(true);
  });

  it("activeCharterBody returns the raw body", async () => {
    const env = mockEnv({ body: "hello", version: 1 });
    expect(await activeCharterBody(env)).toBe("hello");
  });

  it("caches across calls (only one prepare-trip per ttl)", async () => {
    const env = mockEnv({ body: "x", version: 1 });
    const spy: string[] = [];
    const original = env.ARCADIA_DB.prepare.bind(env.ARCADIA_DB);
    (env as { ARCADIA_DB: D1Database }).ARCADIA_DB = {
      prepare(sql: string) {
        spy.push(sql);
        return original(sql);
      },
    } as unknown as D1Database;
    await injectCharter(env, "BASE");
    await injectCharter(env, "BASE");
    expect(spy.length).toBe(1);
  });
});
