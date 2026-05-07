// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Request validation helpers
//
// Thin wrappers around zod for parsing JSON request bodies and query params
// in webapp/api handlers. Keeps Phase 0 type-safety work behind one import.
// ─────────────────────────────────────────────────────────────────────────────

import type { ZodSchema } from "zod";

export class ValidationError extends Error {
	readonly issues: unknown;
	constructor(message: string, issues: unknown) {
		super(message);
		this.name = "ValidationError";
		this.issues = issues;
	}
}

export async function parseJsonBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		throw new ValidationError("Request body is not valid JSON", null);
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw new ValidationError("Request body failed validation", parsed.error.issues);
	}
	return parsed.data;
}

export function parseSearchParams<T>(url: URL, schema: ZodSchema<T>): T {
	const obj: Record<string, string> = {};
	url.searchParams.forEach((v, k) => { obj[k] = v; });
	const parsed = schema.safeParse(obj);
	if (!parsed.success) {
		throw new ValidationError("Query string failed validation", parsed.error.issues);
	}
	return parsed.data;
}

/** Render a ValidationError as a 400 JSON response. */
export function validationErrorResponse(err: ValidationError): Response {
	return new Response(
		JSON.stringify({ error: "validation_error", message: err.message, issues: err.issues }),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}
