// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Result<T, E> helper
//
// Use this at internal boundaries where you want explicit error handling
// without throwing. At the HTTP boundary you still throw / return a Response.
// ─────────────────────────────────────────────────────────────────────────────

export type Result<T, E = Error> =
	| { ok: true; value: T }
	| { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}

/** Wrap a thunk that may throw into a Result. */
export async function tryAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
	try {
		return ok(await fn());
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
}

/** Unwrap a Result, throwing the error if not ok. */
export function unwrap<T, E>(r: Result<T, E>): T {
	if (r.ok) return r.value;
	throw r.error instanceof Error ? r.error : new Error(String(r.error));
}
