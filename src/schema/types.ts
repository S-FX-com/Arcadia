// Domain types shared across Arcadia modules. D1 row shapes live next to the
// queries that read them; these are the cross-module contracts.

// ---------------------------------------------------------------------------
// Hermes (Phase 1a)
// ---------------------------------------------------------------------------

export type TopicStatus =
  | "queued"
  | "in_progress"
  | "awaiting_approval"
  | "published"
  | "rejected"
  | "duplicate"
  | "failed";

export interface Topic {
  id: string;
  title: string;
  keywords: string[];
  notes?: string;
  priority: number;
  status: TopicStatus;
}

/** Params handed to the Hermes publish workflow (workflow input, not metadata). */
export interface PublishParams {
  /** Pin a specific topic; otherwise the workflow selects from the queue. */
  requestedTopicId?: string;
  /** Who asked for a manual run (scheduled runs leave this unset). */
  requestedBy?: string;
}

export interface SeoFields {
  title: string;
  metaDescription: string;
  slug: string;
  /** Actual SureRank meta keys are read off a live post (§9.6), never guessed. */
  sureRankMeta: Record<string, string>;
}

export interface DraftArtifact {
  title: string;
  html: string;
  excerpt: string;
  doctrineEntries: string[]; // memory ids recalled for the draft
  sources: string[]; // research source URLs
}

export interface PublishProgress {
  step?: string;
  status?: "pending" | "running" | "complete" | "error";
  message?: string;
  percent?: number;
  waitingForApproval?: boolean;
  topicId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Approvals / audit
// ---------------------------------------------------------------------------

export type ApprovalKind = "hermes_publish" | "doctrine_ratify";

export interface PendingApproval {
  id: string;
  workflowId: string;
  kind: ApprovalKind;
  subject: string;
  summary?: string;
  createdAt: string;
}

export interface AuditEntry {
  actor: string;
  action: string;
  subject?: string | undefined;
  workflowId?: string | undefined;
  doctrineEntries?: string[] | undefined;
  detail?: string | undefined;
}

// ---------------------------------------------------------------------------
// Doctrine ratification (staging → canonical, human tap required)
// ---------------------------------------------------------------------------

export interface RatifyParams {
  /** Memory id in sfx-doctrine-staging awaiting promotion. */
  stagingMemoryId: string;
  proposedBy: string;
}
