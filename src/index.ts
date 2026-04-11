// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Main Cloudflare Worker Entry Point
//
// Routes:
//   POST /api/messages              → Bot Framework webhook (Teams activities)
//   POST /api/graph/notifications   → Microsoft Graph change notifications
//   GET  /health                    → Health check
//
// Cron triggers (wrangler.toml):
//   0 8  * * *    → Daily: digest + stale detection + nudge engine + sub renewal
//   0 8  * * 1    → Weekly (Monday): cross-channel operational report
//   0 12 * * 1-5  → Morning brief (≈7am ET / 12:00 UTC)
//   0 21 * * 1-5  → Evening wrap-up (≈5pm EDT / 21:00 UTC)
// ─────────────────────────────────────────────────────────────────────────────

import { verifyBotToken, unauthorizedResponse } from "./bot/auth.js";
import { handleActivity } from "./bot/handler.js";
import { getAllChannels } from "./memory/d1.js";
import { detectStaleThreads, formatStaleAlert } from "./intelligence/stale.js";
import { generateAndPostDigest } from "./intelligence/digest.js";
import { runNudgeEngine } from "./intelligence/nudge.js";
import { postWeeklyReport } from "./intelligence/weekly.js";
import { generateAndPostMorningBrief } from "./intelligence/morning.js";
import { generateAndPostEveningWrapup } from "./intelligence/evening.js";
import { validateNotificationRequest, processNotificationBatch, renewExpiringSubscriptions } from "./graph/subscriptions.js";
import { runLightConsolidation, runDeepConsolidation, runREMSynthesis } from "./memory/consolidation.js";
import { runHeartbeat, updateSelfModel } from "./intelligence/heartbeat.js";
import { pruneExpiredMemories } from "./memory/long-term.js";
import type { Env, GraphNotificationPayload, TeamsActivity } from "./types.js";

