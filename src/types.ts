// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Shared TypeScript Types
// ─────────────────────────────────────────────────────────────────────────────

// Cloudflare Workers environment bindings
export interface Env {
  // KV namespace — rolling message cache, summaries, token cache
  ARCADIA_CACHE: KVNamespace;
  // D1 database — threads, ownership, digest log
  ARCADIA_DB: D1Database;
  // Workers AI binding
  AI: Ai;

  // Secrets
  TEAMS_APP_ID: string;
  TEAMS_APP_PASSWORD: string;
  GRAPH_TENANT_ID: string;
  GRAPH_CLIENT_ID: string;
  GRAPH_CLIENT_SECRET: string;
  ANTHROPIC_API_KEY: string;

  // Vars (from wrangler.toml [vars])
  STALE_THREAD_HOURS: string;
  MAX_MESSAGES_CACHED: string;
  DIGEST_CRON_HOUR: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Teams / Bot Framework
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamsActivity {
  type: string;
  id: string;
  timestamp: string;
  channelId: string;
  from: TeamsAccount;
  conversation: TeamsConversation;
  recipient: TeamsAccount;
  text?: string;
  textFormat?: string;
  attachments?: TeamsAttachment[];
  channelData?: TeamsChannelData;
  serviceUrl: string;
  replyToId?: string;
  locale?: string;
  entities?: TeamsEntity[];
  membersAdded?: TeamsAccount[];
}

export interface TeamsAccount {
  id: string;
  name?: string;
  aadObjectId?: string;
  role?: string;
}

export interface TeamsConversation {
  id: string;
  isGroup?: boolean;
  conversationType?: string;
  tenantId?: string;
  name?: string;
}

export interface TeamsAttachment {
  contentType: string;
  content?: unknown;
  name?: string;
}

export interface TeamsChannelData {
  teamsChannelId?: string;
  teamsTeamId?: string;
  channel?: { id: string; name?: string };
  team?: { id: string; name?: string };
  tenant?: { id: string };
  notification?: { alert: boolean };
}

export interface TeamsEntity {
  type: string;
  mentioned?: TeamsAccount;
  text?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Graph
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphMessage {
  id: string;
  createdDateTime: string;
  lastModifiedDateTime?: string;
  from?: {
    user?: {
      id: string;
      displayName?: string;
    };
    application?: {
      id: string;
      displayName?: string;
    };
  };
  body?: {
    contentType: "text" | "html";
    content: string;
  };
  subject?: string;
  importance?: "low" | "normal" | "high" | "urgent";
  replies?: GraphMessage[];
  replyToId?: string;
  mentions?: GraphMention[];
  deletedDateTime?: string;
}

export interface GraphMention {
  id: number;
  mentionText?: string;
  mentioned: {
    user?: {
      id: string;
      displayName?: string;
    };
  };
}

export interface GraphUser {
  id: string;
  displayName: string;
  mail?: string;
  jobTitle?: string;
  department?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized message (after Graph → Arcadia normalization)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChannelMessage {
  id: string;
  timestamp: string; // ISO 8601
  authorId: string;
  authorName: string;
  text: string; // plain text, HTML stripped
  isBot: boolean;
  replyToId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intelligence layer outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface ThreadContext {
  decisions: string[];
  openItems: string[];
  owners: OwnerAssignment[];
  summary: string;
  language: string; // BCP-47 tag, e.g. "en", "fr", "es"
  messageCount: number;
  timespan: { from: string; to: string };
}

export interface OwnerAssignment {
  task: string;
  owner: string; // display name
}

export interface StaleThread {
  messageId: string;
  channelId: string;
  teamId: string;
  lastActivityAt: string;
  hoursSinceActivity: number;
  lastParticipants: string[];
  subject?: string;
}

export interface DigestEntry {
  teamId: string;
  channelId: string;
  date: string; // YYYY-MM-DD
  activeDiscussions: number;
  decisionsFinalized: string[];
  itemsAwaitingResponse: string[];
  staleThreads: number;
  content: string; // full formatted digest text
}

// ─────────────────────────────────────────────────────────────────────────────
// AI layer
// ─────────────────────────────────────────────────────────────────────────────

export type ModelTier = "cf-workers-ai" | "claude-haiku" | "claude-sonnet";

export interface AIResponse {
  text: string;
  model: ModelTier;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ParsedSummary {
  bullets: string[];
  decisions: string[];
  openItems: string[];
  owners: OwnerAssignment[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot command routing
// ─────────────────────────────────────────────────────────────────────────────

export type CommandIntent =
  | "summarize"
  | "status"
  | "who-owns"
  | "decisions"
  | "next-steps"
  | "general-qa";

export interface ParsedCommand {
  intent: CommandIntent;
  rawText: string;
  language: string;
  mentionedBot: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 row types
// ─────────────────────────────────────────────────────────────────────────────

export interface ThreadRow {
  id: string;
  team_id: string;
  channel_id: string;
  last_activity: number; // Unix timestamp
  owner: string | null;
  status: "active" | "stale" | "resolved";
}

export interface ChannelRow {
  id: string;
  team_id: string;
  channel_id: string;
  channel_name: string;
  registered_at: number;
  service_url: string | null;
  conversation_id: string | null;
}

export interface DigestLogRow {
  id: number;
  team_id: string;
  channel_id: string;
  posted_at: number;
  content: string;
}
