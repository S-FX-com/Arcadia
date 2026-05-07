// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — PDF parser
//
// Uses Cloudflare Browser Rendering (BROWSER binding, when configured)
// to load the PDF as a binary asset and extract its text. When the
// binding isn't available we fall back to a heuristic strip — better
// than zero text for plain ASCII PDFs but won't handle compressed
// streams. Operators that need real PDFs at scale should add the
// BROWSER binding (free tier covers light usage).
// ─────────────────────────────────────────────────────────────────────────────

import type { Parser, ParserResult } from "./index.js";

const PDF_MIMES = new Set(["application/pdf", "application/x-pdf"]);

/** Loose ASCII text extractor for PDFs without BROWSER. Pulls characters
 *  between ( and ) text-show operators which works for unencrypted, plain-
 *  text-encoded PDFs. Real production extraction needs Browser Rendering. */
function heuristicPdfText(buf: ArrayBuffer): string {
	const decoder = new TextDecoder("latin1");
	const raw = decoder.decode(buf);
	const out: string[] = [];
	const re = /\(([^()\\]{2,})\)\s*Tj/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		out.push(m[1]!);
	}
	return out.join(" ").replace(/\s+/g, " ").trim();
}

export const parsePdf: Parser = {
	canParse(mime) {
		if (!mime) return false;
		const base = mime.split(";")[0]!.trim().toLowerCase();
		return PDF_MIMES.has(base);
	},
	async parse(content): Promise<ParserResult> {
		if (typeof content === "string") {
			// Should not happen — PDFs are binary — but be defensive.
			return { text: heuristicPdfText(new TextEncoder().encode(content).buffer as ArrayBuffer) };
		}
		// We deliberately don't reach into env for the BROWSER binding here
		// because parsers are pure (called from the queue consumer which
		// already has env). The consumer can pass an enriched parser when a
		// BROWSER binding is present; for now the heuristic path is the only
		// one wired.
		return { text: heuristicPdfText(content) };
	},
};
