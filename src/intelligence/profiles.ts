// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Profile Intelligence
//
// Builds and maintains user and customer profiles.
// Profile updates are designed to be non-blocking (fire-and-forget) so they
// never add latency to the response path.
// ─────────────────────────────────────────────────────────────────────────────

import { buildCustomerProfilePrompt, buildProfileInsightPrompt } from "../ai/prompts.js";
import { callAI } from "../ai/router.js";
import { loadUserProfile, saveUserProfile } from "../memory/kv.js";
import {
  getAllUserProfiles,
  getCustomerProfile,
  getUserProfile,
  saveUserInsights,
  upsertCustomerProfile,
  upsertUserProfile,
} from "../memory/d1.js";
import type {
  ChannelMessage,
  CustomerProfile,
  Env,
  ProfileInsights,
  TeamsActivity,
  UserProfile,
} from "../types.js";

// ─── User profile: hot-path update ───────────────────────────────────────────

/**
 * Upsert basic profile metrics for the sender of an activity.
 * Safe to call on every incoming message — runs fast (KV write + D1 upsert).
 * Triggers an async insight refresh every 20 messages.
 *
 * Call with `await` only if you need the profile back; otherwise fire-and-forget.
 */
export async function touchUserProfile(activity: TeamsActivity, env: Env): Promise<void> {
  const userId = activity.from.aadObjectId ?? activity.from.id;
  const now = new Date().toISOString();

  try {
    const existing = await loadUserProfile(userId, env);
    const teamId = activity.channelData?.team?.id ?? activity.channelData?.teamsTeamId;
    const profile: UserProfile = {
      userId,
      displayName: activity.from.name ?? userId,
      ...(teamId !== undefined && { teamId }),
      messageCount: (existing?.messageCount ?? 0) + 1,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      ...(existing?.insights !== undefined && { insights: existing.insights }),
      insightVersion: existing?.insightVersion ?? 0,
    };

    // Write to KV cache (fast) and D1 (persistent) in parallel
    await Promise.all([
      saveUserProfile(profile, env),
      upsertUserProfile(profile, env),
    ]);

    // Every 20 messages, refresh AI insights in the background
    if (profile.messageCount > 0 && profile.messageCount % 20 === 0) {
      refreshUserInsights(userId, profile, activity, env).catch((e) =>
        console.error("[Arcadia] Background insight refresh failed:", e)
      );
    }
  } catch (e) {
    console.error("[Arcadia] touchUserProfile failed:", e);
  }
}

// ─── User profile: AI insight refresh ────────────────────────────────────────

/**
 * Refresh AI-generated insights for a user.
 * Loads recent messages they've sent (from the activity's channel),
 * runs an AI analysis, and writes the result back to KV + D1.
 */
async function refreshUserInsights(
  userId: string,
  profile: UserProfile,
  activity: TeamsActivity,
  env: Env
): Promise<void> {
  try {
    const teamId = profile.teamId ?? "unknown";
    const channelId =
      activity.channelData?.teamsChannelId ??
      activity.channelData?.channel?.id ??
      activity.conversation.id;

    // Load channel messages and filter to this user's messages
    const { loadCachedMessages } = await import("../memory/kv.js");
    const allMessages = await loadCachedMessages(teamId, channelId, env);
    const userMessages = allMessages.filter((m) => m.authorId === userId).slice(0, 40);

    if (userMessages.length < 5) return; // Not enough data yet

    const { system, user } = buildProfileInsightPrompt(
      profile.displayName,
      userMessages,
      profile.insights ?? null
    );

    const response = await callAI(system, user, env);

    // Parse JSON response
    const raw = response.text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    const insights = JSON.parse(raw) as ProfileInsights;

    // Save updated insights to both stores
    const updatedProfile: UserProfile = { ...profile, insights, insightVersion: profile.insightVersion + 1 };
    await Promise.all([
      saveUserProfile(updatedProfile, env),
      saveUserInsights(userId, insights, env),
    ]);

    console.log(`[Arcadia] Profile insights refreshed for ${profile.displayName} (v${updatedProfile.insightVersion})`);
  } catch (e) {
    console.error("[Arcadia] refreshUserInsights error:", e);
  }
}

