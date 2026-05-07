// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Document parser dispatch (Phase 3)
//
// One Parser per source MIME / Graph resource. The ingest queue consumer
// looks up a parser by MIME type and calls parse() to get plain text +
// optional title; the chunker then splits the text into vector-sized
// chunks downstream.
//
// Parsers are deliberately thin — heavyweight binary formats (.docx,
// .xlsx, .pptx) defer to Graph's "convert to PDF" endpoint, then the
// PDF parser handles the result. That keeps Worker bundle size small.
// ─────────────────────────────────────────────────────────────────────────────

import { parseHtml } from "./html.js";
import { parsePlainText } from "./plain-text.js";
import { parseOneNoteHtml } from "./onenote.js";
import { parsePdf } from "./pdf.js";
import { parseOffice } from "./office.js";

export interface ParserResult {
	text: string;
	title?: string;
}

export interface Parser {
	canParse(mime: string | null | undefined): boolean;
	parse(content: ArrayBuffer | string, mime: string | null): Promise<ParserResult>;
}

const PARSERS: Parser[] = [parseOneNoteHtml, parseHtml, parsePlainText, parsePdf, parseOffice];

export function findParser(mime: string | null | undefined): Parser | null {
	for (const p of PARSERS) {
		if (p.canParse(mime)) return p;
	}
	return null;
}

/**
 * Convenience wrapper: pick a parser by mime, parse the body, return
 * empty result if no parser matches.
 */
export async function parseContent(content: ArrayBuffer | string, mime: string | null): Promise<ParserResult> {
	const parser = findParser(mime);
	if (!parser) return { text: "" };
	return parser.parse(content, mime);
}

export { parseHtml } from "./html.js";
export { parsePlainText } from "./plain-text.js";
export { parseOneNoteHtml } from "./onenote.js";
export { parsePdf } from "./pdf.js";
export { parseOffice } from "./office.js";
