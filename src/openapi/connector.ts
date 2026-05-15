// Microsoft Copilot Connector item adapter.
//
// Surfaces Arcadia's first-class records (digests, tasks,
// ownership_history, briefs) into Microsoft Search as Connector items
// so Copilot — and the global tenant search — can ground answers on
// them with the same ACL Arcadia enforces internally.
//
// The Copilot Connector ingestion model is item-oriented: one
// ExternalItem per record. Each item carries:
//   - id              stable per item
//   - properties      indexable string / dateTime / boolean fields
//   - content         body text + content-type
//   - acl             principal grants (user / group / everyone)
//   - activities      view / modify timestamps (optional)
//
// This module emits items in a shape that's directly POSTable to
// /external/connections/{connId}/items/{itemId}. The transport
// (the actual PUT loop) lives in src/openapi/connector-sync.ts when
// the cron path is wired; this file is the adapter so the shape stays
// pinned alongside the OpenAPI spec.

import type { Env } from "../env";
import { ResourceAcl } from "../acl/resource-acl";
import type { Memory } from "../memory/types";
import type { Task } from "../tasks/types";

export type ConnectorScheme =
  | "task"
  | "digest"
  | "brief"
  | "memory"
  | "ownership_event";

export interface ExternalItemAcl {
  type: "user" | "group" | "everyone" | "everyoneExceptGuests";
  value: string;
  accessType: "grant" | "deny";
  identitySource?: "azureActiveDirectory" | "external";
}

export interface ExternalItem {
  id: string;
  properties: Record<string, string | number | boolean | string[] | null>;
  content?: {
    type: "text" | "html";
    value: string;
  };
  acl: ExternalItemAcl[];
  activities?: {
    type: "viewed" | "modified" | "created";
    startDateTime: string;
    performedBy?: { user?: { id?: string }; application?: { id?: string } };
  }[];
}

export interface ItemBatch {
  scheme: ConnectorScheme;
  items: ExternalItem[];
}

// ---------------------------------------------------------------------------
// Per-record adapters
// ---------------------------------------------------------------------------

export function taskItem(task: Task, acl: ExternalItemAcl[]): ExternalItem {
  return {
    id: `task:${task.id}`,
    properties: {
      title: task.title,
      kind: "task",
      status: task.status,
      priority: task.priority,
      ownerAadId: task.ownerAadId ?? null,
      channelId: task.channelId ?? null,
      chatId: task.chatId ?? null,
      deadlineAt: task.deadlineAt ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      url: `/dashboard#task:${task.id}`,
    },
    content: {
      type: "text",
      value: [task.title, task.description ?? ""].filter(Boolean).join("\n\n"),
    },
    acl,
    activities: [
      { type: "modified", startDateTime: task.updatedAt },
      { type: "created", startDateTime: task.createdAt },
    ],
  };
}

export interface DigestRow {
  id: string;
  channel_id: string;
  channel_display_name: string | null;
  body: string;
  posted_at: string;
}

export function digestItem(d: DigestRow, acl: ExternalItemAcl[]): ExternalItem {
  return {
    id: `digest:${d.id}`,
    properties: {
      title: `${d.channel_display_name ?? "Channel"} digest`,
      kind: "digest",
      channelId: d.channel_id,
      postedAt: d.posted_at,
      url: `/dashboard#digest:${d.id}`,
    },
    content: { type: "text", value: digestBodyToText(d.body) },
    acl,
    activities: [{ type: "created", startDateTime: d.posted_at }],
  };
}

export interface BriefRow {
  id: string;
  kind: string;
  target_kind: string;
  target_id: string;
  body: string;
  posted_at: string;
}

export function briefItem(b: BriefRow, acl: ExternalItemAcl[]): ExternalItem {
  return {
    id: `brief:${b.id}`,
    properties: {
      title: `${b.kind} brief`,
      kind: "brief",
      briefKind: b.kind,
      targetKind: b.target_kind,
      targetId: b.target_id,
      postedAt: b.posted_at,
    },
    content: { type: "text", value: b.body },
    acl,
    activities: [{ type: "created", startDateTime: b.posted_at }],
  };
}

export function memoryItem(m: Memory, acl: ExternalItemAcl[]): ExternalItem {
  return {
    id: `memory:${m.id}`,
    properties: {
      title: m.content.slice(0, 80),
      kind: "memory",
      memoryKind: m.kind,
      scopeType: m.scopeType,
      scopeId: m.scopeId,
      subjectAadId: m.subjectAadId ?? null,
      occurredAt: m.occurredAt ?? null,
      createdAt: m.createdAt,
      sensitivityLabel: m.sensitivityLabel ?? null,
    },
    content: { type: "text", value: m.content },
    acl,
    activities: [
      { type: "created", startDateTime: m.createdAt },
      ...(m.occurredAt
        ? ([{ type: "modified" as const, startDateTime: m.occurredAt }])
        : []),
    ],
  };
}

