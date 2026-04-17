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
	// Optional admin secret used for protected internal endpoints (testing/manual triggers)
	ADMIN_SECRET?: string;
	// AAD Object ID of the admin user allowed to query cross-user/cross-channel data
	ADMIN_USER_AAD_ID?: string;

	// Phase 3 feature flags
	MORNING_BRIEF_ENABLED: string;   // "true" | "false"
	EVENING_WRAPUP_ENABLED: string;  // "true" | "false"

	// Phase 4 feature flags
	MEMORY_ENABLED: string;                // "true" | "false"
	MEMORY_CONSOLIDATION_ENABLED: string;  // "true" | "false"

	// Phase 5 feature flags
	AUTORESEARCH_ENABLED: string;              // "true" | "false"
	RESEARCH_QUESTION_MAX_PER_CYCLE: string;   // default "3"
	RESEARCH_QUESTION_MAX_PER_DAY: string;     // default "5"

	// Phase 6 bindings
	ARCADIA_VECTORS?: VectorizeIndex;          // CF Vectorize — memory embedding index (optional until index is created)

	// Phase 6 feature flags
	VECTORIZE_ENABLED: string;                 // "true" | "false"
	KNOWLEDGE_GRAPH_ENABLED: string;           // "true" | "false"

	// Phase 7 (Webapp) secrets
	WEBAPP_CLIENT_ID: string;       // Azure AD app client ID for webapp SSO
	WEBAPP_CLIENT_SECRET: string;   // Confidential client secret for token exchange
	WEBAPP_SESSION_SECRET: string;  // 256-bit key for AES-GCM encryption of stored tokens

	// Phase 7 feature flags
	WEBAPP_ENABLED: string;                 // "true" | "false"
	CONTEXT_FOOTER_ENABLED: string;         // "true" | "false" — show debug footer on responses

	// Vars (from wrangler.toml [vars])
	STALE_THREAD_HOURS: string;
	MAX_MESSAGES_CACHED: string;
	DIGEST_CRON_HOUR: string;
	// Default Workers AI model used by the CF tier in the AI router
	CF_AI_DEFAULT_MODEL: string;
	// Phase 2 vars
	NUDGE_COOLDOWN_HOURS: string; // Hours between nudges per task (default "8")
	NUDGE_MAX_PER_RUN: string; // Max nudges per cron run (default "5")
	GRAPH_NOTIFICATION_SECRET: string; // Base secret for per-subscription client_state
	WEEKLY_REPORT_ENABLED: string; // "true" | "false"
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
	team?: { id: string; name?: string; aadGroupId?: string };
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
	/** Channel or chat name — populated by the cross-context loader for DM broad context. */
	channelName?: string;
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

/**
 * Model tiers used for routing and metadata in AIResponse.
 * "cf-workers-ai" maps to @cf/google/gemma-4-26b-a4b-it by default.
 */
export type ModelTier = "cf-workers-ai";

export interface AIResponse {
	text: string;
	model: ModelTier;
	inputTokens?: number;
	outputTokens?: number;
}

