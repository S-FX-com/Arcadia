// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Shared Response Formatters (Tier 4, Phase 2 restructure, numeral 12)
//
// Central helpers for building HTTP responses. Unifies the duplicated
// jsonResponse / errorResponse / unauthorizedResponse implementations that
// lived in src/webapp/middleware.ts, src/webapp/auth.ts and src/bot/auth.ts.
// ─────────────────────────────────────────────────────────────────────────────

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** Build a JSON Response with the given body and status. */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/** Build a JSON error response of the shape `{ error: message }`. */
export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/** 401 Unauthorized with a JSON error body. */
export function unauthorizedResponse(message = "Unauthorized"): Response {
  return errorResponse(message, 401);
}

/** 404 Not Found (plain text). */
export function notFoundResponse(message = "Not Found"): Response {
  return new Response(message, { status: 404 });
}

/** 400 Bad Request (plain text). */
export function badRequestResponse(message = "Bad Request"): Response {
  return new Response(message, { status: 400 });
}
