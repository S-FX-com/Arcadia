// MemoryDriver — the seam between Arcadia and whatever stores her memory (§5.1).
// The self-hosted DO+Vectorize implementation and the future Cloudflare Agent
// Memory implementation both sit behind this interface, so the Phase 5
// migration is a driver swap, not a rewrite. The shape mirrors Agent Memory's
// API surface on purpose.

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export type MemoryKind = "fact" | "event" | "instruction" | "task";

export interface Memory {
  id: string;
  profile: string;
  content: string;
  kind: MemoryKind;
  /** Normalized topic key for exact-match retrieval and conflict checks. */
  topicKey: string;
  /** Version chain: id of the entry this one superseded, if any. */
  supersedes?: string;
  /** Forward pointer — set on the OLD entry when a newer version lands. */
  supersededBy?: string;
  provenance: Provenance;
  createdAt: string;
  lastRecalledAt?: string;
}

export interface Provenance {
  capturedFrom: string; // channel, document, session, seed file…
  capturedAt: string;
  ratifiedBy?: string; // human email — doctrine-canonical entries always have one
  sessionId?: string;
}

export interface IngestResult {
  written: Memory[];
  duplicates: number;
  /** Doctrine conflicts HALT and land here for a human to resolve (§5.6.2). */
  conflicts: Array<{ existing: Memory; incoming: Memory }>;
}

export interface RecallOpts {
  limit?: number;
  /** Minimum fused relevance; below the floor we escalate instead of answer (§5.6.7). */
  confidenceFloor?: number;
  kind?: MemoryKind;
}

export interface RecallResult {
  memories: Array<Memory & { score: number }>;
  /** True when nothing cleared the confidence floor — caller must escalate, not invent. */
  belowConfidenceFloor: boolean;
}

export interface ListFilter {
  kind?: MemoryKind;
  topicKey?: string;
  /** Entries not recalled since this ISO timestamp (decay review, §5.6.5). */
  unusedSince?: string;
  limit?: number;
}

export interface Profile {
  readonly name: string;
  ingest(messages: Message[], opts: { sessionId: string }): Promise<IngestResult>;
  remember(m: { content: string; sessionId?: string }): Promise<Memory>;
  recall(query: string, opts?: RecallOpts): Promise<RecallResult>;
  list(filter?: ListFilter): Promise<Memory[]>;
  forget(id: string): Promise<void>;
}

export interface MemoryDriver {
  getProfile(name: string): Promise<Profile>;
}

// Profile names carry governance (§5.2). Canonical is promotion-only.
export const DOCTRINE_CANONICAL = "sfx-doctrine-canonical";
export const DOCTRINE_STAGING = "sfx-doctrine-staging";
export const EPISODIC = "sfx-episodic";

export const projectProfile = (id: string) => `sfx-project-${id}`;
export const personProfile = (id: string) => `sfx-person-${id}`;
