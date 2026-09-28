// Weekly client run-sheet. Facts from bindings the rules already allow.
// No EOS prose, no person score, no chat, no message body, no file text.
//
// The assembler does not read Graph. The job hands it what a frozen session
// already reduced to names, dates, counts, and links.

export interface RunSheetTask {
  id: string;
  title: string;
  planLabel: string;
  /** Planner percentComplete, kept as a number so the sheet can name the state. */
  percentComplete: number;
  dueDateTime: string | null;
  assignees: string[];
  createdDateTime: string | null;
  completedDateTime: string | null;
}

export interface ChannelExcerpt {
  author: string | null;
  at: string | null;
  text: string;
}

export interface ChannelFact {
  label: string;
  available: boolean;
  error?: string;
  /** Messages in the read. Capped reads say so in the rendering. */
  messageCount: number;
  capped: boolean;
  lastActivity: string | null;
  authors: string[];
  /** Short plain text, only when a body read of a bound standard channel succeeded. */
  excerpts: ChannelExcerpt[];
  /** False when the body read was refused. Counts and authors still stand. */
  textPermitted: boolean;
}

/** Strip markup and cap a channel message. Empty after stripping is not an excerpt. */
export function excerptText(raw: string, limit = 180): string {
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export interface FolderFact {
  label: string;
  available: boolean;
  error?: string;
  files: Array<{ name: string; modified: string | null }>;
}

export interface LoopFact {
  label: string;
  url: string;
}

export interface PlannerFact {
  planLabel: string;
  available: boolean;
  error?: string;
  tasks: RunSheetTask[];
}

export interface RunSheetInput {
  clientName: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  /** Null when this client has no earlier sheet. */
  previousTasks: RunSheetTask[] | null;
  planner: PlannerFact[];
  channels: ChannelFact[];
  folders: FolderFact[];
  loops: LoopFact[];
}

export interface RunSheetChange {
  task: RunSheetTask;
  change: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function taskStateLabel(percentComplete: number): string {
  if (percentComplete >= 100) return "done";
  if (percentComplete > 0) return "in progress";
  return "not started";
}

function dayOf(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function inWindow(iso: string | null, weekStart: string, weekEnd: string): boolean {
  const day = dayOf(iso);
  if (!day || !DATE.test(weekStart) || !DATE.test(weekEnd)) return false;
  return day >= weekStart && day <= weekEnd;
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, i) => value === right[i]);
}

/**
 * What changed in the window. With no prior sheet, open tasks are listed as
 * open as of this reading, plus anything completed in the window. With a
 * prior sheet, a task appears when it was created, completed, or due in the
 * window, or when state, due, or assignees differ from the prior reading.
 */
export function plannerChanges(
  current: RunSheetTask[],
  previous: RunSheetTask[] | null,
  weekStart: string,
  weekEnd: string
): RunSheetChange[] {
  const prior = new Map((previous ?? []).map((task) => [task.id, task]));
  const changes: RunSheetChange[] = [];
  for (const task of current) {
    const reasons: string[] = [];
    if (inWindow(task.createdDateTime, weekStart, weekEnd)) reasons.push("created this week");
    if (inWindow(task.completedDateTime, weekStart, weekEnd)) reasons.push("completed this week");
    if (inWindow(task.dueDateTime, weekStart, weekEnd)) reasons.push("due this week");
    const before = prior.get(task.id);
    if (previous && before) {
      const moved =
        before.percentComplete !== task.percentComplete ||
        before.dueDateTime !== task.dueDateTime ||
        !sameList(before.assignees, task.assignees) ||
        before.title !== task.title;
      if (moved) reasons.push("state, due, or assignee changed since the last sheet");
    }
    if (!previous && task.percentComplete < 100 && reasons.length === 0) {
      reasons.push("open as of this reading");
    }
    if (reasons.length === 0) continue;
    changes.push({ task, change: reasons.join("; ") });
  }
  return changes;
}

function taskLine(change: RunSheetChange): string {
  const { task } = change;
  const due = task.dueDateTime ? dayOf(task.dueDateTime) : null;
  const who = task.assignees.length ? task.assignees.join(", ") : "unassigned";
  return `- ${task.title} (${taskStateLabel(task.percentComplete)}), due ${due ?? "no date"}, assignee ${who}. ${change.change}.`;
}

/**
 * JSON plus a plain rendering. The JSON has no message body and no chat
 * key. The rendering names what was read and what was not.
 */
export function assembleRunSheet(input: RunSheetInput): { payload: Record<string, unknown>; rendered: string } {
  const planner = input.planner.map((plan) => ({
    plan: plan.planLabel,
    available: plan.available,
    ...(plan.error ? { error: plan.error } : {}),
    changes: plan.available ? plannerChanges(plan.tasks, input.previousTasks, input.weekStart, input.weekEnd) : [],
  }));

  const payload: Record<string, unknown> = {
    kind: "client-run-sheet",
    client: input.clientName,
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    generatedAt: input.generatedAt,
    planner: planner.map((plan) => ({
      plan: plan.plan,
      available: plan.available,
      ...(plan.error ? { error: plan.error } : {}),
      changes: plan.changes.map((change) => ({
        title: change.task.title,
        state: taskStateLabel(change.task.percentComplete),
        due: change.task.dueDateTime,
        assignees: change.task.assignees,
        change: change.change,
      })),
    })),
    channels: input.channels.map((channel) => ({
      label: channel.label,
      available: channel.available,
      ...(channel.error ? { error: channel.error } : {}),
      messageCount: channel.messageCount,
      capped: channel.capped,
      lastActivity: channel.lastActivity,
      authors: channel.authors,
      textPermitted: channel.textPermitted,
      excerpts: channel.excerpts.map((excerpt) => ({
        author: excerpt.author,
        at: excerpt.at,
        text: excerpt.text,
      })),
    })),
    folders: input.folders.map((folder) => ({
      label: folder.label,
      available: folder.available,
      ...(folder.error ? { error: folder.error } : {}),
      files: folder.files.map((file) => ({ name: file.name, modified: file.modified })),
    })),
    loops: input.loops.map((loop) => ({ label: loop.label, url: loop.url })),
  };

  const lines: string[] = [
    `Run sheet — ${input.clientName} — week of ${input.weekStart} through ${input.weekEnd}`,
    `Generated ${input.generatedAt}. Facts from bound sources. This sheet is not sent to the client.`,
    "",
    "Planner",
  ];
  if (planner.length === 0) lines.push("No Planner plan is bound.");
  for (const plan of planner) {
    if (!plan.available) {
      lines.push(`${plan.plan}: not read. ${plan.error ?? "Graph did not answer."}`);
      continue;
    }
    lines.push(plan.plan);
    if (plan.changes.length === 0) lines.push("- Nothing in the window.");
    else for (const change of plan.changes) lines.push(taskLine(change));
  }
  lines.push("", "Channels");
  if (input.channels.length === 0) lines.push("No standard channel is bound.");
  for (const channel of input.channels) {
    if (!channel.available) {
      lines.push(`${channel.label}: not read. ${channel.error ?? "Graph did not answer."}`);
      continue;
    }
    const cap = channel.capped ? " (read capped at 50)" : "";
    const authors = channel.authors.length ? channel.authors.join(", ") : "no author on the timestamp";
    lines.push(
      `${channel.label}: ${channel.messageCount} message${channel.messageCount === 1 ? "" : "s"}${cap}. Last activity ${channel.lastActivity ?? "none"}. Authors: ${authors}.`
    );
    if (!channel.textPermitted) {
      lines.push("Message text was not permitted.");
    } else if (channel.excerpts.length === 0) {
      lines.push("No message excerpt in the window.");
    } else {
      for (const excerpt of channel.excerpts) {
        const who = excerpt.author ?? "unknown";
        const when = excerpt.at ?? "no time";
        lines.push(`- ${who}, ${when}: ${excerpt.text}`);
      }
    }
  }
  lines.push("", "SharePoint");
  if (input.folders.length === 0) lines.push("No folder is bound.");
  for (const folder of input.folders) {
    if (!folder.available) {
      lines.push(`${folder.label}: not read. ${folder.error ?? "Graph did not answer."}`);
      continue;
    }
    if (folder.files.length === 0) lines.push(`${folder.label}: no file in the window.`);
    else {
      lines.push(folder.label);
      for (const file of folder.files) lines.push(`- ${file.name}, modified ${file.modified ?? "unknown"}`);
    }
  }
  lines.push("", "Loop");
  if (input.loops.length === 0) lines.push("No Loop URL is bound.");
  for (const loop of input.loops) {
    lines.push(`- ${loop.label} — ${loop.url}`);
  }
  lines.push("Page text is not in this sheet.");
  lines.push("", "Chats are not included.");

  return { payload, rendered: lines.join("\n") };
}

/** Monday–Sunday (UTC) containing `date`. */
export function weekBounds(date: Date): { weekStart: string; weekEnd: string } {
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + mondayOffset));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6));
  return { weekStart: start.toISOString().slice(0, 10), weekEnd: end.toISOString().slice(0, 10) };
}
