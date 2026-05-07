import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonBody, parseSearchParams, ValidationError, validationErrorResponse } from "../../src/lib/validate.js";

const ChatBody = z.object({ message: z.string().min(1), conversationId: z.string().optional() });

function jsonRequest(body: unknown): Request {
	return new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });
}

describe("validate", () => {
	it("parseJsonBody returns parsed data on valid input", async () => {
		const body = await parseJsonBody(jsonRequest({ message: "hi" }), ChatBody);
		expect(body.message).toBe("hi");
	});

	it("parseJsonBody throws ValidationError on bad JSON", async () => {
		await expect(parseJsonBody(jsonRequest("not-json"), ChatBody)).rejects.toBeInstanceOf(ValidationError);
	});

	it("parseJsonBody throws ValidationError on schema mismatch", async () => {
		await expect(parseJsonBody(jsonRequest({ message: "" }), ChatBody)).rejects.toBeInstanceOf(ValidationError);
	});

	it("parseSearchParams parses URL params", () => {
		const url = new URL("http://x/?limit=10&offset=5");
		const out = parseSearchParams(url, z.object({ limit: z.string(), offset: z.string() }));
		expect(out.limit).toBe("10");
		expect(out.offset).toBe("5");
	});

	it("validationErrorResponse renders 400 JSON", async () => {
		const r = validationErrorResponse(new ValidationError("bad", [{ path: ["x"], code: "x" }]));
		expect(r.status).toBe(400);
		const body = await r.json();
		expect(body).toMatchObject({ error: "validation_error" });
	});
});
