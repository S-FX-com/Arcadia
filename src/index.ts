// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Main Cloudflare Worker Entry Point
//
// Handles:
//   POST /api/messages  → Bot Framework webhook (Teams activities)
//   GET  /health        → Health check
//   Cron trigger        → Daily digest + stale thread detection
// ─────────────────────────────────────────────────────────────────────────────

import { verifyBotToken, unauthorizedResponse } from "./bot/auth.js";
import { handleActivity } from "./bot/handler.js";
import { getAllChannels } from "./memory/d1.js";
import { detectStaleThreads, formatStaleAlert } from "./intelligence/stale.js";
import { generateAndPostDigest } from "./intelligence/digest.js";
import type { Env, TeamsActivity } from "./types.js";

// ─── HTTP Request Handler ─────────────────────────────────────────────────────

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Health check
  if (url.pathname === "/health" && request.method === "GET") {
    return new Response(JSON.stringify({ status: "ok", service: "arcadia" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Bot Framework webhook
  if (url.pathname === "/api/messages" && request.method === "POST") {
    return handleBotWebhook(request, env);
  }

  return new Response("Not Found", { status: 404 });
}

async function handleBotWebhook(request: Request, env: Env): Promise<Response> {
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
    activity = await request.json() as TeamsActivity;
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400 });
  }

  // Process activity — respond 200 immediately, process async
  // Teams requires a response within 5 seconds; heavy processing happens async
  const ctx = { waitUntil: (_: Promise<unknown>) => {} };
  const processingPromise = handleActivity(activity, env);

  // In production this uses: ctx.waitUntil(processingPromise)
  // For now, await directly (Workers allow up to 30s CPU time)
  await processingPromise;

  return new Response(null, { status: 200 });
}

// ─── Scheduled Handler (Cron) ─────────────────────────────────────────────────

async function handleScheduled(env: Env): Promise<void> {
  console.log("[Arcadia] Running scheduled job:", new Date().toISOString());

  const channels = await getAllChannels(env);

  if (channels.length === 0) {
    console.log("[Arcadia] No registered channels — skipping digest.");
    return;
  }

  const staleHours = parseInt(env.STALE_THREAD_HOURS ?? "48", 10);

  for (const channel of channels) {
    console.log(
      `[Arcadia] Processing channel: ${channel.channel_name} (${channel.channel_id})`
    );

    // 1. Stale thread detection
    try {
      const staleThreads = await detectStaleThreads(
        channel.team_id,
        channel.channel_id,
        staleHours,
        env
      );

      if (staleThreads.length > 0) {
        console.log(
          `[Arcadia] Found ${staleThreads.length} stale threads in ${channel.channel_name}`
        );
        // Stale alerts are surfaced in the daily digest content
        for (const stale of staleThreads) {
          const alert = formatStaleAlert(stale);
          console.log("[Arcadia] Stale thread alert:", alert);
          // In production: post to channel via proactive messaging
          // (requires stored conversation reference from bot install)
        }
      }
    } catch (err) {
      console.error(
        `[Arcadia] Stale detection failed for ${channel.channel_id}:`,
        err
      );
    }

    // 2. Daily digest
    try {
      const today = new Date().toISOString().slice(0, 10);
      console.log(
        `[Arcadia] Generating digest for ${channel.channel_name} (${today})`
      );

      if (channel.service_url && channel.conversation_id) {
        await generateAndPostDigest(
          channel,
          channel.service_url,
          channel.conversation_id,
          env
        );
        console.log(`[Arcadia] Digest posted for ${channel.channel_name}`);
      } else {
        console.warn(
          `[Arcadia] No service URL/conversation ID for ${channel.channel_name} — skipping post`
        );
      }
    } catch (err) {
      console.error(
        `[Arcadia] Digest failed for ${channel.channel_id}:`,
        err
      );
    }
  }

  console.log("[Arcadia] Scheduled job complete.");
}

// ─── Worker Export ────────────────────────────────────────────────────────────

export default {
  fetch: handleRequest,
  scheduled: (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) =>
    handleScheduled(env),
} satisfies ExportedHandler<Env>;
