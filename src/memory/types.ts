// Memory layer types. Four cognitive layers in one table:
//
//   episodic     — "this happened at this time"
//   semantic     — "X is true / X means Y"
//   procedural   — "when condition, do action"
//   observation  — "Z tends to A" (held lightly, lower confidence)
//
// All four share the `memories` table with `kind` discriminator so recall
// can pull across layers in a single Vectorize query.

export type Kind = "episodic" | "semantic" | "procedural" | "observation";

export type Scope =
  | "tenant"
  | "channel"
  | "chat"
  | "user"
  | "project"
  | "customer";

export interface Memory {
  id: string;
  kind: Kind;
  scopeType: Scope;
  scopeId: string;
  subjectAadId?: string;
  content: string;
  sourceResourceType?: string;
  sourceResourceId?: string;
  sourceMessageId?: string;
  embeddingId?: string;
  confidence: number;
  sensitivityLabel?: string;
  occurredAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewMemory {
  kind: Kind;
  scopeType: Scope;
  scopeId: string;
  subjectAadId?: string;
  content: string;
  sourceResourceType?: string;
  sourceResourceId?: string;
  sourceMessageId?: string;
  confidence?: number;
  sensitivityLabel?: string;
  occurredAt?: string;
  expiresAt?: string;
}

export interface RecallOpts {
  scopeType?: Scope;
  scopeId?: string;
  kind?: Kind | Kind[];
  subjectAadId?: string;
  limit?: number;
  minScore?: number;
  /** AAD id of the viewer; used for permissive ACL filtering. */
  viewer?: string;
}

export interface RecallHit {
  memory: Memory;
  score: number;
}

export type EdgeKind =
  | "supports"
  | "contradicts"
  | "refines"
  | "supersedes"
  | "derived_from"
  | "related_to";

export interface Edge {
  fromId: string;
  toId: string;
  kind: EdgeKind;
  weight: number;
  createdAt: string;
}
