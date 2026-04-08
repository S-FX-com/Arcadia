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
  // Phase 2 vars
  NUDGE_COOLDOWN_HOURS: string;     // Hours between nudges per task (default "8")
  NUDGE_MAX_PER_RUN: string;        // Max nudges per cron run (default "5")
  GRAPH_NOTIFICATION_SECRET: string; // Base secret for per-subscription client_state
  WEEKLY_REPORT_ENABLED: string;    // "true" | "false"
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
  | "general-qa"
  | "assign"    // Phase 2: @Arcadia assign [task] to [person]
  | "draft"     // Phase 2: @Arcadia draft a follow-up to John
  | "tasks";    // Phase 2: @Arcadia show open tasks

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Task tracking
// ─────────────────────────────────────────────────────────────────────────────

export type TaskStatus = "open" | "in_progress" | "blocked" | "done";
export type TaskPriority = "low" | "normal" | "high";
export type OwnershipReason =
  | "ai-detected"
  | "explicit-command"
  | "reassigned"
  | "unassigned";

export interface TaskRow {
  id: string;
  team_id: string;
  channel_id: string;
  thread_id: string;
  description: string;
  owner_id: string | null;
  owner_name: string | null;
  assigned_by: string | null;
  assigned_at: number | null;       // Unix timestamp
  deadline: number | null;          // Unix timestamp
  priority: TaskPriority;
  status: TaskStatus;
  detected_at: number;              // Unix timestamp
  source_msg_id: string;
  last_nudge_at: number | null;     // Unix timestamp
  nudge_count: number;
}

/** A task extracted by AI from conversation messages. */
export interface ExtractedTask {
  description: string;
  ownerName: string | null;         // Display name mentioned in conversation
  deadlineText: string | null;      // Raw text like "by Friday", "EOD", "next week"
  deadlineUnix: number | null;      // Parsed Unix timestamp (null if unresolvable)
  priority: TaskPriority;
  confidence: number;               // 0–1, AI confidence score
  sourceMessageId: string;
}

export interface OwnershipHistoryRow {
  id: number;
  task_id: string;
  owner_id: string | null;
  owner_name: string | null;
  assigned_by: string;
  reason: OwnershipReason;
  occurred_at: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Graph change notifications
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphSubscription {
  id: string;
  resource: string;
  expirationDateTime: string;       // ISO 8601
  clientState: string;
  changeType: string;
  notificationUrl: string;
}

export interface GraphSubscriptionRow {
  id: string;
  team_id: string;
  channel_id: string;
  resource: string;
  expiration_datetime: number;      // Unix timestamp
  client_state: string;
  created_at: number;
  renewed_at: number | null;
}

export interface GraphNotificationPayload {
  value: GraphNotificationItem[];
}

export interface GraphNotificationItem {
  subscriptionId: string;
  subscriptionExpirationDateTime: string;
  clientState: string;
  changeType: "created" | "updated" | "deleted";
  resource: string;
  resourceData?: {
    "@odata.type": string;
    "@odata.id": string;
    id: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Nudge engine
// ─────────────────────────────────────────────────────────────────────────────

export type NudgeReason =
  | "no-owner"
  | "no-progress"
  | "deadline-24h"
  | "deadline-48h";

export interface NudgeCandidate {
  task: TaskRow;
  reason: NudgeReason;
  urgency: "high" | "medium" | "low";
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Weekly report
// ─────────────────────────────────────────────────────────────────────────────

export interface WeeklyTaskStats {
  openCount: number;
  blockedCount: number;
  doneThisWeek: number;
  ownerGaps: number;        // Open tasks with no owner
  deadlinesMissed: number;  // Overdue tasks
}

export interface WeeklyReportLogRow {
  id: number;
  team_id: string;
  channel_id: string;
  week_start: string;       // YYYY-MM-DD
  posted_at: number;
  content: string;
}