// ─── HTTP Request Handler ─────────────────────────────────────────────────────

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);

	// Health check
	if (url.pathname === "/health" && request.method === "GET") {
		return new Response(JSON.stringify({ status: "ok", service: "arcadia", phase: 2 }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	// Bot Framework webhook
	if (url.pathname === "/api/messages" && request.method === "POST") {
		return handleBotWebhook(request, env, ctx);
	}

	// Graph change notification webhook (Phase 2)
	if (url.pathname === "/api/graph/notifications" && request.method === "POST") {
		return handleGraphNotification(request, env, ctx);
	}

	if (url.pathname === "/internal/cron" && request.method === "POST") {
		const type = url.searchParams.get("type") ?? "daily";

		try {
			let ran = type;
			if (type === "weekly") {
				await handleWeeklyCron(env);
			} else if (type === "morning") {
				await handleMorningBriefCron(env);
			} else if (type === "evening") {
				await handleEveningWrapupCron(env);
			} else {
				await handleDailyCron(env);
				ran = "daily";
			}
			return new Response(JSON.stringify({ status: "ok", ran }), {
				headers: { "Content-Type": "application/json" },
			});
		} catch (err) {
			console.error("Manual cron trigger failed:", err);
			return new Response(JSON.stringify({ status: "error", error: String(err) }), {
				headers: { "Content-Type": "application/json" },
				status: 500,
			});
		}
	}

	return new Response("Not Found", { status: 404 });
}

// ─── Bot Framework webhook ────────────────────────────────────────────────────

async function handleBotWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// Verify JWT auth from Teams
	try {
		await verifyBotToken(request, env);
	} catch (err) {
		console.warn("Bot auth failed:", err);
		return unauthorizedResponse("Invalid or missing bot token");
	}

	// Parse activity
	let activity: TeamsActivity;
	try {
		activity = (await request.json()) as TeamsActivity;
	} catch {
		return new Response("Bad Request: invalid JSON", { status: 400 });
	}

	// Use waitUntil so Teams gets 200 OK immediately; heavy processing is async
	ctx.waitUntil(handleActivity(activity, env));

	return new Response(null, { status: 200 });
}

// ─── Graph change notifications (Phase 2) ─────────────────────────────────────

async function handleGraphNotification(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// Handle subscription validation handshake
	// Graph sends ?validationToken=<token> — must echo back as text/plain
	const validationResponse = validateNotificationRequest(request);
	if (validationResponse) return validationResponse;

	// Parse notification batch
	let payload: GraphNotificationPayload;
	try {
		payload = (await request.json()) as GraphNotificationPayload;
	} catch {
		return new Response("Bad Request: invalid JSON", { status: 400 });
	}

	if (!Array.isArray(payload.value) || payload.value.length === 0) {
		return new Response(null, { status: 202 });
	}

	// Process notifications asynchronously — respond 202 immediately
	ctx.waitUntil(processNotificationBatch(payload, env));

	return new Response(null, { status: 202 });
}

// ─── Scheduled Handler (Cron) ─────────────────────────────────────────────────

async function handleDailyCron(env: Env): Promise<void> {
	console.log("[Arcadia] Daily cron started:", new Date().toISOString());

	const channels = await getAllChannels(env);

	if (channels.length === 0) {
		console.log("[Arcadia] No registered channels — skipping daily tasks.");
		return;
	}

	const staleHours = parseInt(env.STALE_THREAD_HOURS ?? "48", 10);

	for (const channel of channels) {
		console.log(`[Arcadia] Processing: ${channel.channel_name} (${channel.channel_id})`);

		// 1. Stale thread detection
		try {
			const staleThreads = await detectStaleThreads(channel.team_id, channel.channel_id, staleHours, env);
			for (const stale of staleThreads) {
				console.log(`[Arcadia] Stale thread: ${formatStaleAlert(stale).slice(0, 80)}`);
				// Stale thread alerts are incorporated into the daily digest content
			}
		} catch (err) {
			console.error(`[Arcadia] Stale detection failed for ${channel.channel_id}:`, err);
		}

		// 2. Daily digest
		try {
			if (channel.service_url && channel.conversation_id) {
				await generateAndPostDigest(channel, channel.service_url, channel.conversation_id, env);
				console.log(`[Arcadia] Digest posted for ${channel.channel_name}`);
			} else {
				console.warn(`[Arcadia] No service URL for ${channel.channel_name} — skipping digest post`);
			}
		} catch (err) {
			console.error(`[Arcadia] Digest failed for ${channel.channel_id}:`, err);
		}
	}

	// 3. Nudge engine — scan all open tasks and nudge stalled/at-risk ones
	try {
		await runNudgeEngine(env);
	} catch (err) {
		console.error("[Arcadia] Nudge engine failed:", err);
	}

	// 4. Renew expiring Graph subscriptions
	try {
		await renewExpiringSubscriptions(env);
	} catch (err) {
		console.error("[Arcadia] Subscription renewal failed:", err);
	}

	// 5. Phase 4: Deep memory consolidation (pattern recognition + pruning)
	try {
		if (env.MEMORY_CONSOLIDATION_ENABLED === "true") {
			await runDeepConsolidation(env);
		}
	} catch (err) {
		console.error("[Arcadia] Deep consolidation failed:", err);
	}

	// 6. Phase 4: Heartbeat — memory health + proactive opportunity scan
	try {
		if (env.MEMORY_ENABLED === "true") {
			const health = await runHeartbeat(env);
			console.log(
				`[Arcadia] Heartbeat: ${health.totalMemories} memories.`,
				health.staleCategories.length > 0
					? `Stale categories: ${health.staleCategories.join(", ")}.`
					: "All memory categories active."
			);
		}
	} catch (err) {
		console.error("[Arcadia] Heartbeat failed:", err);
	}

	// 7. Phase 4: Prune expired memories
	try {
		if (env.MEMORY_ENABLED === "true") {
			const pruned = await pruneExpiredMemories(env);
			if (pruned > 0) console.log(`[Arcadia] Pruned ${pruned} expired memories.`);
		}
	} catch (err) {
		console.error("[Arcadia] Memory pruning failed:", err);
	}

	console.log("[Arcadia] Daily cron complete.");
}

async function handleWeeklyCron(env: Env): Promise<void> {
	console.log("[Arcadia] Weekly cron started:", new Date().toISOString());

	const channels = await getAllChannels(env);

	if (env.WEEKLY_REPORT_ENABLED !== "true") {
		console.log("[Arcadia] Weekly reports disabled via WEEKLY_REPORT_ENABLED.");
		return;
	}

	for (const channel of channels) {
		try {
			await postWeeklyReport(channel, env);
		} catch (err) {
			console.error(`[Arcadia] Weekly report failed for ${channel.channel_id}:`, err);
		}
	}

	// Phase 4: REM synthesis — weekly behavioral trends + team insights
	try {
		if (env.MEMORY_CONSOLIDATION_ENABLED === "true") {
			await runREMSynthesis(env);
		}
	} catch (err) {
		console.error("[Arcadia] REM synthesis failed:", err);
	}

	// Phase 4: Self-model update — Arcadia reflects on what she has learned
	try {
		if (env.MEMORY_ENABLED === "true") {
			await updateSelfModel(env);
		}
	} catch (err) {
		console.error("[Arcadia] Self-model update failed:", err);
	}

	console.log("[Arcadia] Weekly cron complete.");
}

async function handleMorningBriefCron(env: Env): Promise<void> {
	if (env.MORNING_BRIEF_ENABLED !== "true") {
		console.log("[Arcadia] Morning brief disabled via MORNING_BRIEF_ENABLED.");
		return;
	}
	console.log("[Arcadia] Morning brief cron started:", new Date().toISOString());

	const channels = await getAllChannels(env);
	for (const channel of channels) {
		try {
			await generateAndPostMorningBrief(channel, env);
		} catch (err) {
			console.error(`[Arcadia] Morning brief failed for ${channel.channel_id}:`, err);
		}
	}

	// Phase 4: Light memory consolidation (episodic → semantic)
	try {
		if (env.MEMORY_CONSOLIDATION_ENABLED === "true") {
			await runLightConsolidation(env);
		}
	} catch (err) {
		console.error("[Arcadia] Light consolidation (morning) failed:", err);
	}

	console.log("[Arcadia] Morning brief cron complete.");
}

async function handleEveningWrapupCron(env: Env): Promise<void> {
	if (env.EVENING_WRAPUP_ENABLED !== "true") {
		console.log("[Arcadia] Evening wrap-up disabled via EVENING_WRAPUP_ENABLED.");
		return;
	}
	console.log("[Arcadia] Evening wrap-up cron started:", new Date().toISOString());

	const channels = await getAllChannels(env);
	for (const channel of channels) {
		try {
			await generateAndPostEveningWrapup(channel, env);
		} catch (err) {
			console.error(`[Arcadia] Evening wrap-up failed for ${channel.channel_id}:`, err);
		}
	}

	// Phase 4: Light memory consolidation (episodic → semantic)
	try {
		if (env.MEMORY_CONSOLIDATION_ENABLED === "true") {
			await runLightConsolidation(env);
		}
	} catch (err) {
		console.error("[Arcadia] Light consolidation (evening) failed:", err);
	}

	console.log("[Arcadia] Evening wrap-up cron complete.");
}

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
	// Route by cron expression string (Wrangler passes it in event.cron)
	// "0 8  * * *"   → daily digest + stale detection + nudge + subscription renewal
	// "0 8  * * 1"   → weekly report (Monday)
	// "0 12 * * 1-5" → morning brief (~7am ET, Mon–Fri)
	// "0 21 * * 1-5" → evening wrap-up (~5pm EDT, Mon–Fri)
	switch (event.cron) {
		case "0 8 * * 1":
			await handleWeeklyCron(env);
			break;
		case "0 12 * * 1-5":
			await handleMorningBriefCron(env);
			break;
		case "0 21 * * 1-5":
			await handleEveningWrapupCron(env);
			break;
		default:
			// "0 8 * * *" and any unrecognised cron → daily
			await handleDailyCron(env);
			break;
	}
}

// ─── Worker Export ────────────────────────────────────────────────────────────

export default {
	fetch: handleRequest,
	// Use any types here to remain compatible with Wrangler/CF types at runtime
	scheduled: (event: any, env: Env, _ctx: any) => handleScheduled(event as any, env),
} as ExportedHandler<Env>;
