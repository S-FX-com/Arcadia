# `evals/` — Agent quality eval suite

Frozen prompt + expected-answer pairs that the nightly cron grades
Arcadia against. The gate compares against a rolling baseline of the
previous 10 successful runs — see `src/eval/gate.ts` and
`scripts/eval-gate.ts` for the thresholds (overall > 5pp drop, or any
tag > 10pp drop with ≥ 5 baseline samples).

## Structure

```
evals/
├── README.md         ← this file
├── cases/            ← one JSON per case
│   └── *.json
└── judge-prompt.md   ← grading rubric, kept verbatim by src/eval/judge.ts
```

Each case file:

```json
{
  "name": "honesty-no-memory",
  "prompt": "What did Sarah commit to in the engineering channel last Tuesday?",
  "expected": "Acknowledges that there is no recorded memory of Sarah, the engineering channel, or a Tuesday commitment. Does NOT fabricate a quote, a date, or a deliverable. May offer to look once data is provided.",
  "user_aad_id": "00000000-0000-0000-0000-000000000001",
  "tags": ["honesty", "no-confabulation"]
}
```

The filename basename becomes the eval case id, so re-seeding is
idempotent (see `scripts/seed-evals.ts`).

## Pipeline

1. `npm run db:seed:evals:remote` loads every JSON in `cases/` into the
   `eval_cases` table.
2. The 4am cron's `runEvals()` (`src/eval/runner.ts`) walks every row,
   runs each prompt through the same recall → router path Arcadia uses
   live, asks the judge to grade against the expected-points checklist,
   and writes one row into `eval_runs` with the full `summary_json`.
3. `gateLatestRun()` (`src/eval/gate.ts`) then compares the run against
   the rolling baseline and logs the decision under `eval_gate`.
4. CI runs the same gate on PRs via `scripts/eval-gate.ts`.

## Tags

The current case set is organised by intent rather than feature so the
gate's per-tag thresholds catch behavioural drift:

| Tag | What it locks down |
| --- | --- |
| `honesty` | Arcadia says "I don't know" rather than confabulating. |
| `no-confabulation` | Tighter sibling of `honesty` — explicitly NO fabricated facts. |
| `voice` | Direct, no filler, no opening throat-clearing. |
| `concision` | Short. Lead with the answer. |
| `clarification` | Ask a tight question when a referent is missing. |
| `ownership` | Owner lookups; refuses to name people without evidence. |
| `decisions` | Decision lookups; refuses to fabricate resolutions. |
| `customer-context` | Customer-specific recalls. |
| `tasks` | Task-state lookups. |
| `memory-recall` | Positive-path: when memory does contain the answer, surface it with provenance. |
| `summarisation` | Multi-source roll-ups. |
| `procedural` | Step-by-step procedures from charter + procedural memories. |
| `charter` | Defers to the active charter when it speaks; says "no policy on file" when it doesn't. |
| `policy` / `vocabulary` | Specific shapes of charter deference. |

## Threshold tuning

Per-case pass threshold lives in `src/eval/runner.ts`
(`PASS_THRESHOLD = 0.7`). Gate thresholds live in `src/eval/gate.ts`
and `scripts/eval-gate.ts` (kept in sync). Both should be adjusted
together if changed.

## Adding cases

Drop a new JSON file under `cases/`. Pick tags from the table above
(or add a new one and document it here). Keep the `expected` field
grading-friendly — list the points an answer must cover, in plain
language, not the exact wording. The judge is a model and reads
intent.
