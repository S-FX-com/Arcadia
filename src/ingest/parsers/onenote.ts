import type { Parser } from "./index.js";

/**
 * OneNote pages from /me/onenote/pages/{id}/content come back as HTML
 * with absent images and inline data attributes. Strip aggressively to
 * plain text but keep paragraph breaks for the chunker.
 */
function stripOneNote(html: string): string {
	return html
		.replace(/<img[^>]*>/gi, "")
		.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+/g, " ")
		.trim();
}

export const parseOneNoteHtml: Parser = {
	canParse(mime) {
		// Graph's onenote/pages endpoint returns text/html. Callers that know
		// the source resource is OneNote should forward this parser explicitly
		// rather than rely on MIME alone — that's why this returns false for
		// generic text/html (parseHtml handles those).
		return mime === "application/vnd.arcadia.onenote+html";
	},
	async parse(content) {
		const html = typeof content === "string" ? content : new TextDecoder().decode(content);
		return { text: stripOneNote(html) };
	},
};
