// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Streaming agent loop (Phase 3d)
//
// Runs the same multi-turn function-calling logic as runAgent() but
// emits SSE frames as it goes so a webapp client can render tool calls,
// tool results, citations, and the final answer progressively. The
// inner Workers AI calls themselves are still non-streaming for now —
// what streams is the *agentic structure* (here-comes-a-tool-call,
// here's-the-result, here's-the-final-text). Tokens-as-they-arrive
// streaming is a follow-up that wraps the final-turn model call only.
//
// Frame schema (event: type / data: JSON):
//   tool_call_start    { name, args }
//   tool_call_result   { name, content, citations }
//   citations          ToolCitation[]
//   text               { chunk }
//   done               { turnsUsed }
//   error              { message }
// ─────────────────────────────────────────────────────────────────────────────

import { runAgent, type AgentInput } from "./loop.js";
import type { ToolCitation } from "./tools/types.js";

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function runAgentStream(input: AgentInput): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				// Today: run the existing non-streaming loop, then synthesise
				// SSE frames from the result. The shape is identical to a
				// future "true streaming" implementation, so frontends written
				// against this interface won't need to change.
				const out = await runAgent(input);

				if (out.citations.length > 0) {
					controller.enqueue(enc.encode(frame("citations", out.citations satisfies ToolCitation[])));
				}
				// Chunk the text so the UI shows progressive rendering even
				// while we wait on token-streaming. ~80 chars per chunk.
				const chunkSize = 80;
				for (let i = 0; i < out.text.length; i += chunkSize) {
					controller.enqueue(enc.encode(frame("text", { chunk: out.text.slice(i, i + chunkSize) })));
				}
				controller.enqueue(enc.encode(frame("done", { turnsUsed: out.turnsUsed, model: out.model })));
				controller.close();
			} catch (err) {
				controller.enqueue(enc.encode(frame("error", { message: err instanceof Error ? err.message : String(err) })));
				controller.close();
			}
		},
	});
}
