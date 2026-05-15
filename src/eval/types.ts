// Eval harness types.
//
// An eval case is a prompt + an expected-points checklist + optional
// tags + the AAD id we should pretend the question came from (so
// ACL-aware recall is exercised correctly).
//
// An eval run is one execution of a case-set against the live router.
// Each case produces a per-case score from the judge; the run-level
// pass_rate aggregates them.

export interface EvalCase {
  id: string;
  name: string;
  prompt: string;
  expected: string;
  userAadId?: string;
  tenantId?: string;
  scopeType?: string;
  scopeId?: string;
  tags?: string[];
}

export interface JudgeVerdict {
  score: number;
  rationale: string;
}

export interface CaseResult {
  caseId: string;
  caseName: string;
  prompt: string;
  reply: string;
  model: string;
  tier: string;
  score: number;
  rationale: string;
  passed: boolean;
  durationMs: number;
  tags?: string[];
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  pass_rate: number;
  model: string;
  passingThreshold: number;
  total: number;
  passed: number;
  failed: number;
  results: CaseResult[];
}
