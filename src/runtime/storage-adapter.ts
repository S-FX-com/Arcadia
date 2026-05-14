// Microsoft 365 Agents SDK Storage adapter, backed by D1 (durable state)
// and KV (ephemeral session state).
//
// Real implementation lands in the Runtime + Memory commit.

import type { Env } from "../env";

export class ArcadiaStorage {
  constructor(private readonly env: Env) {}

  async read(_keys: string[]): Promise<Record<string, unknown>> {
    throw new Error("storage_unimplemented");
  }

  async write(_changes: Record<string, unknown>): Promise<void> {
    throw new Error("storage_unimplemented");
  }

  async delete(_keys: string[]): Promise<void> {
    throw new Error("storage_unimplemented");
  }
}
