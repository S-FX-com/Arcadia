// ─────────────────────────────────────────────────────────────────────────────
// Arcadia Phase 2 — Proactive Nudge Engine
//
// Runs from the daily cron. Scans all open tasks, identifies stalled or
// at-risk ones, and posts contextual nudge messages to Teams channels.
//
// Rate limiting: KV key `nudge:{taskId}` with TTL = cooldown hours.
// Priority: deadline-24h > no-owner > no-progress > deadline-48h
// Cap: NUDGE_MAX_PER_RUN nudges per cron run to avoid spam bursts.
// ─────────────────────────────────────────────────────────────────────────────

import { callAI } from "../ai/router.js";
import { buildNudgePrompt } from "../ai/prompts.js";
import { getAllChannels } from "../memory/d1.js";
import { getTasksNeedingNudge, getTasksDueWithin, recordNudgeSent } from "../tasks/store.js";
import type { ChannelRow, Env, NudgeCandidate, NudgeReason, TaskRow } from "../types.js";

// ─── KV rate limiting ─────────────────────────────────────────────────────────

function nudgeKey(taskId: string): string {
	return `nudge:${taskId}`;
}

/**
 * Returns true if this task has been nudged within the cooldown window.
 * The KV key's TTL IS the cooldown — no additional logic needed.
 */
export async function isNudgeRateLimited(taskId: string, env: Env): Promise<boolean> {
	const val = await env.ARCADIA_CACHE.get(nudgeKey(taskId));
	return val !== null;
}

/**
 * Mark a task as "recently nudged" by writing a KV key with the cooldown TTL.
 * Also updates the D1 nudge_count and last_nudge_at.
 */
export async function markNudgeSent(taskId: string, cooldownHours: number, env: Env): Promise<void> {
	await Promise.all([
		env.ARCADIA_CACHE.put(nudgeKey(taskId), new Date().toISOString(), {
			expirationTtl: cooldownHours * 3600,
		}),
		recordNudgeSent(taskId, env),
	]);
}

// ─── Candidate classification ─────────────────────────────────────────────────

const URGENCY_RANK: Record<NudgeReason, number> = {
	"deadline-24h": 0,
	"no-owner": 1,
	"no-progress": 2,
	"deadline-48h": 3,
};

/**
 * Classify tasks into NudgeCandidates with urgency ranking.
 * A task may match multiple reasons — we keep the highest priority one.
 */
export function buildNudgeCandidates(staleTasks: TaskRow[], dueSoonTasks: TaskRow[]): NudgeCandidate[] {
	const now = Math.floor(Date.now() / 1000);
	const H24 = 24 * 3600;
	const H48 = 48 * 3600;

	const byId = new Map<string, NudgeCandidate>();

	function upsert(task: TaskRow, reason: NudgeReason, urgency: NudgeCandidate["urgency"]): void {
		const existing = byId.get(task.id);
		if (!existing || URGENCY_RANK[reason] < URGENCY_RANK[existing.reason]) {
			byId.set(task.id, { task, reason, urgency });
		}
	}

	// Deadline-based classification
	for (const task of dueSoonTasks) {
		if (!task.deadline) continue;
		const hoursLeft = (task.deadline - now) / 3600;
		if (hoursLeft <= 24) {
			upsert(task, "deadline-24h", "high");
		} else {
			upsert(task, "deadline-48h", "medium");
		}
	}

	// Stale / no-owner classification
	for (const task of staleTasks) {
		if (!task.owner_id && !task.owner_name) {
			upsert(task, "no-owner", "medium");
		} else {
			upsert(task, "no-progress", "low");
		}
	}

	// Sort by urgency rank
	return Array.from(byId.values()).sort((a, b) => URGENCY_RANK[a.reason] - URGENCY_RANK[b.reason]);
}

// ─── Message building ─────────────────────────────────────────────────────────

/**
 * AI-generated contextual nudge message.
 * Falls back to the static formatter if AI fails.
 */
export async function buildNudgeMessage(candidate: NudgeCandidate, env: Env): Promise<string> {
	const { task, reason } = candidate;
	const hoursSince = task.last_nudge_at
		? Math.floor((Date.now() / 1000 - task.last_nudge_at) / 3600)
		: Math.floor((Date.now() / 1000 - task.detected_at) / 3600);

	const { system, user } = buildNudgePrompt(task, reason, hoursSince, "en");

	try {
		const response = await callAI(system, user, env);
		return response.text;
	} catch {
		return buildStaticNudge(candidate);
	}
}

