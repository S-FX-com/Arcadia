// Domain types shared across Arcadia modules. D1 row shapes live next to the
// queries that read them; these are the cross-module contracts.

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/**
 * Progress a workflow reports back to its agent. Shared by every workflow —
 * ratification, doctrine seeding, site planning — so a surface can render one
 * progress shape whatever produced it.
 */
export interface WorkflowProgress {
  step?: string;
  status?: "pending" | "running" | "complete" | "error";
  message?: string;
  percent?: number;
  waitingForApproval?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Approvals / audit
// ---------------------------------------------------------------------------

export type ApprovalKind = "doctrine_ratify" | "site_plan";

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
