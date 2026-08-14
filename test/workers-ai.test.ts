import { describe, expect, it } from "vitest";
import { workersAiComplete } from "../src/ai/workers-ai";

function envReturning(result: unknown, seen?: { input?: unknown }): Env {
  return {
    AI: {
      run: async (_model: string, input: unknown) => {
        if (seen) seen.input = input;
        return result;
      },
    },
  } as unknown as Env;
}

function envWith(response: unknown, seen?: { input?: unknown }): Env {
  return envReturning({ response }, seen);
}

const opts = { system: "s", prompt: "p", maxTokens: 256 };

describe("workersAiComplete", () => {
  it("passes a string response through unchanged", async () => {
    await expect(workersAiComplete(envWith("plain text"), "@cf/x", opts)).resolves.toBe("plain text");
  });

  it("re-serializes a structured response instead of dying on it", async () => {
    // A model honoring response_format.json_schema returns the parsed object,
    // not a string. Every §5.3 ingestion call passes a schema, so treating this
    // as text is what keeps the pipeline alive.
    const schemaOpts = { ...opts, jsonSchema: { type: "object" } };
    await expect(
      workersAiComplete(envWith({ memories: [{ content: "Rate locks yes, discounts no." }] }), "@cf/x", schemaOpts)
    ).resolves.toBe('{"memories":[{"content":"Rate locks yes, discounts no."}]}');
  });

  it("re-serializes a bare array response", async () => {
    await expect(workersAiComplete(envWith([1, 2]), "@cf/x", opts)).resolves.toBe("[1,2]");
  });

  it("reads the OpenAI chat-completions envelope the gpt-oss family returns", async () => {
    // The whole balanced tier defaults to @cf/openai/gpt-oss-120b, which
    // answers in `choices`, not `response`. Missing this makes Ask Arcadia,
    // Hermes drafting and every digest fail as "empty response".
    const env = envReturning({
      choices: [{ message: { content: "Rate locks yes, discounts no.", reasoning: "scratchpad" } }],
    });
    await expect(workersAiComplete(env, "@cf/openai/gpt-oss-120b", opts)).resolves.toBe(
      "Rate locks yes, discounts no."
    );
  });

  it("never returns the reasoning scratchpad as the answer", async () => {
    const env = envReturning({ choices: [{ message: { content: "", reasoning: "internal thinking" } }] });
    await expect(workersAiComplete(env, "@cf/openai/gpt-oss-120b", opts)).rejects.toThrow("empty response");
  });

  it("prefers a non-empty response field over choices", async () => {
    const env = envReturning({ response: "direct", choices: [{ message: { content: "other" } }] });
    await expect(workersAiComplete(env, "@cf/x", opts)).resolves.toBe("direct");
  });

  it("falls through to choices when response is an empty string", async () => {
    const env = envReturning({ response: "", choices: [{ message: { content: "from choices" } }] });
    await expect(workersAiComplete(env, "@cf/x", opts)).resolves.toBe("from choices");
  });

  it("names the envelope keys when nothing usable arrives", async () => {
    await expect(workersAiComplete(envReturning({ id: "x", usage: {} }), "@cf/x", opts)).rejects.toThrow(
      /keys: id, usage/
    );
  });

  it("still rejects a genuinely empty response", async () => {
    await expect(workersAiComplete(envWith(""), "@cf/x", opts)).rejects.toThrow("empty response");
    await expect(workersAiComplete(envWith("   "), "@cf/x", opts)).rejects.toThrow("empty response");
  });

  it("sends the schema as response_format when one is supplied", async () => {
    const seen: { input?: unknown } = {};
    await workersAiComplete(envWith("ok", seen), "@cf/x", { ...opts, jsonSchema: { type: "object" } });
    expect((seen.input as { response_format?: { type: string } }).response_format?.type).toBe("json_schema");
  });
});
