import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { Router, type RouterProviders } from "../../src/ai/router";
import type {
  CompleteRequest,
  CompleteResponse,
  Provider,
  Tier,
} from "../../src/ai/types";

// P6 item 4: tiered routing logic. Workers AI (fast) and the Anthropic HTTP
// endpoint (balanced/deep) are not reachable under the test pool, so we inject
// stub providers via the RouterProviders seam and assert (a) the auto-tier
// selection cascade and (b) the fail-over behaviour when a tier throws.

const testEnv = env as unknown as Env;

// A stub provider that records its calls and either returns a tagged response
// or throws, per construction.
class StubProvider implements Provider {
  readonly name: string;
  calls: CompleteRequest[] = [];
  constructor(
    private readonly tierName: Tier,
    private readonly mode: "ok" | "throw" = "ok",
  ) {
    this.name = `stub:${tierName}`;
  }
  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    this.calls.push(req);
    if (this.mode === "throw") {
      throw new Error(`stub_${this.tierName}_down`);
    }
    return {
      text: `handled-by-${this.tierName}`,
      model: this.name,
      tier: this.tierName,
    };
  }
}

function routerWith(providers: RouterProviders): {
  router: Router;
  fast: StubProvider;
  balanced: StubProvider;
  deep: StubProvider;
} {
  const fast = (providers.fast as StubProvider) ?? new StubProvider("fast");
  const balanced =
    (providers.balanced as StubProvider) ?? new StubProvider("balanced");
  const deep = (providers.deep as StubProvider) ?? new StubProvider("deep");
  return {
    router: new Router(testEnv, { fast, balanced, deep }),
    fast,
    balanced,
    deep,
  };
}

const shortMsg = "hello"; // tiny prompt → fast
const midMsg = "x".repeat(2000); // > FAST_MAX_CHARS(800), <= 4000 → balanced
const bigMsg = "y".repeat(5000); // > BALANCED_MAX_CHARS(4000) → deep

describe("router — auto-tier selection", () => {
  it("routes a small prompt to fast", async () => {
    const { router, fast, balanced, deep } = routerWith({
      fast: new StubProvider("fast"),
      balanced: new StubProvider("balanced"),
      deep: new StubProvider("deep"),
    });
    const res = await router.complete({
      messages: [{ role: "user", content: shortMsg }],
    });
    expect(res.text).toBe("handled-by-fast");
    expect(fast.calls).toHaveLength(1);
    expect(balanced.calls).toHaveLength(0);
    expect(deep.calls).toHaveLength(0);
  });

  it("routes a mid-sized prompt to balanced", async () => {
    const { router, fast, balanced, deep } = routerWith({
      fast: new StubProvider("fast"),
      balanced: new StubProvider("balanced"),
      deep: new StubProvider("deep"),
    });
    const res = await router.complete({
      messages: [{ role: "user", content: midMsg }],
    });
    expect(res.text).toBe("handled-by-balanced");
    expect(fast.calls).toHaveLength(0);
    expect(balanced.calls).toHaveLength(1);
    expect(deep.calls).toHaveLength(0);
  });

  it("routes a large prompt to deep", async () => {
    const { router, fast, balanced, deep } = routerWith({
      fast: new StubProvider("fast"),
      balanced: new StubProvider("balanced"),
      deep: new StubProvider("deep"),
    });
    const res = await router.complete({
      messages: [{ role: "user", content: bigMsg }],
    });
    expect(res.text).toBe("handled-by-deep");
    expect(fast.calls).toHaveLength(0);
    expect(balanced.calls).toHaveLength(0);
    expect(deep.calls).toHaveLength(1);
  });

  it("honours an explicit tier over the auto heuristic", async () => {
    const { router, fast, deep } = routerWith({
      fast: new StubProvider("fast"),
      balanced: new StubProvider("balanced"),
      deep: new StubProvider("deep"),
    });
    // Small prompt would auto-pick fast; explicit deep must win.
    const res = await router.complete({
      messages: [{ role: "user", content: shortMsg }],
      tier: "deep",
    });
    expect(res.text).toBe("handled-by-deep");
    expect(deep.calls).toHaveLength(1);
    expect(fast.calls).toHaveLength(0);
  });
});

describe("router — fail-over cascade", () => {
  it("escalates fast → balanced when fast throws", async () => {
    const { router, fast, balanced, deep } = routerWith({
      fast: new StubProvider("fast", "throw"),
      balanced: new StubProvider("balanced"),
      deep: new StubProvider("deep"),
    });
    const res = await router.complete({
      messages: [{ role: "user", content: shortMsg }],
    });
    expect(res.text).toBe("handled-by-balanced");
    expect(fast.calls).toHaveLength(1);
    expect(balanced.calls).toHaveLength(1);
    expect(deep.calls).toHaveLength(0);
  });

  it("escalates fast → balanced → deep when both cheaper tiers throw", async () => {
    const { router, fast, balanced, deep } = routerWith({
      fast: new StubProvider("fast", "throw"),
      balanced: new StubProvider("balanced", "throw"),
      deep: new StubProvider("deep"),
    });
    const res = await router.complete({
      messages: [{ role: "user", content: shortMsg }],
    });
    expect(res.text).toBe("handled-by-deep");
    expect(fast.calls).toHaveLength(1);
    expect(balanced.calls).toHaveLength(1);
    expect(deep.calls).toHaveLength(1);
  });

  it("starting at balanced never falls back to fast", async () => {
    const { router, fast, balanced, deep } = routerWith({
      fast: new StubProvider("fast"),
      balanced: new StubProvider("balanced", "throw"),
      deep: new StubProvider("deep"),
    });
    const res = await router.complete({
      messages: [{ role: "user", content: shortMsg }],
      tier: "balanced",
    });
    expect(res.text).toBe("handled-by-deep");
    expect(fast.calls).toHaveLength(0); // fast is below the start tier
    expect(balanced.calls).toHaveLength(1);
    expect(deep.calls).toHaveLength(1);
  });

  it("rethrows the last error when every tier in the cascade fails", async () => {
    const { router } = routerWith({
      fast: new StubProvider("fast", "throw"),
      balanced: new StubProvider("balanced", "throw"),
      deep: new StubProvider("deep", "throw"),
    });
    await expect(
      router.complete({ messages: [{ role: "user", content: shortMsg }] }),
    ).rejects.toThrow("stub_deep_down");
  });
});
