// Anthropic Claude provider — backs the "balanced" (Haiku) and "deep"
// (Sonnet) tiers.
//
// Uses fetch directly rather than the @anthropic-ai/sdk so we don't pull
// Node-only dependencies into the Workers bundle. The npm package stays
// in dependencies for shared types and a future opt-in.

import type { Env } from "../../env";
import type {
  CompleteRequest,
  CompleteResponse,
  Provider,
  StreamChunk,
} from "../types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicNonStreamResponse {
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements Provider {
  readonly name: string;

  constructor(
    private readonly env: Env,
    private readonly model: string,
  ) {
    this.name = `anthropic:${model}`;
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const res = await this.post({
      model: this.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature,
      system: req.system,
      messages: this.toAnthropic(req.messages),
    });

    if (!res.ok) {
      throw new Error(`anthropic_${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as AnthropicNonStreamResponse;
    const text = json.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    return {
      text,
      model: this.model,
      tier: req.tier ?? "balanced",
      inputTokens: json.usage.input_tokens,
      outputTokens: json.usage.output_tokens,
    };
  }

  async *stream(req: CompleteRequest): AsyncIterable<StreamChunk> {
    const res = await this.post({
      model: this.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature,
      system: req.system,
      messages: this.toAnthropic(req.messages),
      stream: true,
    });

    if (!res.ok || !res.body) {
      yield {
        type: "error",
        error: `anthropic_${res.status}: ${await res.text()}`,
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as {
            type: string;
            delta?: { type?: string; text?: string };
          };
          if (evt.type === "content_block_delta" && evt.delta?.text) {
            yield { type: "text", text: evt.delta.text };
          }
        } catch {
          // ignore malformed event
        }
      }
    }
    yield { type: "done" };
  }

  private post(body: unknown): Promise<Response> {
    return fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  }

  private toAnthropic(
    messages: { role: string; content: string }[],
  ): AnthropicMessage[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));
  }
}
