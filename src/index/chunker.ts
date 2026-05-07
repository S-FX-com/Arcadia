// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Document chunker (Phase 3)
//
// Recursive paragraph/sentence splitter targeting ~800 tokens per chunk
// with ~100 token overlap. Tokens are estimated as chars/4 (good enough
// for chunk sizing; not for billing). Pure function — no I/O.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_TOKENS = 800;
const OVERLAP_TOKENS = 100;
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

export interface Chunk {
	ordinal: number;
	content: string;
	tokenEstimate: number;
}

/** Split text on paragraph (double-newline), then sentence (.!?), then
 *  whitespace, then any character — preferring earlier separators. */
function recursiveSplit(text: string, separators: string[] = ["\n\n", "\n", ". ", " ", ""]): string[] {
	if (text.length <= TARGET_CHARS) return [text];
	const sep = separators[0] ?? "";
	const next = separators.slice(1);
	if (sep === "") {
		// Hard split — last resort.
		const out: string[] = [];
		for (let i = 0; i < text.length; i += TARGET_CHARS) {
			out.push(text.slice(i, i + TARGET_CHARS));
		}
		return out;
	}
	const parts = text.split(sep);
	const out: string[] = [];
	let buf = "";
	for (const p of parts) {
		const candidate = buf ? buf + sep + p : p;
		if (candidate.length <= TARGET_CHARS) {
			buf = candidate;
		} else if (p.length > TARGET_CHARS) {
			if (buf) out.push(buf);
			out.push(...recursiveSplit(p, next));
			buf = "";
		} else {
			if (buf) out.push(buf);
			buf = p;
		}
	}
	if (buf) out.push(buf);
	return out;
}

export function chunkText(text: string): Chunk[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const raw = recursiveSplit(trimmed);

	// Apply overlap by prepending the tail of the previous chunk.
	const out: Chunk[] = [];
	for (let i = 0; i < raw.length; i++) {
		const prev = i > 0 ? raw[i - 1]! : "";
		const overlap = prev.slice(Math.max(0, prev.length - OVERLAP_CHARS));
		const content = (i === 0 ? raw[i]! : `${overlap}\n\n${raw[i]!}`).trim();
		out.push({
			ordinal: i,
			content,
			tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
		});
	}
	return out;
}

export const CHUNKER_INTERNALS = {
	TARGET_TOKENS,
	OVERLAP_TOKENS,
	CHARS_PER_TOKEN,
};
