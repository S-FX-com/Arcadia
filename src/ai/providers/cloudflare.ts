// Cloudflare Workers AI provider — backs the "fast" tier (Gemma 4 26B).
// Free for small prompts.

import type { Env } from "../../env";
import type {
  CompleteRequest,
  CompleteResponse,
  Provider,
} from "../types";

export class CloudflareProvider implements Provider {
  readonly name: string;

  constructor(private readonly env: Env) {
    this.name = `cloudflare:${env.CF_AI_DEFAULT_MODEL ?? "gemma-4-26b"}`;
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const model =
      this.env.CF_AI_DEFAULT_MODEL ?? "@cf/google/gemma-4-26b-a4b-it";
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      ...req.messages,
    ];

    const result = (await this.env.AI.run(model, {
      messages,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature,
    })) as { response?: string };

    return {
      text: result.response ?? "",
      model,
      tier: req.tier ?? "fast",
    };
  }
}
