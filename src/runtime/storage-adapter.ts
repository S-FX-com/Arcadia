// Microsoft 365 Agents SDK Storage adapter.
//
// v2 doesn't use the SDK's built-in Storage for now — conversation +
// user + task + memory state all live in dedicated D1 tables managed
// by their respective modules (memory/, tasks/, routines/, etc.). This
// adapter exists so that when we do bring in SDK dialogs or scope-state
// tracking, the wiring point is already named.
//
// Keeping the shape minimal so the eventual SDK integration is
// straightforward: it implements the same { read, write, delete } trio
// any Storage implementation needs.

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
