// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — swallow(): structured catch handler for fire-and-forget paths
//
// Use when you want to keep a fallback value on failure but DO NOT want
// silent errors. Replaces `.catch(() => [])` and friends.
//
//   const cached = await load(...).catch(swallow(log, "cache_load_failed", []));
//   load(...).catch(swallow(log, "background_failed", undefined));   // fire-and-forget
// ─────────────────────────────────────────────────────────────────────────────

import type { Logger } from "./logger.js";

export function swallow<T>(
	log: Logger,
	event: string,
	fallback: T,
	fields?: Record<string, unknown>,
): (err: unknown) => T {
	return (err) => {
		log.warn(event, fields, err);
		return fallback;
	};
}

/** Use when the fallback should be re-evaluated on each failure. */
export function swallowWith<T>(
	log: Logger,
	event: string,
	makeFallback: () => T,
	fields?: Record<string, unknown>,
): (err: unknown) => T {
	return (err) => {
		log.warn(event, fields, err);
		return makeFallback();
	};
}
