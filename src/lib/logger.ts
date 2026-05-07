// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Structured logger
//
// Emits one JSON object per log line so Logpush / `wrangler tail` produce
// machine-readable output. Always prefer this over bare console.* — it lets
// us correlate by requestId and filter by route/userId.
//
// Usage:
//   const log = createLogger({ requestId, route: "/api/webapp/chat", userId });
//   log.info("chat_request", { conversationId });
//   log.error("graph_call_failed", { resource }, err);
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerContext {
	requestId?: string;
	route?: string;
	userId?: string;
	[key: string]: unknown;
}

export interface Logger {
	debug(event: string, fields?: Record<string, unknown>): void;
	info(event: string, fields?: Record<string, unknown>): void;
	warn(event: string, fields?: Record<string, unknown>, err?: unknown): void;
	error(event: string, fields?: Record<string, unknown>, err?: unknown): void;
	child(extra: LoggerContext): Logger;
	withTiming<T>(event: string, fn: () => Promise<T>): Promise<T>;
}

function serializeError(err: unknown): { message: string; name?: string; stack?: string } {
	if (err instanceof Error) {
		const out: { message: string; name?: string; stack?: string } = { message: err.message };
		if (err.name) out.name = err.name;
		if (err.stack) out.stack = err.stack;
		return out;
	}
	if (typeof err === "string") return { message: err };
	try {
		return { message: JSON.stringify(err) };
	} catch {
		return { message: String(err) };
	}
}

function emit(level: LogLevel, ctx: LoggerContext, event: string, fields?: Record<string, unknown>, err?: unknown): void {
	const record: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level,
		event,
		...ctx,
		...(fields ?? {}),
	};
	if (err !== undefined) record.error = serializeError(err);

	const line = safeStringify(record);
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "log_serialize_failed" });
	}
}

export function createLogger(ctx: LoggerContext = {}): Logger {
	return {
		debug(event, fields) { emit("debug", ctx, event, fields); },
		info(event, fields) { emit("info", ctx, event, fields); },
		warn(event, fields, err) { emit("warn", ctx, event, fields, err); },
		error(event, fields, err) { emit("error", ctx, event, fields, err); },
		child(extra) { return createLogger({ ...ctx, ...extra }); },
		async withTiming(event, fn) {
			const start = Date.now();
			try {
				const out = await fn();
				emit("info", ctx, event, { latencyMs: Date.now() - start, ok: true });
				return out;
			} catch (err) {
				emit("error", ctx, event, { latencyMs: Date.now() - start, ok: false }, err);
				throw err;
			}
		},
	};
}

/** Generate a short request id for correlation. */
export function newRequestId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
