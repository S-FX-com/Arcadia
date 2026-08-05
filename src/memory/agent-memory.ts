// Cloudflare Agent Memory driver — Phase 5 (§4, §5.1).
//
// Agent Memory is in private beta and cannot carry a production dependency.
// When it hits GA: implement this against the same MemoryDriver interface,
// dual-write alongside SelfHostedMemoryDriver, compare recall quality, then
// cut over. Migration is a driver swap, not a rewrite.

import type { MemoryDriver, Profile } from "./driver";

export class AgentMemoryDriver implements MemoryDriver {
  getProfile(_name: string): Promise<Profile> {
    throw new Error(
      "AgentMemoryDriver is a Phase 5 stub — Cloudflare Agent Memory is private beta. Use SelfHostedMemoryDriver."
    );
  }
}
