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
import { runResearchCycle, prepareQuestionsForDelivery } from "./research/autoresearch.js";
import { serveApp } from "./webapp/static.js";
import { handleWebappAPI } from "./webapp/api.js";
import { runUserReportCron } from "./intelligence/user-reports.js";
import { handleClientIndexCron } from "./intelligence/client-indexer.js";
import { serveStoredImage } from "./ai/image.js";
import { runProcedureEvolution, updateUserIntelligence, getActiveUsers } from "./intelligence/learning-loop.js";
import type { Env, GraphNotificationPayload, TeamsActivity } from "./types.js";
import { features } from "./features.js";

// ─── HTTP Request Handler ─────────────────────────────────────────────────────

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);

	// Health check
	if (url.pathname === "/health" && request.method === "GET") {
		return new Response(JSON.stringify({ status: "ok", service: "arcadia", phase: 2 }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	// Generated image serving — short-lived KV blobs
	const imgMatch = url.pathname.match(/^\/api\/image\/([a-f0-9-]{36})$/);
	if (imgMatch && imgMatch[1] && request.method === "GET") {
		const img = await serveStoredImage(imgMatch[1], env);
		if (img) return img;
		return new Response("Image not found or expired", { status: 404 });
	}

	// Bot Framework webhook
	if (url.pathname === "/api/messages" && request.method === "POST") {
		return handleBotWebhook(request, env, ctx);
	}

	// Graph change notification webhook (Phase 2)
	if (url.pathname === "/api/graph/notifications" && request.method === "POST") {
		return handleGraphNotification(request, env, ctx);
	}

	// Phase 7: Webapp routes (SSO chat interface)
	if (features.webapp(env)) {
		// Serve the webapp SPA for /app and all /app/* paths (including /app/auth/callback)
		if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
			return serveApp(request, env);
		}
		// Webapp API endpoints
		if (url.pathname.startsWith("/api/webapp/")) {
			return handleWebappAPI(request, url, env, ctx);
		}
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
			} else if (type === "research") {
				await handleResearchCron(env);
			} else if (type === "user-reports") {
				await handleUserReportCron(env);
			} else if (type === "client-index") {
				await handleClientIndexRefreshCron(env);
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

	// Derive public worker URL for bot-side deep links (e.g. webapp auth gate).
	const reqUrl = new URL(request.url);
	const workerUrl = `${reqUrl.protocol}//${reqUrl.host}`;

	// Use waitUntil so Teams gets 200 OK immediately; heavy processing is async
	ctx.waitUntil(handleActivity(activity, env, workerUrl));

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
		if (features.memoryConsolidation(env)) {
			await runDeepConsolidation(env);
		}
	} catch (err) {
		console.error("[Arcadia] Deep consolidation failed:", err);
	}

	// 6. Phase 4: Heartbeat — memory health + proactive opportunity scan
	try {
		if (features.memory(env)) {
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
		if (features.memory(env)) {
			const pruned = await pruneExpiredMemories(env);
			if (pruned > 0) console.log(`[Arcadia] Pruned ${pruned} expired memories.`);
		}
	} catch (err) {
		console.error("[Arcadia] Memory pruning failed:", err);
	}

	// 8. Phase 7: Prune expired webapp sessions
	try {
		if (features.webapp(env)) {
			const { pruneExpiredSessions } = await import("./webapp/auth.js");
			const pruned = await pruneExpiredSessions(env);
			if (pruned > 0) console.log(`[Arcadia] Pruned ${pruned} expired webapp sessions.`);
		}
	} catch (err) {
		console.error("[Arcadia] Webapp session pruning failed:", err);
	}

	console.log("[Arcadia] Daily cron complete.");
}

async function handleWeeklyCron(env: Env): Promise<void> {
	console.log("[Arcadia] Weekly cron started:", new Date().toISOString());

	const channels = await getAllChannels(env);

	if (!features.weeklyReport(env)) {
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

	// Phase 11: Update user intelligence profiles for all active users
	if (features.learningLoop(env)) {
		try {
			const activeUsers = await getActiveUsers(env, 7);
			for (const u of activeUsers) {
				await updateUserIntelligence(u.userId, env).catch((e) =>
					console.error(`[Phase11] Intelligence update failed for ${u.userId}:`, e),
				);
			}
			console.log(`[Arcadia] User intelligence updated for ${activeUsers.length} users.`);
		} catch (err) {
			console.error("[Arcadia] User intelligence update batch failed:", err);
		}
	}

	// Phase 4: REM synthesis — weekly behavioral trends + team insights
	try {
		if (features.memoryConsolidation(env)) {
			await runREMSynthesis(env);
		}
	} catch (err) {
		console.error("[Arcadia] REM synthesis failed:", err);
	}

	// Phase 4: Self-model update — Arcadia reflects on what she has learned
	try {
		if (features.memory(env)) {
			await updateSelfModel(env);
		}
	} catch (err) {
		console.error("[Arcadia] Self-model update failed:", err);
	}

	console.log("[Arcadia] Weekly cron complete.");
}

async function handleMorningBriefCron(env: Env): Promise<void> {
	if (!features.morningBrief(env)) {
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
		if (features.memoryConsolidation(env)) {
			await runLightConsolidation(env);
		}
	} catch (err) {
		console.error("[Arcadia] Light consolidation (morning) failed:", err);
	}

	console.log("[Arcadia] Morning brief cron complete.");
}

async function handleEveningWrapupCron(env: Env): Promise<void> {
	if (!features.eveningWrapup(env)) {
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
		if (features.memoryConsolidation(env)) {
			await runLightConsolidation(env);
		}
	} catch (err) {
		console.error("[Arcadia] Light consolidation (evening) failed:", err);
	}

	console.log("[Arcadia] Evening wrap-up cron complete.");
}

// ─── Phase 5: Research cron ───────────────────────────────────────────────────

async function handleResearchCron(env: Env): Promise<void> {
	if (!features.autoresearch(env)) {
		console.log("[Arcadia] Autoresearch disabled via AUTORESEARCH_ENABLED.");
		return;
	}
	console.log("[Arcadia] Research cron started:", new Date().toISOString());

	try {
		const result = await runResearchCycle(env);
		if (result) {
			console.log(
				`[Arcadia] Research cycle complete: ${result.memoriesCreated} memories, ` +
				`${result.bridgesDetected} bridges, ${result.questionsGenerated} questions.`
			);
		}
	} catch (err) {
		console.error("[Arcadia] Research cycle failed:", err);
	}

	// Deliver pending research questions to Shane via DM
	try {
		const questionsToSend = await prepareQuestionsForDelivery(env);
		if (questionsToSend.length > 0) {
			// To send DMs to Shane, we need the admin user's conversation reference.
			// Questions are stored and marked as 'asked' — they'll be delivered
			// the next time Shane interacts with Arcadia or via the proactive DM path.
			console.log(`[Arcadia] ${questionsToSend.length} research questions prepared for Shane.`);
		}
	} catch (err) {
		console.error("[Arcadia] Research question delivery failed:", err);
	}

	console.log("[Arcadia] Research cron complete.");
}

async function handleUserReportCron(env: Env): Promise<void> {
	console.log("[Arcadia] User report cron started:", new Date().toISOString());
	try {
		await runUserReportCron(env);
	} catch (err) {
		console.error("[Arcadia] User report cron failed:", err);
	}
	console.log("[Arcadia] User report cron complete.");
}

async function handleClientIndexRefreshCron(env: Env): Promise<void> {
	if (!features.clientIndex(env)) {
		console.log("[Arcadia] Client indexing disabled via CLIENT_INDEX_ENABLED.");
		return;
	}
	console.log("[Arcadia] Client index refresh cron started:", new Date().toISOString());
	// Run client index and procedure evolution in parallel
	await Promise.allSettled([
		handleClientIndexCron(env),
		features.learningLoop(env)
			? runProcedureEvolution(env).catch((err) =>
					console.error("[Arcadia] Procedure evolution failed:", err),
				)
			: Promise.resolve(),
	]);
	console.log("[Arcadia] Client index refresh cron complete.");
}

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
	// Route by cron expression string (Wrangler passes it in event.cron)
	// "0 8  * * *"   → daily digest + stale detection + nudge + subscription renewal
	// "0 8  * * 1"   → weekly report (Monday)
	// "0 12 * * 1-5" → morning brief (~7am ET, Mon–Fri)
	// "0 21 * * 1-5" → evening wrap-up (~5pm EDT, Mon–Fri)
	// "0 14 * * 1-5" → research cycle 1 (~9am ET, Mon–Fri)
	// "0 18 * * 1-5" → research cycle 2 (~1pm ET, Mon–Fri)
	// "0 22 * * 1-5" → research cycle 3 (~5pm ET, Mon–Fri)
	// "30 2 * * 1-5"  → research cycle 4 (overnight, Mon–Fri)
	// "0 * * * *"     → hourly: per-user report delivery (Phase 9)
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
		case "0 14 * * 1-5":
		case "0 18 * * 1-5":
		case "0 22 * * 1-5":
		case "30 2 * * 1-5":
			await handleResearchCron(env);
			break;
		case "0 * * * *":
			await handleUserReportCron(env);
			break;
		case "0 */6 * * *":
			await handleClientIndexRefreshCron(env);
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