/** Fast static fallback nudge — no AI required. */
export function buildStaticNudge(candidate: NudgeCandidate): string {
	const { task, reason } = candidate;
	const owner = task.owner_name ? `**${task.owner_name}**` : "the team";

	const lines: string[] = [`**Task needs attention:** _${task.description}_`];

	switch (reason) {
		case "no-owner":
			lines.push(`No owner assigned. Use \`@Arcadia assign ${task.description} to [name]\` to claim it.`);
			break;
		case "no-progress":
			lines.push(`Assigned to ${owner} — no updates in a while. Check in when you can.`);
			break;
		case "deadline-24h":
			lines.push(`Due in less than 24 hours. ${owner} — please confirm status or flag if blocked.`);
			break;
		case "deadline-48h":
			lines.push(`Deadline approaching in ~48 hours. ${owner} — check if on track.`);
			break;
	}

	return lines.join("\n");
}

// ─── Proactive posting ────────────────────────────────────────────────────────

/**
 * Post a nudge message to a Teams channel via Bot Framework proactive messaging.
 */
async function postNudgeToChannel(channel: ChannelRow, text: string, env: Env): Promise<void> {
	if (!channel.service_url || !channel.conversation_id) {
		console.warn(`[Arcadia/Nudge] No service URL for ${channel.channel_id} — skipping proactive post`);
		return;
	}

	// Get Bot Framework bearer token (use tenant-specific endpoint)
	const tokenRes = await fetch(`https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "client_credentials",
			client_id: env.TEAMS_APP_ID,
			client_secret: env.TEAMS_APP_PASSWORD,
			scope: "https://api.botframework.com/.default",
		}).toString(),
	});
	if (!tokenRes.ok) {
		const err = await tokenRes.text();
		console.error("[Arcadia/Nudge] Bot token fetch failed:", tokenRes.status, err);
		return;
	}
	const { access_token } = (await tokenRes.json()) as { access_token: string };

	const url = `${channel.service_url.replace(/\/$/, "")}/v3/conversations/${channel.conversation_id}/activities`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${access_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			type: "message",
			text,
			textFormat: "markdown",
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		console.error("[Arcadia/Nudge] Post failed:", res.status, body);
		try {
			const parsed = JSON.parse(body);
			if (res.status === 403 && parsed?.error?.message?.includes("BotNotInConversationRoster")) {
				console.warn(`[Arcadia/Nudge] Bot not in conversation roster for ${channel.channel_id}, unregistering channel.`);
				const { unregisterChannel } = await import("../memory/d1.js");
				await unregisterChannel(channel.team_id, channel.channel_id, env);
			}
		} catch {
			// ignore parse errors
		}
	}
}

// ─── Main engine entry point ──────────────────────────────────────────────────

/**
 * Run the full nudge sweep across all registered channels.
 * Called from the daily cron handler in src/index.ts.
 */
export async function runNudgeEngine(env: Env): Promise<void> {
	const cooldownHours = parseInt(env.NUDGE_COOLDOWN_HOURS ?? "8", 10);
	const maxPerRun = parseInt(env.NUDGE_MAX_PER_RUN ?? "5", 10);
	const cooldownSeconds = cooldownHours * 3600;

	console.log(`[Arcadia/Nudge] Starting nudge engine (cooldown: ${cooldownHours}h, max: ${maxPerRun})`);

	// Fetch tasks needing nudges across all channels
	const [staleTasks, dueSoonTasks] = await Promise.all([getTasksNeedingNudge(cooldownSeconds, env), getTasksDueWithin(48, env)]);

	const candidates = buildNudgeCandidates(staleTasks, dueSoonTasks);
	const channels = await getAllChannels(env);

	// Build channel lookup by teamId:channelId
	const channelMap = new Map(channels.map((c) => [`${c.team_id}:${c.channel_id}`, c]));

	let sent = 0;

	for (const candidate of candidates) {
		if (sent >= maxPerRun) break;

		const { task } = candidate;

		// Rate limit check
		if (await isNudgeRateLimited(task.id, env)) {
			console.log(`[Arcadia/Nudge] Skipping ${task.id} (rate limited)`);
			continue;
		}

		const channel = channelMap.get(`${task.team_id}:${task.channel_id}`);
		if (!channel) {
			console.warn(`[Arcadia/Nudge] No channel record for task ${task.id}`);
			continue;
		}

		try {
			const message = await buildNudgeMessage(candidate, env);
			await postNudgeToChannel(channel, message, env);
			await markNudgeSent(task.id, cooldownHours, env);
			sent++;

			console.log(`[Arcadia/Nudge] Nudged task ${task.id} (${candidate.reason}): ${task.description.slice(0, 50)}`);
		} catch (err) {
			console.error(`[Arcadia/Nudge] Failed for task ${task.id}:`, err);
		}
	}

	console.log(`[Arcadia/Nudge] Complete. Sent ${sent} nudges.`);
}
