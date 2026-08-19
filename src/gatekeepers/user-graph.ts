// Delegated user Graph Gatekeeper.
//
// Minted to ONE signed-in Specialist (their Entra object id). Methods have
// no target ids, so a session cannot be pointed at another mailbox, chat, or
// calendar. App-only project Graph (gatekeepers/graph.ts) stays the Radar
// path. Credentials never leave integrations/graph-user.ts.

import { GraphError } from "../integrations/graph";
import {
  graphUserGet,
  readUserGraphTokens,
  userGraphConnected,
} from "../integrations/graph-user";
import { D1GatekeeperQueue } from "./log";
import { GatekeeperDeniedError, type ArcadiaActionQueue, type GatekeeperContext } from "./types";

export interface UserGraphScope {
  email: string;
  aadId: string;
}

export interface MailLite {
  subject: string;
  from: string;
  received: string;
}

export interface ChatLite {
  topic: string;
  lastUpdated: string;
}

export interface EventLite {
  subject: string;
  start: string;
}

export interface AssignedTaskLite {
  title: string;
  percentComplete: number;
  dueDateTime: string | null;
}

export interface UserGraphSession {
  available(): Promise<boolean>;
  myMail(top?: number): Promise<MailLite[]>;
  myChats(top?: number): Promise<ChatLite[]>;
  myCalendar(top?: number): Promise<EventLite[]>;
  myPlanner(top?: number): Promise<AssignedTaskLite[]>;
}

export interface UserGraphPorts {
  queue: ArcadiaActionQueue;
  connected(): Promise<boolean>;
  get<T>(path: string): Promise<T>;
}

export function userGraphSessionFromPorts(scope: UserGraphScope, ports: UserGraphPorts): UserGraphSession {
  const requireConnected = async () => {
    if (!(await ports.connected())) {
      throw new GatekeeperDeniedError(
        `${scope.email} has not connected their Microsoft 365 mailbox to Arcadia`,
        "user-graph"
      );
    }
  };

  return {
    async available() {
      return ports.connected();
    },

    async myMail(top = 8) {
      await requireConnected();
      const res = await ports.get<{
        value: Array<{ subject?: string; from?: { emailAddress?: { address?: string } }; receivedDateTime?: string }>;
      }>(`/me/mailFolders/inbox/messages?$select=subject,from,receivedDateTime&$top=${top}&$orderby=receivedDateTime desc`);
      await ports.queue.authorizeObservation({
        title: `Read inbox (${scope.email})`,
        description: `${res.value.length} message(s): subject, sender, received — no bodies`,
        prohibitAllSharing: true,
      });
      return res.value.map((m) => ({
        subject: m.subject ?? "(no subject)",
        from: m.from?.emailAddress?.address ?? "(unknown)",
        received: m.receivedDateTime ?? "",
      }));
    },

    async myChats(top = 8) {
      await requireConnected();
      const res = await ports.get<{ value: Array<{ topic?: string; lastUpdatedDateTime?: string }> }>(
        `/me/chats?$select=topic,lastUpdatedDateTime&$top=${top}`
      );
      await ports.queue.authorizeObservation({
        title: `Read Teams chats (${scope.email})`,
        description: `${res.value.length} chat(s): topic and last-updated only`,
        prohibitAllSharing: true,
      });
      return res.value.map((c) => ({
        topic: c.topic ?? "(untitled chat)",
        lastUpdated: c.lastUpdatedDateTime ?? "",
      }));
    },

    async myCalendar(top = 8) {
      await requireConnected();
      const res = await ports.get<{ value: Array<{ subject?: string; start?: { dateTime?: string } }> }>(
        `/me/calendarView?startDateTime=${encodeURIComponent(new Date().toISOString())}&endDateTime=${encodeURIComponent(new Date(Date.now() + 7 * 86400000).toISOString())}&$select=subject,start&$top=${top}&$orderby=start/dateTime`
      );
      await ports.queue.authorizeObservation({
        title: `Read calendar (${scope.email})`,
        description: `${res.value.length} upcoming event(s) in the next 7 days: subject and start`,
        prohibitAllSharing: true,
      });
      return res.value.map((e) => ({
        subject: e.subject ?? "(no subject)",
        start: e.start?.dateTime ?? "",
      }));
    },

    async myPlanner(top = 20) {
      await requireConnected();
      const res = await ports.get<{
        value: Array<{ title?: string; percentComplete?: number; dueDateTime?: string | null }>;
      }>(`/me/planner/tasks?$select=title,percentComplete,dueDateTime&$top=${top}`);
      await ports.queue.authorizeObservation({
        title: `Read assigned Planner tasks (${scope.email})`,
        description: `${res.value.length} task(s): title, state, due — no descriptions`,
      });
      return res.value.map((t) => ({
        title: t.title ?? "(untitled)",
        percentComplete: t.percentComplete ?? 0,
        dueDateTime: t.dueDateTime ?? null,
      }));
    },
  };
}

export function openUserGraphSession(env: Env, ctx: GatekeeperContext, scope: UserGraphScope): UserGraphSession {
  return userGraphSessionFromPorts(scope, {
    queue: new D1GatekeeperQueue(env.DB, "user-graph", `graph:user:${scope.aadId}`, ctx),
    connected: async () => userGraphConnected(await readUserGraphTokens(env, scope.aadId)),
    get: (path) => graphUserGet(env, scope.aadId, path),
  });
}

/** Compact snapshot for Ask Arcadia. Empty string if not connected or Graph fails. */
export async function snapshotUserWork(env: Env, email: string, aadId: string): Promise<string> {
  if (!aadId) return "";
  try {
    const session = openUserGraphSession(env, { actor: email, sessionId: `ask:${email}` }, { email, aadId });
    if (!(await session.available())) return "";
    const [tasks, mail, chats, events] = await Promise.all([
      session.myPlanner(12),
      session.myMail(6),
      session.myChats(6),
      session.myCalendar(6),
    ]);
    const lines = [
      `Planner (${tasks.length}): ${tasks
        .slice(0, 8)
        .map((t) => `${t.title} [${t.percentComplete}%${t.dueDateTime ? `, due ${t.dueDateTime.slice(0, 10)}` : ""}]`)
        .join("; ") || "none"}`,
      `Inbox (${mail.length}): ${mail.map((m) => `${m.subject} ← ${m.from}`).join("; ") || "none"}`,
      `Chats (${chats.length}): ${chats.map((c) => c.topic).join("; ") || "none"}`,
      `Calendar (${events.length}): ${events.map((e) => `${e.subject} @ ${e.start}`).join("; ") || "none"}`,
    ];
    return lines.join("\n");
  } catch (err) {
    if (err instanceof GatekeeperDeniedError || err instanceof GraphError) return "";
    console.error("user-graph snapshot", err);
    return "";
  }
}
