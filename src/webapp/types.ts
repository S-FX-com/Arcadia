// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Type Definitions (Phase 7)
// ─────────────────────────────────────────────────────────────────────────────

/** Active webapp session, stored in D1 with encrypted tokens. */
export interface WebappSession {
  id: string;
  userId: string;           // AAD Object ID
  displayName: string;
  email: string | null;
  accessToken: string;      // AES-GCM encrypted
  refreshToken: string | null; // AES-GCM encrypted
  tokenExpiry: number;      // Unix timestamp
  scopes: string;           // Space-separated scope string
  createdAt: number;        // Unix timestamp
  lastActive: number;       // Unix timestamp
}

/** D1 row for webapp_sessions table. */
export interface WebappSessionRow {
  id: string;
  user_id: string;
  display_name: string;
  email: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expiry: number;
  scopes: string;
  created_at: number;
  last_active: number;
}

/** A conversation in the webapp chat. */
export interface WebappConversation {
  id: string;
  userId: string;
  title: string;
  createdAt: string;        // ISO 8601
  updatedAt: string;        // ISO 8601
  messageCount: number;
  clientId: string | null;  // Phase 10: client association
}

/** D1 row for webapp_conversations table. */
export interface WebappConversationRow {
  id: string;
  user_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  client_id: string | null; // Phase 10
}

/** A single message in a webapp conversation. */
export interface WebappMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  contextRefs: ContextRef[] | null;
  createdAt: string;        // ISO 8601
}

/** D1 row for webapp_messages table. */
export interface WebappMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  context_refs: string | null; // JSON
  created_at: number;
}

/** Reference to M365 context used in a message. */
export interface ContextRef {
  type: "team" | "channel" | "chat" | "sharepoint-site" | "planner-task";
  id: string;
  title: string;
}

/** Inbound chat request from the frontend. */
export interface WebappChatRequest {
  conversationId?: string;
  message: string;
  contextSources?: ContextSource[];
  clientId?: string;  // Phase 10: associate chat with a client
}

/** Which M365 data sources to include as context. */
export type ContextSource = "teams" | "chats" | "sharepoint" | "planner";

/** Outbound chat response to the frontend. */
export interface WebappChatResponse {
  conversationId: string;
  /** ID of the persisted assistant message (for Phase 11 feedback). */
  messageId?: string;
  message: string;
  contextUsed: ContextRef[];
  /** Set when the pipeline handled an image generation request. */
  imageUrl?: string;
  /** Model used to generate the response. */
  model?: string;
}

/** Decoded user graph token pair. */
export interface UserGraphToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;        // Unix timestamp
  scopes: string;
}

/** User info returned from /me Graph endpoint. */
export interface GraphMeProfile {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
  jobTitle: string | null;
}

/** Planner task from Graph API. */
export interface PlannerTask {
  id: string;
  planId: string;
  bucketId: string | null;
  title: string;
  percentComplete: number;
  dueDateTime: string | null;
  assignedTo: string[];
  createdDateTime: string;
}

/** Planner plan from Graph API. */
export interface PlannerPlan {
  id: string;
  title: string;
  owner: string;
  createdDateTime: string;
}

/** Planner bucket from Graph API. */
export interface PlannerBucket {
  id: string;
  name: string;
  planId: string;
  orderHint: string;
}

/** SharePoint site from Graph API. */
export interface SharePointSite {
  id: string;
  displayName: string;
  webUrl: string;
  description: string | null;
}

/** SharePoint drive item (file/folder). */
export interface SharePointDriveItem {
  id: string;
  name: string;
  webUrl: string;
  size: number;
  lastModifiedDateTime: string;
  isFolder: boolean;
}

/** Teams info for the webapp. */
export interface UserTeam {
  id: string;
  displayName: string;
  description: string | null;
}

/** Channel info for the webapp. */
export interface UserChannel {
  id: string;
  displayName: string;
  description: string | null;
}

/** Chat info for the webapp. */
export interface UserChat {
  id: string;
  topic: string | null;
  chatType: string;
  lastUpdatedDateTime: string | null;
}

// ─── Phase 10: Client Intelligence ───────────────────────────────────────────

export interface Client {
  id: string;
  name: string;
  description: string | null;
  color: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  indexStatus: 'pending' | 'indexing' | 'ready' | 'error';
  indexStartedAt: string | null;
  indexCompletedAt: string | null;
  memorySummary: string | null;
  memoryVersion: number;
}

export interface ClientSource {
  id: string;
  clientId: string;
  sourceType: 'team' | 'channel' | 'chat' | 'sharepoint-site' | 'planner-plan';
  sourceId: string;
  sourceName: string;
  teamId: string | null;
  metadata: Record<string, unknown> | null;
  addedBy: string;
  addedAt: string;
}

export interface ClientMemory {
  id: string;
  clientId: string;
  category: string;
  content: string;
  keywords: string[];
  importance: number;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface ClientNotification {
  id: string;
  clientId: string;
  userId: string | null;
  type: 'index_complete' | 'blocker_detected' | 'memory_updated';
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export interface ClientIndexStatus {
  status: 'pending' | 'indexing' | 'ready' | 'error';
  indexStartedAt: string | null;
  indexCompletedAt: string | null;
  recentLog: {
    id: number;
    startedAt: string;
    completedAt: string | null;
    status: string;
    messagesRead: number;
    memoriesCreated: number;
    summary: string | null;
  } | null;
}