export interface OwnershipEventRow {
  id: number;
  task_id: string;
  task_title: string;
  from_aad_id: string | null;
  to_aad_id: string;
  reason: string | null;
  source: string;
  occurred_at: string;
}

export function ownershipEventItem(
  ev: OwnershipEventRow,
  acl: ExternalItemAcl[],
): ExternalItem {
  return {
    id: `ownership:${ev.id}`,
    properties: {
      title: `${ev.task_title} — owner change`,
      kind: "ownership_event",
      taskId: ev.task_id,
      fromAadId: ev.from_aad_id,
      toAadId: ev.to_aad_id,
      reason: ev.reason,
      source: ev.source,
      occurredAt: ev.occurred_at,
    },
    content: {
      type: "text",
      value: `${ev.from_aad_id ?? "(unassigned)"} → ${ev.to_aad_id}${ev.reason ? `: ${ev.reason}` : ""}`,
    },
    acl,
    activities: [{ type: "created", startDateTime: ev.occurred_at }],
  };
}

// ---------------------------------------------------------------------------
// ACL translation
// ---------------------------------------------------------------------------

const ACL_EVERYONE: ExternalItemAcl[] = [
  {
    type: "everyone",
    value: "everyone",
    accessType: "grant",
    identitySource: "azureActiveDirectory",
  },
];

/**
 * Translate Arcadia's resource_acl rows for (resourceType, resourceId)
 * into Connector ACL entries. Empty Arcadia ACL → everyone-in-tenant
 * (matches the strict-mode default-open rule in resource-acl.ts).
 */
export async function aclFor(
  env: Env,
  resourceType: string,
  resourceId: string,
): Promise<ExternalItemAcl[]> {
  const acl = new ResourceAcl(env);
  const grants = await acl.principalsFor(resourceType, resourceId);
  if (grants.length === 0) return ACL_EVERYONE;
  return grants.map((g) => ({
    type:
      g.principal.type === "user"
        ? "user"
        : g.principal.type === "group"
          ? "group"
          : "everyone",
    value: g.principal.id,
    accessType: "grant",
    identitySource: "azureActiveDirectory",
  }));
}

function digestBodyToText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      channelDisplayName?: string;
      sections?: { title: string; items: { text: string }[] }[];
    };
    const lines: string[] = [];
    if (parsed.channelDisplayName) lines.push(parsed.channelDisplayName);
    for (const s of parsed.sections ?? []) {
      lines.push("");
      lines.push(s.title);
      for (const it of s.items ?? []) lines.push(`- ${it.text}`);
    }
    return lines.join("\n");
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Batch builders
// ---------------------------------------------------------------------------

export async function buildTaskBatch(env: Env, since?: string): Promise<ItemBatch> {
  const cutoff = since ?? new Date(0).toISOString();
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT * FROM tasks WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 500`,
  )
    .bind(cutoff)
    .all<{
      id: string;
      title: string;
      description: string | null;
      owner_aad_id: string | null;
      channel_id: string | null;
      chat_id: string | null;
      deadline_at: string | null;
      priority: string;
      status: string;
      planner_task_id: string | null;
      last_nudge_at: string | null;
      created_at: string;
      updated_at: string;
    }>();

  const items: ExternalItem[] = [];
  for (const r of rows.results) {
    const scopeType = r.channel_id ? "channel" : r.chat_id ? "chat" : "tenant";
    const scopeId = r.channel_id ?? r.chat_id ?? "tenant";
    const acl = await aclFor(env, scopeType, scopeId);
    const task: Task = {
      id: r.id,
      title: r.title,
      priority: r.priority as Task["priority"],
      status: r.status as Task["status"],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...(r.description ? { description: r.description } : {}),
      ...(r.owner_aad_id ? { ownerAadId: r.owner_aad_id } : {}),
      ...(r.channel_id ? { channelId: r.channel_id } : {}),
      ...(r.chat_id ? { chatId: r.chat_id } : {}),
      ...(r.deadline_at ? { deadlineAt: r.deadline_at } : {}),
      ...(r.planner_task_id ? { plannerTaskId: r.planner_task_id } : {}),
      ...(r.last_nudge_at ? { lastNudgeAt: r.last_nudge_at } : {}),
    };
    items.push(taskItem(task, acl));
  }

  return { scheme: "task", items };
}

export async function buildDigestBatch(
  env: Env,
  since?: string,
): Promise<ItemBatch> {
  const cutoff = since ?? new Date(0).toISOString();
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT d.id, d.channel_id, d.body, d.posted_at, c.display_name AS channel_display_name
       FROM digests d
       LEFT JOIN channels c ON c.channel_id = d.channel_id
      WHERE d.posted_at >= ?
      ORDER BY d.posted_at DESC
      LIMIT 500`,
  )
    .bind(cutoff)
    .all<DigestRow>();

  const items: ExternalItem[] = [];
  for (const r of rows.results) {
    const acl = await aclFor(env, "channel", r.channel_id);
    items.push(digestItem(r, acl));
  }
  return { scheme: "digest", items };
}
