# `evals/` — Nightly agent quality evals

Frozen prompt + expected-answer pairs that the nightly cron grades the
agent against. A regression beyond the configured threshold blocks the
deploy that introduces it.

## Structure

```
evals/
├── README.md                  ← this file
├── cases/                     ← one JSON per eval case
│   └── *.json
├── judge-prompt.md            ← system prompt fed to the judge model
└── runner.ts                  ← invoked by the eval cron
```

Each case file:

```json
{
  "name": "summarise-gnc-status",
  "prompt": "Summarise the current GNC project status across all channels and docs I have access to.",
  "expected": "Mentions the open billing question with Jane, the Friday deadline, and the recent decision to defer phase 2.",
  "user_aad_id": "00000000-0000-0000-0000-000000000001",
  "tags": ["client-context", "multi-source"]
}
```

## Pipeline

1. The nightly cron loads every JSON in `cases/`.
2. For each case, it invokes `runAgent({ userMessage: prompt,
   userAadId, ... })` against the live Worker.
3. The agent's `text` is graded by Workers AI Llama-3.3-70b using the
   prompt in `judge-prompt.md`. The judge returns `{ score: 0.0-1.0,
   rationale: "..." }`.
4. Results are written to `eval_case_results`; the run summary lands in
   `eval_runs`.
5. CI/manual deploys read the latest run; a >5% drop in pass rate
   relative to the prior run blocks promotion.

## Threshold tuning

`EVAL_PASS_THRESHOLD` env var controls the minimum judge score for a
case to count as passed. Default 0.7. Lower for flaky multi-source
queries; raise for strict factual recall.