/** Options forwarded to the Cloudflare Workers AI (Gemma 4) inference call. */
export interface AIStreamOptions {
	/** Sampling temperature (0–2). Defaults to model default when omitted. */
	temperature?: number;
	/** Maximum number of tokens to generate. Defaults to 1024. */
	max_tokens?: number;
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
	| "assign"        // Phase 2: @Arcadia assign [task] to [person]
	| "draft"         // Phase 2: @Arcadia draft a follow-up to John
	| "tasks"         // Phase 2: @Arcadia show open tasks
	| "exec-summary"  // Phase 3: @Arcadia executive summary for [date range]
	| "research"      // Phase 5: @Arcadia research status/focus/pause/resume
	| "knowledge";    // Phase 6: @Arcadia knowledge/graph/timeline [entity]

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
export type OwnershipReason = "ai-detected" | "explicit-command" | "reassigned" | "unassigned";

export interface TaskRow {
	id: string;
	team_id: string;
	channel_id: string;
	thread_id: string;
	description: string;
	owner_id: string | null;
	owner_name: string | null;
	assigned_by: string | null;
	assigned_at: number | null; // Unix timestamp
	deadline: number | null; // Unix timestamp
	priority: TaskPriority;
	status: TaskStatus;
	detected_at: number; // Unix timestamp
	source_msg_id: string;
	last_nudge_at: number | null; // Unix timestamp
	nudge_count: number;
}

/** A task extracted by AI from conversation messages. */
export interface ExtractedTask {
	description: string;
	ownerName: string | null; // Display name mentioned in conversation
	deadlineText: string | null; // Raw text like "by Friday", "EOD", "next week"
	deadlineUnix: number | null; // Parsed Unix timestamp (null if unresolvable)
	priority: TaskPriority;
	confidence: number; // 0–1, AI confidence score
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
	expirationDateTime: string; // ISO 8601
	clientState: string;
	changeType: string;
	notificationUrl: string;
}

export interface GraphSubscriptionRow {
	id: string;
	team_id: string;
	channel_id: string;
	resource: string;
	expiration_datetime: number; // Unix timestamp
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

export type NudgeReason = "no-owner" | "no-progress" | "deadline-24h" | "deadline-48h";

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
	ownerGaps: number; // Open tasks with no owner
	deadlinesMissed: number; // Overdue tasks
}

export interface WeeklyReportLogRow {
	id: number;
	team_id: string;
	channel_id: string;
	week_start: string; // YYYY-MM-DD
	posted_at: number;
	content: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Profiles, DM conversations, channel snapshots
// ─────────────────────────────────────────────────────────────────────────────

/** One turn in a 1:1 DM conversation (persisted in KV, max 20 turns). */
export interface ConversationTurn {
	role: "user" | "assistant";
	content: string;
	timestamp: string; // ISO 8601
}

/** AI-generated nested insights about a user's behaviour and work patterns. */
export interface ProfileInsights {
	communicationStyle?: {
		summary: string;
		traits: string[];
	};
	focusAreas?: {
		primary: string[];
		secondary: string[];
		recent: string[];
	};
	workingPatterns?: {
		activeHours?: string;
		peakHours?: string;
		responseStyle?: string;
	};
	relationships?: Array<{ name: string; frequency: "high" | "medium" | "low"; context?: string }>;
	updatedAt: string; // ISO 8601
}

/** Persistent per-user profile — cached in KV (fast reads), backed by D1. */
export interface UserProfile {
	userId: string;
	displayName: string;
	teamId?: string;
	messageCount: number;
	firstSeen: string;      // ISO 8601
	lastSeen: string;       // ISO 8601
	insights?: ProfileInsights;
	insightVersion: number;
}

/** Profile for a customer / external organisation. */
export interface CustomerProfile {
	id: string;             // normalized slug (e.g. "gnc", "acme-corp")
	name: string;
	mentionCount: number;
	contacts: string[];     // display names of known contacts
	topics: string[];       // recurring topics from conversation
	sentiment?: "positive" | "neutral" | "negative";
	recentContext?: string;
	lastMentioned: string;  // ISO 8601
}

/** D1 row for user_profiles table. */
export interface UserProfileRow {
	user_id: string;
	display_name: string;
	team_id: string | null;
	message_count: number;
	first_seen: number;  // Unix timestamp
	last_seen: number;   // Unix timestamp
	insights: string | null; // JSON
	insight_version: number;
	updated_at: number;  // Unix timestamp
}

/** D1 row for customer_profiles table. */
export interface CustomerProfileRow {
	id: string;
	name: string;
	mention_count: number;
	first_seen: number;
	last_seen: number;
	context: string | null; // JSON
	updated_at: number;
}

/** Resolved date range for exec summary requests. */
export interface DateRange {
	from: string;  // YYYY-MM-DD
	to: string;    // YYYY-MM-DD
	label: string; // human-readable label
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: Long-term memory, context engine, heartbeat, agent modes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Four memory categories, each holding a different type of knowledge.
 * Inspired by how humans convert experience into lasting understanding.
 */
export type MemoryCategory = "episodic" | "semantic" | "procedural" | "observation";

/** A single memory, as used throughout the application. */
export interface Memory {
	id: string;
	category: MemoryCategory;
	content: string;
	keywords: string[];            // Parsed from comma-separated DB column
	importance: number;            // 0.0–1.0
	sourceChannelId: string | null;
	sourceUserId: string | null;
	createdAt: string;             // ISO 8601
	lastRecalledAt: string | null; // ISO 8601
	recallCount: number;
	consolidatedAt: string | null; // ISO 8601
	expiresAt: string | null;      // ISO 8601
	// Phase 6: Palace hierarchy + embedding status
	wing: string | null;           // Domain grouping: team, channel:{id}, person:{id}, etc.
	room: string | null;           // Topic within wing: standup, billing, auth-migration, etc.
	embeddingStatus: string | null; // pending | indexed | failed
}

/** D1 row type for the memories table. */
export interface MemoryRow {
	id: string;
	category: string;
	content: string;
	keywords: string;
	importance: number;
	source_channel_id: string | null;
	source_user_id: string | null;
	created_at: number;
	last_recalled_at: number | null;
	recall_count: number;
	consolidated_at: number | null;
	expires_at: number | null;
	// Phase 6
	wing: string | null;
	room: string | null;
	embedding_status: string | null;
}

export type DreamPhase = "light" | "deep" | "rem";

/** A memory consolidation cycle. */
export interface MemoryDream {
	id: number;
	phase: DreamPhase;
	startedAt: string;            // ISO 8601
	completedAt: string | null;   // ISO 8601
	summary: string | null;
	memoriesProcessed: number;
	memoriesCreated: number;
	memoriesPruned: number;
}

/** D1 row type for the memory_dreams table. */
export interface MemoryDreamRow {
	id: number;
	phase: string;
	started_at: number;
	completed_at: number | null;
	summary: string | null;
	memories_processed: number;
	memories_created: number;
	memories_pruned: number;
}

/**
 * Internal agent mode. NOT user-configurable.
 * Determines which memories to recall, how much context to assemble,
 * and what output format to expect.
 *
 * - conversation: DMs — full context, all memory categories, rich profile
 * - analysis: Summaries, exec summaries, decisions — structured output
 * - task: Task extraction, assignment, nudging — JSON/structured output
 * - background: Cron jobs, consolidation, heartbeat — no user-facing output
 */
export type AgentMode = "conversation" | "analysis" | "task" | "background";

/** Fully assembled context handed to the AI router before each call. */
export interface AssembledContext {
	mode: AgentMode;
	systemPrompt: string;
	memories: Memory[];
	userProfile: UserProfile | null;
	channelMessages: ChannelMessage[];
	activeTasks: TaskRow[];
	tokenBudget: {
		total: number;
		used: number;
		remaining: number;
	};
}

/** Health status of the memory system, produced by the heartbeat. */
export interface MemoryHealthReport {
	totalMemories: number;
	byCategory: Record<MemoryCategory, number>;
	staleCategories: MemoryCategory[]; // Categories with no new memories in 7+ days
	expiringSoon: number;               // Memories expiring within 48h
	lastDream: MemoryDream | null;
}

/** A proactive opportunity identified by the heartbeat scan. */
export interface ProactiveOpportunity {
	type: "approaching-deadline" | "silent-user" | "unresolved-thread" | "unowned-task";
	description: string;
	urgency: "high" | "medium" | "low";
	channelId?: string;
	userId?: string;
	taskId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: Autoresearch — M365 Tenant Intelligence
// ─────────────────────────────────────────────────────────────────────────────

export type ResearchCycleStatus = "running" | "completed" | "failed";

/** D1 row for research_cycles table. */
export interface ResearchCycleRow {
	id: number;
	started_at: number;
	completed_at: number | null;
	status: string;
	channels_scanned: number;
	chats_scanned: number;
	users_scanned: number;
	memories_created: number;
	bridges_detected: number;
	questions_generated: number;
	knowledge_score_delta: number;
	summary: string | null;
}

/** Snapshot of M365 tenant data collected during a research scan. */
export interface TenantSnapshot {
	teams: Array<{ id: string; displayName: string; channels: Array<{ id: string; displayName: string }> }>;
	chats: Array<{ id: string; topic: string | null; chatType: string; members: string[] }>;
	users: Array<{ id: string; displayName: string; mail: string | null }>;
	channelMessages: Map<string, ChannelMessage[]>;
	chatMessages: Map<string, ChannelMessage[]>;
	scannedAt: string;
}

/** A detected conversation bridge between a channel and a chat. */
export interface ConversationBridge {
	id: string;
	channelId: string;
	channelName: string;
	chatId: string;
	chatTopic: string | null;
	sharedParticipants: string[];
	sharedTopics: string[];
	temporalCorrelation: number;  // 0.0–1.0
	overallScore: number;         // 0.0–1.0
	details: string;
}

/** D1 row for conversation_bridges table. */
export interface ConversationBridgeRow {
	id: string;
	channel_id: string;
	channel_name: string | null;
	chat_id: string;
	chat_topic: string | null;
	shared_participants: string | null;
	shared_topics: string | null;
	temporal_correlation: number | null;
	overall_score: number | null;
	details: string | null;
	discovered_at: number;
	last_validated_at: number | null;
}

/** A research question queued for Shane. */
export interface ResearchQuestion {
	id: string;
	question: string;
	context: string;
	importance: number;         // 0.0–1.0
	source: "bridge" | "gap" | "analysis";
	relatedBridgeId?: string;
	status: "pending" | "asked" | "answered" | "expired";
	createdAt: string;
}

/** D1 row for research_questions table. */
export interface ResearchQuestionRow {
	id: string;
	question: string;
	context: string | null;
	importance: number;
	source: string;
	related_bridge_id: string | null;
	status: string;
	answer: string | null;
	created_at: number;
	answered_at: number | null;
}

/** A gap in Arcadia's knowledge about an entity. */
export interface KnowledgeGap {
	entity: string;
	gapType: "unknown-owner" | "unknown-status" | "fragmented-context" | "stale-info";
	confidence: number;
	lastSeen: string;
}

/** D1 row for knowledge_entities table. */
export interface KnowledgeEntityRow {
	id: string;
	entity_type: string;
	entity_name: string;
	confidence: number;
	last_researched_at: number | null;
	gap_type: string | null;
	created_at: number;
	updated_at: number;
}

/** Research directives — Shane's control over what Arcadia researches. */
export interface ResearchDirectives {
	focus: string[];
	priorities: string[];
	excludeChats: string[];
	questionThrottle: { perCycle: number; perDay: number };
	enabled: boolean;
}

/** Result of a single research cycle. */
export interface ResearchCycleResult {
	cycleId: number;
	channelsScanned: number;
	chatsScanned: number;
	usersScanned: number;
	memoriesCreated: number;
	bridgesDetected: number;
	questionsGenerated: number;
	knowledgeScoreDelta: number;
	summary: string;
}

/** Summary of a topic extracted from messages. */
export interface TopicSummary {
	topic: string;
	keywords: string[];
	participants: string[];
	messageCount: number;
	firstSeen: string;
	lastSeen: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6: MemPalace Memory Architecture — Vector Search, Knowledge Graph,
// Hierarchical Organization, Layered Context
// ─────────────────────────────────────────────────────────────────────────────

export type EntityType = "person" | "project" | "customer" | "team" | "channel" | "concept";

/** A fact in the temporal knowledge graph. */
export interface KGFact {
	id: string;
	subjectId: string;
	subjectName: string;
	subjectType: EntityType;
	predicate: string;
	objectId: string;
	objectName: string;
	objectType: EntityType;
	confidence: number;
	source: string | null;
	validFrom: string | null;  // ISO 8601
	validTo: string | null;    // ISO 8601 (null = still valid)
	createdAt: string;
	updatedAt: string;
}

/** D1 row for knowledge_graph table. */
export interface KGFactRow {
	id: string;
	subject_id: string;
	subject_name: string;
	subject_type: string;
	predicate: string;
	object_id: string;
	object_name: string;
	object_type: string;
	confidence: number;
	source: string | null;
	valid_from: number | null;
	valid_to: number | null;
	created_at: number;
	updated_at: number;
}

/** All active facts about a single entity. */
export interface EntityFacts {
	entityId: string;
	entityName: string;
	entityType: EntityType;
	facts: KGFact[];
}

/** Result of a BFS graph traversal from an entity. */
export interface GraphTraversal {
	root: string;
	depth: number;
	nodes: Array<{ id: string; name: string; type: EntityType; distance: number }>;
	edges: Array<{ from: string; to: string; predicate: string }>;
}

/** A link between two related memories (MemPalace "tunnel"). */
export interface MemoryLink {
	id: string;
	memoryAId: string;
	memoryBId: string;
	linkType: "related" | "supersedes" | "contradicts" | "elaborates";
	strength: number;  // 0.0–1.0
	createdAt: string;
}

/** D1 row for memory_links table. */
export interface MemoryLinkRow {
	id: string;
	memory_a_id: string;
	memory_b_id: string;
	link_type: string;
	strength: number;
	created_at: number;
}

/** Metadata stored alongside each vector in Vectorize. */
export interface VectorMetadata {
	category: string;
	wing: string;
	room: string | null;
	importance: number;
}

/** A single match from a Vectorize semantic search. */
export interface VectorMatch {
	memoryId: string;
	score: number;       // 0.0–1.0 cosine similarity
	metadata: VectorMetadata;
}

/** Result of L0-L3 layered context assembly. */
export interface LayeredContext {
	l0Identity: string;
	l1Essential: string;
	l2KeywordMemories: Memory[];
	l3SemanticMemories: Memory[];
	totalTokens: number;
}

/** Command intent for knowledge graph queries. */
export type KnowledgeIntent = "knowledge-query" | "knowledge-graph" | "knowledge-timeline";
