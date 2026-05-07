import { describe, expect, it } from "vitest";
import { findParser, parseContent } from "../../src/ingest/parsers/index.js";
import { parsePdf } from "../../src/ingest/parsers/pdf.js";
import { parseOffice } from "../../src/ingest/parsers/office.js";
import { parseHtml } from "../../src/ingest/parsers/html.js";
import { parsePlainText } from "../../src/ingest/parsers/plain-text.js";

describe("parser dispatch", () => {
	it("routes text/plain to plain-text parser", () => {
		expect(findParser("text/plain")).toBe(parsePlainText);
		expect(findParser("text/markdown")).toBe(parsePlainText);
	});

	it("routes text/html to the HTML parser, NOT the OneNote one", () => {
		expect(findParser("text/html")).toBe(parseHtml);
	});

	it("routes the OneNote sentinel to the OneNote parser", () => {
		expect(findParser("application/vnd.arcadia.onenote+html")).not.toBe(parseHtml);
	});

	it("routes PDF mime types to the PDF parser", () => {
		expect(findParser("application/pdf")).toBe(parsePdf);
		expect(findParser("application/x-pdf")).toBe(parsePdf);
	});

	it("routes Office mime types to the Office parser", () => {
		expect(findParser("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(parseOffice);
		expect(findParser("application/vnd.ms-excel")).toBe(parseOffice);
	});

	it("returns null for unknown mime", () => {
		expect(findParser("application/octet-stream")).toBeNull();
		expect(findParser(undefined)).toBeNull();
	});
});

describe("parsePdf heuristic", () => {
	it("extracts text from naive (Tj) operators", async () => {
		const fakePdf = "%PDF-1.4\n(Hello world) Tj\n(Second line) Tj\nendobj";
		const buf = new TextEncoder().encode(fakePdf).buffer as ArrayBuffer;
		const out = await parsePdf.parse(buf, "application/pdf");
		expect(out.text).toContain("Hello world");
		expect(out.text).toContain("Second line");
	});

	it("returns empty when no extractable text", async () => {
		const buf = new TextEncoder().encode("%PDF-1.4\n(no Tj here)").buffer as ArrayBuffer;
		const out = await parsePdf.parse(buf, "application/pdf");
		expect(out.text).toBe("");
	});
});

describe("parseHtml", () => {
	it("strips tags + extracts <title>", async () => {
		const html = "<html><head><title>Hello</title></head><body><p>World</p><script>bad();</script></body></html>";
		const out = await parseHtml.parse(html, "text/html");
		expect(out.text).toBe("Hello World");
		expect(out.title).toBe("Hello");
	});
});

describe("parseContent dispatch", () => {
	it("returns empty text when no parser matches", async () => {
		const out = await parseContent("data", "application/octet-stream");
		expect(out.text).toBe("");
	});
});
