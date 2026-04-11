// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Channel↔Chat Bridging Engine
//
// Detects when conversations cross boundaries between Teams channels and chats.
//
// Algorithm:
//   1. Extract topics and participants from each channel and chat
//   2. Build a participant overlap matrix
//   3. Detect topic overlap + participant overlap → candidate bridges
//   4. Score by (participant overlap × topic overlap × temporal proximity)
//   5. AI-confirm high-scoring candidates
//   6. Store confirmed bridges and generate memories
//
// This is the core innovation of the Autoresearch adaptation:
// making visible the invisible flow of context between public and private.
// ─────────────────────────────────────────────────────────────────────────────

import { extractKeywords } from "../memory/long-term.js";
import { callAI } from "../ai/router.js";
import { buildBridgeDetectionPrompt } from "../ai/prompts.js";
import type {
  ChannelMessage,
  ConversationBridge,
  ConversationBridgeRow,
  Env,
  TenantSnapshot,
  TopicSummary,
} from "../types.js";

// ─── Topic extraction ────────────────────────────────────────────────────────

/**
 * Extract topic summaries from a set of messages.
 * Groups messages by keyword clusters and identifies distinct topics.
 */
function extractTopics(messages: ChannelMessage[]): TopicSummary[] {
  if (messages.length === 0) return [];

  // Combine all message text and extract keywords
  const allText = messages.map((m) => m.text).join(" ");
  const keywordsStr = extractKeywords(allText);
  const keywords = keywordsStr.split(",").filter(Boolean);

  // Count keyword frequency to find dominant topics
  const keywordFreq = new Map<string, number>();
  for (const msg of messages) {
    const msgKeywords = new Set(extractKeywords(msg.text).split(",").filter(Boolean));
    for (const kw of msgKeywords) {
      keywordFreq.set(kw, (keywordFreq.get(kw) ?? 0) + 1);
    }
  }

  // Get top keywords (appearing in 2+ messages)
  const topKeywords = [...keywordFreq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([kw]) => kw);

  if (topKeywords.length === 0) return [];

  // Build participant list
  const participants = [...new Set(messages.map((m) => m.authorName))];

  const timestamps = messages.map((m) => m.timestamp).sort();

  return [
    {
      topic: topKeywords.slice(0, 3).join(", "),
      keywords: topKeywords,
      participants,
      messageCount: messages.length,
      firstSeen: timestamps[0] ?? "",
      lastSeen: timestamps[timestamps.length - 1] ?? "",
    },
  ];
}

// ─── Overlap detection ───────────────────────────────────────────────────────

/**
 * Calculate keyword overlap score between two keyword sets.
 * Returns 0.0–1.0.
 */
function keywordOverlap(setA: string[], setB: string[]): number {
  if (setA.length === 0 || setB.length === 0) return 0;
  const a = new Set(setA);
  let overlap = 0;
  for (const kw of setB) {
    if (a.has(kw)) overlap++;
  }
  return overlap / Math.max(a.size, setB.length);
}

/**
 * Calculate participant overlap between two participant lists.
 * Returns shared participant names and an overlap ratio.
 */
function participantOverlap(
  channelParticipants: string[],
  chatMembers: string[]
): { shared: string[]; ratio: number } {
  const channelSet = new Set(channelParticipants.map((p) => p.toLowerCase()));
  const shared = chatMembers.filter((m) => channelSet.has(m.toLowerCase()));
  const ratio = shared.length / Math.max(channelSet.size, chatMembers.length, 1);
  return { shared, ratio };
}

/**
 * Calculate temporal correlation between channel and chat activity.
 * Higher score when chat activity starts shortly after channel activity (or vice versa).
 * Returns 0.0–1.0.
 */
function temporalCorrelation(
  channelLastSeen: string,
  chatFirstSeen: string
): number {
  if (!channelLastSeen || !chatFirstSeen) return 0;
  const channelTime = new Date(channelLastSeen).getTime();
  const chatTime = new Date(chatFirstSeen).getTime();
  const gapHours = Math.abs(chatTime - channelTime) / (1000 * 60 * 60);

  // Within 4 hours → high correlation; decays linearly to 0 at 48 hours
  if (gapHours <= 4) return 1.0;
  if (gapHours >= 48) return 0;
  return 1.0 - (gapHours - 4) / 44;
}

// ─── Bridge detection ────────────────────────────────────────────────────────