// ─── Customer profile: passive extraction ────────────────────────────────────

// Simple list of known organisation keywords to watch for.
// Expand this via configuration as needed.
const CUSTOMER_TRIGGER_PATTERNS: RegExp[] = [
  // Will match capitalized multi-word proper nouns that appear repeatedly.
  // We rely on AI extraction rather than static patterns for the actual work.
];

/**
 * Extract customer/organisation mentions from a batch of messages and
 * upsert the corresponding customer profiles.
 * Runs in the background — fire-and-forget from the message handler.
 */
export async function updateCustomerProfiles(
  messages: ChannelMessage[],
  env: Env
): Promise<void> {
  try {
    // Identify candidate customer names: capitalized words/phrases appearing ≥ 3 times
    const nounCounts = new Map<string, number>();
    for (const msg of messages) {
      // Match sequences of Title Case words (likely proper nouns / company names)
      const matches = msg.text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,3})\b/g) ?? [];
      for (const noun of matches) {
        // Skip common single words that are not company names
        if (/^(The|This|That|We|I|You|He|She|They|It|A|An|And|But|Or|For|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)$/.test(noun)) continue;
        if (noun.split(" ").length === 1 && noun.length < 4) continue;
        nounCounts.set(noun, (nounCounts.get(noun) ?? 0) + 1);
      }
    }

    // Only process nouns that appear at least 3 times
    const candidates = [...nounCounts.entries()]
      .filter(([, count]) => count >= 3)
      .map(([name]) => name)
      .slice(0, 5); // cap at 5 per batch

    for (const name of candidates) {
      const id = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const existing = await getCustomerProfile(id, env);

      // Get relevant messages that mention this entity
      const relevant = messages.filter((m) =>
        m.text.toLowerCase().includes(name.toLowerCase())
      );
      if (relevant.length === 0) continue;

      const { system, user } = buildCustomerProfilePrompt(name, relevant);
      const response = await callAI(system, user, env);
      const raw = response.text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");

      let ctx: { contacts?: string[]; topics?: string[]; sentiment?: string; recentContext?: string };
      try {
        ctx = JSON.parse(raw);
      } catch {
        continue;
      }

      const sentiment = (ctx.sentiment as CustomerProfile["sentiment"] | undefined) ?? existing?.sentiment;
      const recentContext = ctx.recentContext ?? existing?.recentContext;
      const profile: CustomerProfile = {
        id,
        name,
        mentionCount: (existing?.mentionCount ?? 0) + (nounCounts.get(name) ?? 1),
        contacts: ctx.contacts ?? existing?.contacts ?? [],
        topics: ctx.topics ?? existing?.topics ?? [],
        ...(sentiment !== undefined && { sentiment }),
        ...(recentContext !== undefined && { recentContext }),
        lastMentioned: new Date().toISOString(),
      };

      await upsertCustomerProfile(profile, env);
      console.log(`[Arcadia] Customer profile updated: ${name}`);
    }
  } catch (e) {
    console.error("[Arcadia] updateCustomerProfiles error:", e);
  }
}

// ─── Profile context for DM prompts ──────────────────────────────────────────

/**
 * Load a user's profile, trying KV first (fast) then D1 (authoritative).
 */
export async function resolveUserProfile(userId: string, env: Env): Promise<UserProfile | null> {
  const cached = await loadUserProfile(userId, env);
  if (cached) return cached;

  // Fallback to D1
  return getUserProfile(userId, env);
}

/**
 * Build a readable summary of all known user profiles in a team.
 * Used by admin-level cross-user queries.
 */
export async function buildTeamProfileSummary(teamId: string, env: Env): Promise<string> {
  const profiles = await getAllUserProfiles(teamId, env);
  if (profiles.length === 0) return "No user profiles have been built yet.";

  return profiles
    .map((p) => {
      const style = p.insights?.communicationStyle?.summary ?? "unknown style";
      const focus = p.insights?.focusAreas?.primary?.join(", ") ?? "unknown focus";
      const seen = p.lastSeen.slice(0, 10);
      return `- **${p.displayName}**: ${p.messageCount} messages, last active ${seen}. Style: ${style}. Focus: ${focus}.`;
    })
    .join("\n");
}
