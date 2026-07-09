import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider, anthropicUrl } from "../../src/ai/providers/anthropic";
import type { Env } from "../../src/env";

// Unit test (node env): fetch is stubbed. Verifies the messages endpoint the
// Anthropic provider POSTs to — the Cloudflare AI Gateway URL when BOTH
// CF_ACCOUNT_ID and AI_GATEWAY_ID are set, api.anthropic.com otherwise.

const DIRECT = "https://api.anthropic.com/v1/messages";

function env(overrides: Partial<Env> = {}): Env {
  return {
    ANTHROPIC_API_KEY: "sk-test",
    ...overrides,
  } as unknown as Env;
}

function stubFetch(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("anthropicUrl", () => {
  it("returns the direct URL when neither gateway var is set", () => {
    expect(anthropicUrl(env())).toBe(DIRECT);
  });

  it("returns the direct URL when only AI_GATEWAY_ID is set", () => {
    expect(anthropicUrl(env({ AI_GATEWAY_ID: "gw" }))).toBe(DIRECT);
  });

  it("returns the direct URL when only CF_ACCOUNT_ID is set", () => {
    expect(anthropicUrl(env({ CF_ACCOUNT_ID: "acct" }))).toBe(DIRECT);
  });

  it("returns the AI Gateway URL when both vars are set", () => {
    expect(anthropicUrl(env({ CF_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "gw" }))).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
    );
  });
});

describe("AnthropicProvider endpoint routing", () => {
  it("POSTs to the direct URL when the gateway is not configured", async () => {
    const { calls } = stubFetch();
    const p = new AnthropicProvider(env(), "claude-haiku");
    await p.complete({ messages: [{ role: "user", content: "yo" }] });
    expect(calls).toEqual([DIRECT]);
  });

  it("POSTs to the AI Gateway URL when both vars are set", async () => {
    const { calls } = stubFetch();
    const p = new AnthropicProvider(
      env({ CF_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "gw" }),
      "claude-haiku",
    );
    await p.complete({ messages: [{ role: "user", content: "yo" }] });
    expect(calls).toEqual([
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
    ]);
  });
});
