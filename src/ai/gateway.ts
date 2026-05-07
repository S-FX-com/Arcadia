// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Workers AI gateway wrapper
//
// Routes env.AI.run() calls through a Cloudflare AI Gateway when the
// AI_GATEWAY_ID secret is set. AI Gateway gives us:
//   • request/response logging (free)
//   • automatic caching for matching prompts
//   • rate limits and budget caps per env
//   • request retries
//
// When AI_GATEWAY_ID is unset we transparently call env.AI.run() directly so
// nothing breaks in dev or before the gateway is provisioned.
//
// Use `runAI(env, model, options)` instead of `env.AI.run(model, options)`
// from new code. The legacy direct calls in src/ai/router.ts and elsewhere
// will be migrated incrementally.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";

type AiRunModel = Parameters<Ai["run"]>[0];
type AiRunOptions = Parameters<Ai["run"]>[1];
type AiRunResult = Awaited<ReturnType<Ai["run"]>>;

interface GatewayRunOptions {
	/** Optional cache TTL in seconds (passed to AI Gateway). */
	cacheTtl?: number;
	/** Optional per-request metadata attached to gateway logs. */
	metadata?: Record<string, string>;
	/** Skip the gateway even when AI_GATEWAY_ID is set. */
	skipGateway?: boolean;
}

export async function runAI(
	env: Env,
	model: AiRunModel,
	options: AiRunOptions,
	gatewayOptions: GatewayRunOptions = {},
): Promise<AiRunResult> {
	const gatewayId = (env as Env & { AI_GATEWAY_ID?: string }).AI_GATEWAY_ID;
	if (!gatewayId || gatewayOptions.skipGateway) {
		return env.AI.run(model, options);
	}

	// Cloudflare Workers AI accepts a third arg with gateway routing options.
	// Typed loosely to remain forward-compatible with workers-types updates.
	type GatewayConfig = {
		gateway: {
			id: string;
			cacheTtl?: number;
			metadata?: Record<string, string>;
		};
	};
	const gatewayConfig: GatewayConfig = {
		gateway: {
			id: gatewayId,
			...(gatewayOptions.cacheTtl !== undefined && { cacheTtl: gatewayOptions.cacheTtl }),
			...(gatewayOptions.metadata && { metadata: gatewayOptions.metadata }),
		},
	};
	return (env.AI.run as (m: AiRunModel, o: AiRunOptions, g: GatewayConfig) => Promise<AiRunResult>)(
		model,
		options,
		gatewayConfig,
	);
}
