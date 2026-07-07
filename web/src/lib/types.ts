// Shared types between the Arcadia web app and the v2 worker API.
// Kept thin and mirrored from src/* types on the worker side.

export type ChatMessageRole = "user" | "assistant";

export interface ChatTurn {
	role: ChatMessageRole;
	content: string;
	pending?: boolean;
}

export interface Session {
	aadId: string;
	tenantId: string;
	upn?: string;
	name?: string;
	exp: number;
}

export type Priority = "low" | "normal" | "high" | "urgent";

export type TaskStatus =
	| "open"
	| "in_progress"
	| "blocked"
	| "done"
	| "cancelled";

export interface Task {
	id: string;
	title: string;
	description?: string;
	ownerAadId?: string;
	deadlineAt?: string;
	priority: Priority;
	status: TaskStatus;
	channelId?: string;
	chatId?: string;
	createdAt: string;
	updatedAt: string;
}

export type MemoryKind =
	| "episodic"
	| "semantic"
	| "procedural"
	| "observation";

export type MemoryScope =
	| "tenant"
	| "channel"
	| "chat"
	| "user"
	| "project"
	| "customer";

export interface MemoryHit {
	score: number;
	memory: {
		id: string;
		kind: MemoryKind;
		scopeType: MemoryScope;
		scopeId: string;
		content: string;
		subjectAadId?: string;
		occurredAt?: string;
		createdAt: string;
	};
}

export type RoutineTrigger =
	| { kind: "cron"; cron: string }
	| { kind: "event"; resource: string; changeType?: string }
	| { kind: "manual" };

export interface Routine {
	id: string;
	name: string;
	description?: string;
	trigger: RoutineTrigger;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Brief {
	id: string;
	kind: string;
	body: string;
	posted_at: string;
}

export interface Source {
	id: string;
	resourceType: string;
	resourceId: string;
	title: string | null;
	uri: string | null;
	mimeType: string | null;
	sizeBytes: number | null;
	sensitivityLabel: string | null;
	updatedAt: number;
}

export interface IngestLatestRun {
	startedAt: string;
	finishedAt: string | null;
	enqueued: number;
	processed: number;
	failures: number;
}

export interface Ingest24h {
	enqueued: number;
	processed: number;
	failures: number;
	runs: number;
}

export interface IngestSourceStatus {
	source: string;
	latest: IngestLatestRun | null;
	last24h: Ingest24h;
}

export interface FreshnessRow {
	source: string;
	count: number;
	latestIndexedAt: string | null;
}

export interface DeltaStateSummary {
	resource: string;
	count: number;
	lastRunAt: string | null;
}

export interface SourcesData {
	sources: Source[];
	ingest: IngestSourceStatus[];
	freshness: FreshnessRow[];
	deltaState: DeltaStateSummary[];
}

export interface SearchResultItem {
	type: string;
	id: string;
	title: string | null;
	summary: string | null;
	webUrl: string | null;
	lastModified: string | null;
}

export interface SearchResponse {
	results: SearchResultItem[];
}

export interface DashboardData {
	me: { aadId: string; tenantId: string; name?: string; upn?: string };
	tasks: { open: number; inProgress: number; blocked: number; total: number };
	dueToday: Task[];
	overdue: Task[];
	recentDigests: {
		id: string;
		channelId: string;
		channelDisplayName: string | null;
		postedAt: string;
	}[];
	latestBrief: Brief | null;
	activeRoutines: { id: string; name: string; trigger: RoutineTrigger }[];
}
