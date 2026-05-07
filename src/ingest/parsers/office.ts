// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Office (.docx, .xlsx, .pptx) parser
//
// Office Open XML files are zip archives. Rather than ship a zip parser
// in the worker bundle, we route Office documents through Microsoft
// Graph's `/content?format=pdf` conversion at producer time and let the
// PDF parser handle the result. This parser therefore only handles the
// edge case where an Office MIME type made it through to the consumer
// — it returns an empty result and logs a warning. The producer layer
// is the right place to add the format=pdf hop.
// ─────────────────────────────────────────────────────────────────────────────

import type { Parser } from "./index.js";

const OFFICE_MIMES = new Set([
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
]);

export const parseOffice: Parser = {
	canParse(mime) {
		if (!mime) return false;
		const base = mime.split(";")[0]!.trim().toLowerCase();
		return OFFICE_MIMES.has(base);
	},
	async parse(_content, mime) {
		console.warn(
			`[parseOffice] received ${mime} content. Producers should request ` +
			`"?format=pdf" from Graph and route through the PDF parser instead.`,
		);
		return { text: "" };
	},
};
