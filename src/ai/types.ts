// Shared types for the AI router and providers.

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

/**
 * Cost / capability tiers. The router picks the cheapest tier that can
 * handle a request, then cascades upward on error.
 *   - fast:     Cloudflare Workers AI (Gemma). Free.
 *   - balanced: Anthropic Claude Haiku. Low cost.
 *   - deep:     Anthropic Claude Sonnet. Higher quality, higher cost.
 */
export type Tier = "fast" | "balanced" | "deep";

export interface CompleteRequest {
  messages: Message[];
  system?: string;
  tier?: Tier;
  maxTokens?: number;
  temperature?: number;
}

export interface CompleteResponse {
  text: string;
  model: string;
  tier: Tier;
  inputTokens?: number;
  outputTokens?: number;
}

export interface StreamChunk {
  type: "text" | "done" | "error";
  text?: string;
  error?: string;
}

export interface Provider {
  readonly name: string;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
  stream?(req: CompleteRequest): AsyncIterable<StreamChunk>;
}
