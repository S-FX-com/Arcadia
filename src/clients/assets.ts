// Client asset bundle — CRUD over the client_assets join table.

import type { Env } from "../env";
import type { AssetKind, ClientAsset, NewClientAsset } from "./types";

interface AssetRow {
  client_id: string;
  asset_kind: string;
  asset_id: string;
  label: string | null;
  added_by: string;
  added_at: string;
}

export class ClientAssetStore {
  constructor(private readonly env: Env) {}

  async add(clientId: string, input: NewClientAsset): Promise<ClientAsset> {
    const now = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `INSERT OR REPLACE INTO client_assets
         (client_id, asset_kind, asset_id, label, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        clientId,
        input.assetKind,
        input.assetId,
        input.label ?? null,
        input.addedBy,
        now,
      )
      .run();
    return {
      clientId,
      assetKind: input.assetKind,
      assetId: input.assetId,
      addedBy: input.addedBy,
      addedAt: now,
      ...(input.label ? { label: input.label } : {}),
    };
  }

  async remove(
    clientId: string,
    assetKind: AssetKind,
    assetId: string,
  ): Promise<boolean> {
    const res = await this.env.ARCADIA_DB.prepare(
      `DELETE FROM client_assets
        WHERE client_id = ? AND asset_kind = ? AND asset_id = ?`,
    )
      .bind(clientId, assetKind, assetId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async listForClient(clientId: string): Promise<ClientAsset[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM client_assets WHERE client_id = ? ORDER BY asset_kind, added_at`,
    )
      .bind(clientId)
      .all<AssetRow>();
    return rows.results.map(fromRow);
  }

  /** Which Clients contain a given asset? Used by the bot to auto-scope. */
  async lookupByAsset(
    assetKind: AssetKind,
    assetId: string,
  ): Promise<ClientAsset[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM client_assets
        WHERE asset_kind = ? AND asset_id = ?`,
    )
      .bind(assetKind, assetId)
      .all<AssetRow>();
    return rows.results.map(fromRow);
  }
}

function fromRow(r: AssetRow): ClientAsset {
  return {
    clientId: r.client_id,
    assetKind: r.asset_kind as AssetKind,
    assetId: r.asset_id,
    addedBy: r.added_by,
    addedAt: r.added_at,
    ...(r.label ? { label: r.label } : {}),
  };
}
