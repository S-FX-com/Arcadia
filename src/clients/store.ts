// Clients store on D1.
//
// CRUD for the `clients` table. Assets live in client_assets and are
// owned by ./assets.ts.

import type { Env } from "../env";
import type { Client, ClientStatus, NewClient } from "./types";

interface ClientRow {
  id: string;
  display_name: string;
  slug: string;
  description: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class ClientStore {
  constructor(private readonly env: Env) {}

  async create(input: NewClient): Promise<Client> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO clients
         (id, display_name, slug, description, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
      .bind(
        id,
        input.displayName,
        input.slug,
        input.description ?? null,
        input.createdBy,
        now,
        now,
      )
      .run();

    return {
      id,
      displayName: input.displayName,
      slug: input.slug,
      status: "active",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      ...(input.description ? { description: input.description } : {}),
    };
  }

  async byId(id: string): Promise<Client | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM clients WHERE id = ?`,
    )
      .bind(id)
      .first<ClientRow>();
    return row ? fromRow(row) : null;
  }

  async bySlug(slug: string): Promise<Client | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM clients WHERE slug = ?`,
    )
      .bind(slug)
      .first<ClientRow>();
    return row ? fromRow(row) : null;
  }

  async list(status?: ClientStatus): Promise<Client[]> {
    const stmt = status
      ? this.env.ARCADIA_DB.prepare(
          `SELECT * FROM clients WHERE status = ? ORDER BY display_name ASC`,
        ).bind(status)
      : this.env.ARCADIA_DB.prepare(
          `SELECT * FROM clients ORDER BY display_name ASC`,
        );
    const rows = await stmt.all<ClientRow>();
    return rows.results.map(fromRow);
  }

  async listMany(ids: string[]): Promise<Client[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM clients WHERE id IN (${placeholders}) ORDER BY display_name ASC`,
    )
      .bind(...ids)
      .all<ClientRow>();
    return rows.results.map(fromRow);
  }

  async update(
    id: string,
    patch: {
      displayName?: string;
      description?: string | null;
      status?: ClientStatus;
    },
  ): Promise<Client | null> {
    const existing = await this.byId(id);
    if (!existing) return null;

    const sets: string[] = [];
    const binds: (string | null)[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      binds.push(patch.displayName);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      binds.push(patch.description);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      binds.push(patch.status);
    }
    if (sets.length === 0) return existing;

    const now = new Date().toISOString();
    sets.push("updated_at = ?");
    binds.push(now);
    await this.env.ARCADIA_DB.prepare(
      `UPDATE clients SET ${sets.join(", ")} WHERE id = ?`,
    )
      .bind(...binds, id)
      .run();
    return this.byId(id);
  }

  async archive(id: string): Promise<void> {
    await this.update(id, { status: "archived" });
  }
}

function fromRow(r: ClientRow): Client {
  return {
    id: r.id,
    displayName: r.display_name,
    slug: r.slug,
    status: r.status as ClientStatus,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.description ? { description: r.description } : {}),
  };
}
