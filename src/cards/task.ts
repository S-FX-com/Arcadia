// Task Universal Action card.
//
// Sequential workflow: assign → confirm owner → set deadline → render
// success, all in one card refresh. Action verbs route to the activity
// handler which mutates tasks + ownership_history and re-renders.

import type { AdaptiveCard } from "./types";

export interface TaskInput {
  taskId: string;
  title: string;
  description?: string;
  ownerDisplayName?: string;
  ownerAadId?: string;
  deadlineAt?: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "in_progress" | "blocked" | "done" | "cancelled";
  viewerAadIds: string[];
}

const PRIORITY_LABEL: Record<TaskInput["priority"], string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

const STATUS_LABEL: Record<TaskInput["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export function taskCard(input: TaskInput): AdaptiveCard {
  const terminal =
    input.status === "done" || input.status === "cancelled";

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    refresh: {
      action: {
        type: "Action.Execute",
        verb: "task_accept",
        data: { taskId: input.taskId },
      },
      userIds: input.viewerAadIds,
    },
    body: [
      {
        type: "ColumnSet",
        columns: [
          {
            type: "Column",
            width: "stretch",
            items: [
              {
                type: "TextBlock",
                text: input.title,
                weight: "Bolder",
                size: "Medium",
                wrap: true,
              },
              ...(input.description
                ? [
                    {
                      type: "TextBlock",
                      text: input.description,
                      isSubtle: true,
                      wrap: true,
                    },
                  ]
                : []),
            ],
          },
          {
            type: "Column",
            width: "auto",
            items: [
              {
                type: "TextBlock",
                text: PRIORITY_LABEL[input.priority],
                weight: "Bolder",
                color:
                  input.priority === "urgent"
                    ? "Attention"
                    : input.priority === "high"
                      ? "Warning"
                      : "Default",
              },
            ],
          },
        ],
      },
      {
        type: "FactSet",
        facts: [
          { title: "Owner", value: input.ownerDisplayName ?? "Unassigned" },
          { title: "Deadline", value: input.deadlineAt ?? "—" },
          { title: "Status", value: STATUS_LABEL[input.status] },
        ],
      },
    ],
    actions: terminal
      ? []
      : [
          {
            type: "Action.Execute",
            verb: "task_accept",
            title: "I've got it",
            style: "positive",
            data: { taskId: input.taskId },
          },
          {
            type: "Action.Execute",
            verb: "task_reassign",
            title: "Reassign",
            data: { taskId: input.taskId },
          },
          {
            type: "Action.Execute",
            verb: "task_snooze",
            title: "Snooze",
            data: { taskId: input.taskId },
          },
          {
            type: "Action.Execute",
            verb: "task_complete",
            title: "Mark done",
            style: "positive",
            data: { taskId: input.taskId },
          },
        ],
  };
}
