// ─────────────────────────────────────────────────────────────────────────────
// Arcadia web — Server-Sent Events POST helper
//
// EventSource() doesn't support POST, so we use fetch + a manual SSE
// parser. Yields { event, data } pairs as the worker emits them.
// ─────────────────────────────────────────────────────────────────────────────

export interface SseEvent {
	event: string;
	data: unknown;
}

export async function* postSse(url: string, body: unknown, init: RequestInit = {}): AsyncGenerator<SseEvent, void, unknown> {
	const res = await fetch(url, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json", "accept": "text/event-stream", ...(init.headers ?? {}) },
		credentials: "include",
		...init,
	});
	if (!res.ok || !res.body) {
		throw new Error(`SSE ${url} failed: ${res.status} ${res.statusText}`);
	}
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let idx;
		while ((idx = buf.indexOf("\n\n")) >= 0) {
			const block = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			let event = "message";
			let data = "";
			for (const line of block.split("\n")) {
				if (line.startsWith("event: ")) event = line.slice(7).trim();
				else if (line.startsWith("data: ")) data += line.slice(6);
			}
			let parsed: unknown = data;
			try { parsed = JSON.parse(data); } catch { /* keep raw */ }
			yield { event, data: parsed };
		}
	}
}
