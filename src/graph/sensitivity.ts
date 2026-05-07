// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Sensitivity-label redaction (Phase 3f)
//
// Microsoft Information Protection (MIP) labels expose a free-form
// `name` on each protected artifact. Tenants standardise on labels
// like "Public" / "General" / "Confidential" / "Highly Confidential" /
// "Restricted". This module classifies any label string into one of
// four levels and applies a redaction policy at recall time:
//
//   public    → no redaction
//   internal  → no redaction (visible to authenticated users)
//   sensitive → excerpt only (first 280 chars + redaction notice)
//   secret    → fully redacted (placeholder body + label name only)
//
// Tenants with custom labels can override the mapping via the
// SENSITIVITY_LABEL_MAP env var (JSON: { "<label>": "<level>" }).
//
// The classifier is pure; the recall integration in long-term.ts +
// search-documents tool fetches the document row and passes its
// label through redactContent() before returning to the model.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";

export type SensitivityLevel = "public" | "internal" | "sensitive" | "secret";

const DEFAULT_MAP: Record<string, SensitivityLevel> = {
	"public": "public",
	"general": "internal",
	"internal": "internal",
	"confidential": "sensitive",
	"sensitive": "sensitive",
	"highly confidential": "secret",
	"restricted": "secret",
	"secret": "secret",
	"top secret": "secret",
};

const SENSITIVE_EXCERPT_CHARS = 280;

function loadOverrides(env: Env): Record<string, SensitivityLevel> {
	const raw = (env as Env & { SENSITIVITY_LABEL_MAP?: string }).SENSITIVITY_LABEL_MAP;
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as Record<string, string>;
		const out: Record<string, SensitivityLevel> = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (v === "public" || v === "internal" || v === "sensitive" || v === "secret") {
				out[k.toLowerCase()] = v;
			}
		}
		return out;
	} catch {
		return {};
	}
}

export function classifyLabel(label: string | null | undefined, env: Env): SensitivityLevel {
	if (!label) return "internal"; // No label → treated as ordinary tenant data.
	const overrides = loadOverrides(env);
	const key = label.toLowerCase().trim();
	return overrides[key] ?? DEFAULT_MAP[key] ?? "internal";
}

/**
 * Redact a content string according to the level. Returns both the
 * redacted text and a flag indicating whether redaction happened, so
 * the caller can attach a citation note for the user.
 */
export function redactContent(content: string, level: SensitivityLevel): { content: string; redacted: boolean } {
	switch (level) {
		case "public":
		case "internal":
			return { content, redacted: false };
		case "sensitive": {
			const excerpt = content.slice(0, SENSITIVE_EXCERPT_CHARS);
			const note = content.length > SENSITIVE_EXCERPT_CHARS
				? `${excerpt}…\n\n[REDACTED — sensitive content; ${content.length - SENSITIVE_EXCERPT_CHARS} more characters not shown]`
				: content;
			return { content: note, redacted: content.length > SENSITIVE_EXCERPT_CHARS };
		}
		case "secret":
			return {
				content: "[REDACTED — content marked as secret/highly-confidential. Citation provided; ask the document owner for access.]",
				redacted: true,
			};
	}
}

export const SENSITIVITY_INTERNALS = {
	DEFAULT_MAP,
	SENSITIVE_EXCERPT_CHARS,
};
