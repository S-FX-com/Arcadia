// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Agent loop (Phase 2)
//
// Multi-turn function-calling loop on Workers AI. Models that support
// OpenAI-style tools (llama-3.3-70b-instruct-fp8-fast,
// hermes-2-pro-mistral) are invoked with a tools[] array; tool_calls in
// the response are dispatched in parallel against the registry, results
// fed back into the next turn, until the model returns plain content or
// the turn cap is reached.
//
// Design choices:
//   • Stateless. Caller passes the conversation history; we return the
//     final assistant text + any accumulated citations. No DB writes
//     happen here — recordMemoriesFromInteraction stays the caller's job.
//   • Tool inputs are validated by zod inside each handler — bad
//     model output produces a structured error fed back to the model
//     instead of a thrown exception (the model can self-correct).
//   • Citations are accumulated across turns, deduped on
//     resourceType+resourceId, and returned alongside the final text
//     so the frontend can render them as source chips.
//   • ACL is enforced by tool handlers (which all receive ctx.userAadId);
//     the loop does not duplicate the check.
// ─────────────────────────────────────────────────────────────────────────────

import { runAI } from "../ai/gateway.js";
import { getModel } from "../ai/model-registry.js";
import { extractCFAIText } from "../ai/router.js";
import { createLogger } from "../lib/logger.js";
import type { Env } from "../types.js";
import { getTool, listTools } from "./tools/index.js";
import type { Tool, ToolCitation } from "./tools/types.js";

const log = createLogger({ component: "agent-loop" });

const DEFAULT_MAX_TURNS = 6;

/** A single message in the agent's conversation buffer. */
type AgentMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string; tool_calls?: ToolCallEcho[] }
	| { role: "tool"; content: string; tool_call_id: string; name: string };

interface ToolCallEcho {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface ModelToolCall {
	id?: string;
	name?: string;
	arguments?: unknown;
	function?: { name?: string; arguments?: unknown };
}

interface ModelResponseChoice {
	message?: { content?: string; tool_calls?: ModelToolCall[] };
}
interface CFToolModelResult {
	response?: string;
	choices?: ModelResponseChoice[];
	tool_calls?: ModelToolCall[];
}

export interface AgentInput {
	systemPrompt: string;
	userMessage: string;
	history?: Array<{ role: "user" | "assistant"; content: string }>;
	userAadId: string;
	userDisplayName?: string;
	env: Env;
	ctx?: ExecutionContext;
	maxTurns?: number;
}

export interface AgentOutput {
	text: string;
	citations: ToolCitation[];
	turnsUsed: number;
	model: string;
}

function toolToOpenAiSpec(tool: Tool): Record<string, unknown> {
	// zod-to-JSON-schema conversion is intentionally minimal here: we expose
	// each tool's name + description and rely on the model to follow the
	// "see schema in description" hint when arg validation is strict.
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
		},
	};
}

function dedupeCitations(citations: ToolCitation[]): ToolCitation[] {
	const seen = new Set<string>();
	const out: ToolCitation[] = [];
	for (const c of citations) {
		const key = `${c.resourceType}:${c.resourceId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(c);
	}
	return out;
}

function parseArgs(raw: unknown): unknown {
	if (typeof raw === "string") {
		try { return JSON.parse(raw); } catch { return {}; }
	}
	return raw ?? {};
}

function extractToolCalls(result: CFToolModelResult): ModelToolCall[] {
	const direct = result.tool_calls ?? result.choices?.[0]?.message?.tool_calls;
	return direct ?? [];
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
	const tools = listTools();
	const toolSpecs = tools.map(toolToOpenAiSpec);
	const config = getModel("agent-tool-use", input.env);
	const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;

	const messages: AgentMessage[] = [
		{ role: "system", content: input.systemPrompt },
		...(input.history ?? []).slice(-12).map((h) => ({ role: h.role, content: h.content })),
		{ role: "user", content: input.userMessage },
	];

	const citations: ToolCitation[] = [];
	let turn = 0;

	while (turn < maxTurns) {
		turn++;
		const result = await runAI(
			input.env,
			config.modelId as Parameters<Ai["run"]>[0],
			{
				messages,
				tools: toolSpecs,
				max_tokens: config.maxTokens,
			} as Parameters<Ai["run"]>[1],
		) as CFToolModelResult;

		const toolCalls = extractToolCalls(result);
		const text = extractCFAIText(result) ?? "";

		if (toolCalls.length === 0) {
			// Model returned plain content — done.
			log.info("agent_complete", { turnsUsed: turn, citationCount: citations.length });
			return { text: text || "(no response)", citations: dedupeCitations(citations), turnsUsed: turn, model: config.modelId };
		}

		// Echo the assistant turn (with tool_calls) into the buffer so the
		// next call sees the same protocol the model expects.
		messages.push({
			role: "assistant",
			content: text,
			tool_calls: toolCalls.map((tc, i) => ({
				id: tc.id ?? `call_${turn}_${i}`,
				type: "function",
				function: {
					name: tc.name ?? tc.function?.name ?? "unknown",
					arguments: typeof tc.arguments === "string"
						? tc.arguments
						: JSON.stringify(tc.arguments ?? tc.function?.arguments ?? {}),
				},
			})),
		});

		// Dispatch all tool calls in parallel.
		const dispatched = await Promise.all(
			toolCalls.map(async (call, i) => {
				const callId = call.id ?? `call_${turn}_${i}`;
				const name = call.name ?? call.function?.name ?? "";
				const tool = getTool(name);
				if (!tool) {
					return { callId, name, content: `Error: unknown tool "${name}".`, citations: [] as ToolCitation[] };
				}
				const args = parseArgs(call.arguments ?? call.function?.arguments);
				const parsed = tool.schema.safeParse(args);
				if (!parsed.success) {
					return {
						callId, name,
						content: `Error: invalid arguments for ${name}: ${JSON.stringify(parsed.error.issues)}`,
						citations: [] as ToolCitation[],
					};
				}
				try {
					const out = await tool.handler(parsed.data, {
						env: input.env,
						userAadId: input.userAadId,
						...(input.userDisplayName !== undefined && { userDisplayName: input.userDisplayName }),
						...(input.ctx !== undefined && { ctx: input.ctx }),
					});
					return { callId, name, content: out.content, citations: out.citations ?? [] };
				} catch (err) {
					log.warn("tool_handler_failed", { tool: name }, err);
					return { callId, name, content: `Error: ${err instanceof Error ? err.message : String(err)}`, citations: [] as ToolCitation[] };
				}
			}),
		);

		for (const d of dispatched) {
			messages.push({ role: "tool", tool_call_id: d.callId, name: d.name, content: d.content });
			citations.push(...d.citations);
		}
	}

	// Hit the turn cap; ask the model for a final synthesis without tools.
	const finalResult = await runAI(
		input.env,
		config.modelId as Parameters<Ai["run"]>[0],
		{
			messages: [
				...messages,
				{ role: "user", content: "Synthesize a final answer based on the tool results above. Do not call any more tools." },
			],
			max_tokens: config.maxTokens,
		} as Parameters<Ai["run"]>[1],
	) as CFToolModelResult;
	const finalText = extractCFAIText(finalResult) ?? "(no response after turn cap)";
	log.warn("agent_turn_cap_hit", { turnsUsed: turn, citationCount: citations.length });
	return { text: finalText, citations: dedupeCitations(citations), turnsUsed: turn, model: config.modelId };
}
