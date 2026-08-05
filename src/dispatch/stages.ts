// Escalation enforcement (§4 Phase 3). The review chain is encoded, stages
// cannot be skipped, each has an SLA, and a breach escalates to that
// reviewer's lead — not to the doer.
//
//   Developer → Allie (QA) → Diego (Tech Review) → Shane (Pre-Launch)
//
// Reviewer approval is itself a signed certification: a reviewer who waves
// work through has signed for it, and the certification ledger will catch a
// signature Arcadia can disprove.

export interface StageDef {
  key: string;
  label: string;
  /** Role or named reviewer responsible. Resolved against users at runtime. */
  reviewerRole: "developer" | "qa" | "tech_review" | "pre_launch";
  /** Hours allowed before the SLA breaches and the reviewer's lead is told. */
  slaHours: number;
  /** Checklist that must be signed to leave this stage, if any. */
  checklist?: string;
  /**
   * Minimum seconds a genuine review takes. Approving faster than this is a
   * pass-through signal (§4 Phase 3) — the direct instrument for a QA gate
   * that forwards instead of filters.
   */
  minReviewSeconds: number;
}

export const STAGES: StageDef[] = [
  { key: "development", label: "Development", reviewerRole: "developer", slaHours: 0, minReviewSeconds: 0 },
  { key: "qa", label: "QA (Allie)", reviewerRole: "qa", slaHours: 24, checklist: "web_build", minReviewSeconds: 120 },
  {
    key: "tech_review",
    label: "Tech Review (Diego)",
    reviewerRole: "tech_review",
    slaHours: 48,
    checklist: "web_build",
    minReviewSeconds: 180,
  },
  {
    key: "pre_launch",
    label: "Pre-Launch (Shane)",
    reviewerRole: "pre_launch",
    slaHours: 48,
    checklist: "web_build",
    minReviewSeconds: 120,
  },
];

export const STAGE_ORDER = STAGES.map((s) => s.key);

export function stageByKey(key: string): StageDef | undefined {
  return STAGES.find((s) => s.key === key);
}

export function nextStage(key: string): StageDef | undefined {
  const i = STAGE_ORDER.indexOf(key);
  return i >= 0 ? STAGES[i + 1] : undefined;
}

/**
 * Stages cannot be skipped. Advancing is only legal to the immediate next
 * stage — jumping from QA to Pre-Launch is refused, which is the whole point.
 */
export function canAdvance(from: string, to: string): { ok: boolean; reason?: string } {
  const fromIndex = STAGE_ORDER.indexOf(from);
  const toIndex = STAGE_ORDER.indexOf(to);
  if (fromIndex < 0) return { ok: false, reason: `unknown current stage "${from}"` };
  if (toIndex < 0) return { ok: false, reason: `unknown target stage "${to}"` };
  if (toIndex === fromIndex) return { ok: false, reason: "already at that stage" };
  if (toIndex < fromIndex) return { ok: false, reason: "work cannot move backwards through the chain" };
  if (toIndex > fromIndex + 1) {
    const skipped = STAGE_ORDER.slice(fromIndex + 1, toIndex);
    return { ok: false, reason: `cannot skip ${skipped.join(", ")} — every stage signs` };
  }
  return { ok: true };
}

/** Hours a stage has been sitting, for SLA checks. */
export function hoursSince(iso: string, now = Date.now()): number {
  return (now - Date.parse(iso)) / 3_600_000;
}
