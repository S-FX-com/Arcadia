import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Smoke test: proves the migrations applied (real tables exist) and that the
// D1 + KV bindings work end-to-end inside the workerd runtime.
describe("integration smoke", () => {
  it("inserts and reads back a row in a migrated D1 table", async () => {
    const aadId = "aad-smoke-user-1";

    await env.ARCADIA_DB.prepare(
      `INSERT INTO users (aad_id, tenant_id, display_name, is_admin)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(aadId, "tenant-smoke", "Smoke Tester", 0)
      .run();

    const row = await env.ARCADIA_DB.prepare(
      `SELECT aad_id, tenant_id, display_name FROM users WHERE aad_id = ?`,
    )
      .bind(aadId)
      .first<{ aad_id: string; tenant_id: string; display_name: string }>();

    expect(row).not.toBeNull();
    expect(row?.aad_id).toBe(aadId);
    expect(row?.tenant_id).toBe("tenant-smoke");
    expect(row?.display_name).toBe("Smoke Tester");
  });

  it("proves the 0002 migration applied (users.active_client_id column exists)", async () => {
    // active_client_id is added by schema/0002_clients.sql via ALTER TABLE.
    // If that migration did not run, this INSERT throws "no such column".
    await env.ARCADIA_DB.prepare(
      `INSERT INTO users (aad_id, tenant_id, active_client_id)
       VALUES (?, ?, ?)`,
    )
      .bind("aad-smoke-user-2", "tenant-smoke", "client-123")
      .run();

    const row = await env.ARCADIA_DB.prepare(
      `SELECT active_client_id FROM users WHERE aad_id = ?`,
    )
      .bind("aad-smoke-user-2")
      .first<{ active_client_id: string }>();

    expect(row?.active_client_id).toBe("client-123");
  });

  it("puts and gets a value via the KV binding", async () => {
    await env.ARCADIA_CACHE.put("smoke:key", "smoke-value");
    const value = await env.ARCADIA_CACHE.get("smoke:key");
    expect(value).toBe("smoke-value");
  });
});