/**
 * Detect conversation bridges in a tenant snapshot.
 *
 * For each (channel, chat) pair:
 *   1. Check participant overlap (must have ≥1 shared participant)
 *   2. Check keyword overlap (must be ≥0.15)
 *   3. Check temporal correlation
 *   4. Score = participantRatio × 0.3 + keywordOverlap × 0.4 + temporal × 0.3
 *   5. If score ≥ 0.25, candidate bridge
 *
 * Returns candidates sorted by score descending.
 */
export async function detectBridges(
  snapshot: TenantSnapshot,
  env: Env
): Promise<ConversationBridge[]> {
  const bridges: ConversationBridge[] = [];

  // Build topic data for each channel
  const channelTopics = new Map<string, { name: string; topics: TopicSummary[] }>();
  for (const team of snapshot.teams) {
    for (const channel of team.channels) {
      const messages = snapshot.channelMessages.get(channel.id);
      if (!messages || messages.length === 0) continue;
      channelTopics.set(channel.id, {
        name: channel.displayName,
        topics: extractTopics(messages),
      });
    }
  }

  // Build topic data for each chat
  const chatTopics = new Map<string, TopicSummary[]>();
  for (const chat of snapshot.chats) {
    const messages = snapshot.chatMessages.get(chat.id);
    if (!messages || messages.length === 0) continue;
    chatTopics.set(chat.id, extractTopics(messages));
  }

  // Compare each channel with each chat
  for (const [channelId, channelData] of channelTopics) {
    for (const chat of snapshot.chats) {
      const chatTopicList = chatTopics.get(chat.id);
      if (!chatTopicList || chatTopicList.length === 0) continue;

      // Participant overlap check
      const channelParticipants = channelData.topics.flatMap((t) => t.participants);
      const { shared, ratio: partRatio } = participantOverlap(channelParticipants, chat.members);
      if (shared.length === 0) continue;

      // Keyword overlap check
      const channelKeywords = channelData.topics.flatMap((t) => t.keywords);
      const chatKeywords = chatTopicList.flatMap((t) => t.keywords);
      const kwOverlap = keywordOverlap(channelKeywords, chatKeywords);
      if (kwOverlap < 0.15) continue;

      // Temporal correlation
      const channelLastSeen = channelData.topics.map((t) => t.lastSeen).sort().pop() ?? "";
      const chatFirstSeen = chatTopicList.map((t) => t.firstSeen).sort()[0] ?? "";
      const temporal = temporalCorrelation(channelLastSeen, chatFirstSeen);

      // Composite score
      const score = partRatio * 0.3 + kwOverlap * 0.4 + temporal * 0.3;
      if (score < 0.25) continue;

      // Shared topic keywords for the bridge
      const channelKwSet = new Set(channelKeywords);
      const sharedTopics = chatKeywords.filter((kw) => channelKwSet.has(kw));

      bridges.push({
        id: crypto.randomUUID(),
        channelId,
        channelName: channelData.name,
        chatId: chat.id,
        chatTopic: chat.topic,
        sharedParticipants: shared,
        sharedTopics: [...new Set(sharedTopics)],
        temporalCorrelation: temporal,
        overallScore: score,
        details: `Topic overlap: ${(kwOverlap * 100).toFixed(0)}%, ` +
          `Participant overlap: ${shared.length} shared (${(partRatio * 100).toFixed(0)}%), ` +
          `Temporal: ${(temporal * 100).toFixed(0)}%`,
      });
    }
  }

  // Sort by score descending, return top 10
  bridges.sort((a, b) => b.overallScore - a.overallScore);
  return bridges.slice(0, 10);
}

/**
 * AI-confirm a bridge candidate.
 * Uses a focused prompt to verify that the channel and chat are discussing the same topic.
 */
