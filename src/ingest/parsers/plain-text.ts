import type { Parser } from "./index.js";

const MIMES = new Set([
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/json",
	"application/xml",
	"text/xml",
]);

export const parsePlainText: Parser = {
	canParse(mime) {
		if (!mime) return false;
		const base = mime.split(";")[0]!.trim().toLowerCase();
		return MIMES.has(base);
	},
	async parse(content) {
		const text = typeof content === "string" ? content : new TextDecoder().decode(content);
		return { text: text.trim() };
	},
};
