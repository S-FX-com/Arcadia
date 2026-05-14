// Charter store.
//
// The `charter` table is append-only — `update()` doesn't exist. To
// change the charter you publish() a new version; it deactivates the
// previous active row and links back to it via replaces_id. History
// is a simple SELECT ordered by version.

import type { Env } from "../env";
import { invalidateCharterCache } from "./inject";
import type { CharterRecord } from "./types";

interface CharterRow {
  id: string;
  version: number;
  body: string;
  active: number;
  replaces_id: string | null;
  created_at: string;
}

export class CharterStore {
  constructor(private readonly env: Env) {}

  /** Returns the currently-active charter, if any. */
  async active(): Promise<CharterRecord | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM charter WHERE active = 1 ORDER BY version DESC LIMIT 1`,
    ).first<CharterRow>();
    return row ? fromRow(row) : null;
  }

  async byId(id: string): Promise<CharterRecord | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM charter WHERE id = ?`,
    )
      .bind(id)
      .first<CharterRow>();
    return row ? fromRow(row) : null;
  }

  async history(limit = 25): Promise<CharterRecord[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM charter ORDER BY version DESC LIMIT ?`,
    )
      .bind(limit)
      .all<CharterRow>();
    return rows.results.map(fromRow);
  }

  /**
   * Publish a new charter version. Deactivates the previous active
   * row (if any) and links the new row's replaces_id to it.
   */
  async publish(body: string): Promise<CharterRecord> {
    const previous = await this.active();
    const nextVersion = (previous?.version ?? 0) + 1;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    if (previous) {
      await this.env.ARCADIA_DB.prepare(
        `UPDATE charter SET active = 0 WHERE id = ?`,
      )
        .bind(previous.id)
        .run();
    }

    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO charter (id, version, body, active, replaces_id, created_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
      .bind(id, nextVersion, body.trim(), previous?.id ?? null, now)
      .run();

    await invalidateCharterCache(this.env);

    return {
      id,
      version: nextVersion,
      body: body.trim(),
      active: true,
      createdAt: now,
      ...(previous ? { replacesId: previous.id } : {}),
    };
  }

  /**
   * Roll back to a prior version by re-publishing its body as a new
   * version. The version number always moves forward — there is no
   * "current pointer" to drag backwards.
   */
  async revertTo(id: string): Promise<CharterRecord | null> {
    const target = await this.byId(id);
    if (!target) return null;
    return this.publish(target.body);
  }
}

function fromRow(r: CharterRow): CharterRecord {
  return {
    id: r.id,
    version: r.version,
    body: r.body,
    active: r.active === 1,
    createdAt: r.created_at,
    ...(r.replaces_id ? { replacesId: r.replaces_id } : {}),
  };
}