export async function confirmBridge(
  bridge: ConversationBridge,
  snapshot: TenantSnapshot,
  env: Env
): Promise<{ confirmed: boolean; details: string }> {
  const channelMsgs = snapshot.channelMessages.get(bridge.channelId) ?? [];
  const chatMsgs = snapshot.chatMessages.get(bridge.chatId) ?? [];

  // Get recent messages related to shared topics
  const topicKeywords = new Set(bridge.sharedTopics);
  const relevantChannelMsgs = channelMsgs
    .filter((m) => {
      const msgKws = new Set(extractKeywords(m.text).split(",").filter(Boolean));
      return [...topicKeywords].some((kw) => msgKws.has(kw));
    })
    .slice(-5);

  const relevantChatMsgs = chatMsgs
    .filter((m) => {
      const msgKws = new Set(extractKeywords(m.text).split(",").filter(Boolean));
      return [...topicKeywords].some((kw) => msgKws.has(kw));
    })
    .slice(-5);

  if (relevantChannelMsgs.length === 0 || relevantChatMsgs.length === 0) {
    return { confirmed: false, details: "Insufficient relevant messages for confirmation." };
  }

  const channelSnippet = relevantChannelMsgs
    .map((m) => `[${m.timestamp.slice(0, 16)}] ${m.authorName}: ${m.text.slice(0, 200)}`)
    .join("\n");

  const chatSnippet = relevantChatMsgs
    .map((m) => `[${m.timestamp.slice(0, 16)}] ${m.authorName}: ${m.text.slice(0, 200)}`)
    .join("\n");

  const { system, user } = buildBridgeDetectionPrompt(
    bridge.channelName,
    channelSnippet,
    chatSnippet,
    bridge.sharedParticipants
  );

  const response = await callAI(system, user, env);
  const text = response.text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    const result = JSON.parse(text) as { confirmed: boolean; details: string };
    return {
      confirmed: result.confirmed === true,
      details: result.details ?? "",
    };
  } catch {
    // If AI returns non-JSON, check for simple yes/no
    const lower = response.text.toLowerCase();
    return {
      confirmed: lower.includes('"confirmed": true') || lower.includes('"confirmed":true'),
      details: response.text.slice(0, 200),
    };
  }
}

// ─── Bridge persistence ──────────────────────────────────────────────────────

/**
 * Store a confirmed bridge in D1.
 */
export async function storeBridge(
  bridge: ConversationBridge,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO conversation_bridges
       (id, channel_id, channel_name, chat_id, chat_topic, shared_participants,
        shared_topics, temporal_correlation, overall_score, details,
        discovered_at, last_validated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      bridge.id,
      bridge.channelId,
      bridge.channelName,
      bridge.chatId,
      bridge.chatTopic,
      JSON.stringify(bridge.sharedParticipants),
      JSON.stringify(bridge.sharedTopics),
      bridge.temporalCorrelation,
      bridge.overallScore,
      bridge.details,
      now,
      now
    )
    .run();
}

/**
 * Get recent bridges from D1, sorted by score.
 */
export async function getRecentBridges(
  env: Env,
  limit = 10
): Promise<ConversationBridgeRow[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM conversation_bridges
     ORDER BY discovered_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<ConversationBridgeRow>();
  return result.results;
}

/**
 * Convert a bridge into a memory-worthy description.
 */
export function bridgeToMemoryContent(bridge: ConversationBridge): string {
  const participants = bridge.sharedParticipants.join(", ");
  const topics = bridge.sharedTopics.join(", ");
  const chatDesc = bridge.chatTopic ?? "a private chat";

  return (
    `Discussion about [${topics}] started in #${bridge.channelName} channel, ` +
    `then continued in ${chatDesc} between ${participants}. ` +
    `Correlation score: ${(bridge.overallScore * 100).toFixed(0)}%. ` +
    `Key decisions or context may exist in the chat that are not visible in the channel.`
  );
}

/**
 * Format bridges as readable text for Teams display.
 */
export function formatBridges(bridges: ConversationBridgeRow[]): string {
  if (bridges.length === 0) {
    return "No conversation bridges detected yet.";
  }

  const lines = bridges.map((b, i) => {
    const topics = b.shared_topics ? JSON.parse(b.shared_topics).join(", ") : "unknown";
    const participants = b.shared_participants ? JSON.parse(b.shared_participants).join(", ") : "unknown";
    const score = b.overall_score ? `${(b.overall_score * 100).toFixed(0)}%` : "—";
    const date = new Date((b.discovered_at ?? 0) * 1000).toISOString().slice(0, 10);
    return (
      `${i + 1}. **#${b.channel_name ?? b.channel_id}** ↔ **${b.chat_topic ?? "private chat"}**\n` +
      `   Topics: ${topics} | Participants: ${participants}\n` +
      `   Score: ${score} | Discovered: ${date}`
    );
  });

  return `**Conversation Bridges**\n\n${lines.join("\n\n")}`;
}
