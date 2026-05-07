// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Eval cases (Phase 6)
//
// Bundled at build time so the Worker can read them at runtime. Mirror
// of evals/cases/*.json. When you add a new case JSON, mirror it here.
// (A small build script could automate this; deferred.)
// ─────────────────────────────────────────────────────────────────────────────

import type { EvalCase } from "./runner.js";

export const EVAL_CASES: EvalCase[] = [
	{
		name: "example-search-memory",
		prompt: "What do we know about the GNC client's billing setup?",
		expected: "References information that has been recorded in Arcadia's memory about GNC's billing — specific contacts, agreed terms, or any open issues. Cites the source channel/document.",
		user_aad_id: "00000000-0000-0000-0000-000000000001",
		tags: ["client-context", "memory-recall"],
	},
];
