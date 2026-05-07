import type { Parser } from "./index.js";

/**
 * Strip HTML tags and decode the most common entities. Pulls a <title>
 * if present. Intended for SharePoint page bodies, mail HTML bodies,
 * generic web fragments — NOT for OneNote (use parseOneNoteHtml: it
 * carries section/page metadata in attributes we want to preserve).
 */
function stripTags(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export const parseHtml: Parser = {
	canParse(mime) {
		if (!mime) return false;
		const base = mime.split(";")[0]!.trim().toLowerCase();
		return base === "text/html" || base === "application/xhtml+xml";
	},
	async parse(content) {
		const html = typeof content === "string" ? content : new TextDecoder().decode(content);
		const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		const title = titleMatch ? stripTags(titleMatch[1] ?? "") : undefined;
		return {
			text: stripTags(html),
			...(title ? { title } : {}),
		};
	},
};
