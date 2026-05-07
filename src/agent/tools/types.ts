// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Agent tool registry types (Phase 2)
//
// Each tool exports a single Tool object. The agent loop validates inputs
// with the zod schema, dispatches to handler(), and threads the typed
// result back into the model. ctx.userAadId always carries the asking
// user's AAD id so tool handlers can reuse the Phase 1 ACL machinery.
// ─────────────────────────────────────────────────────────────────────────────

import type { ZodSchema } from "zod";
import type { Env } from "../../types.js";

/** Per-call execution context handed to every tool handler. */
export interface ToolContext {
	env: Env;
	/** AAD object id of the asking user. Required so tools can resolve the
	 *  user's principal set and apply ACL filtering on every read. */
	userAadId: string;
	/** Optional user display name for prompts that build human-readable output. */
	userDisplayName?: string;
	/** Worker invocation context, when available, for fire-and-forget tasks. */
	ctx?: ExecutionContext;
}

/** A single source-resource pointer the model can cite in its final answer. */
export interface ToolCitation {
	resourceType: string;
	resourceId: string;
	/** Human-readable label (channel name, document title, etc.). */
	label?: string;
	/** Deep-link the frontend can render. */
	url?: string;
}

export interface ToolResult {
	/** Free-form text or JSON the model will see in the next turn. */
	content: string;
	/** Source resources the model may cite. The agent loop accumulates
	 *  these across turns and surfaces them on the final response. */
	citations?: ToolCitation[];
}

export interface Tool<I = unknown> {
	/** Stable name used in the model's tool-call protocol. */
	name: string;
	/** One-line description shown to the model. */
	description: string;
	/** zod schema for the tool's input arguments. */
	schema: ZodSchema<I>;
	/** Handler. Receives validated input + ctx, returns a ToolResult. */
	handler: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}
