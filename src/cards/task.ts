// Task Universal Action card.
//
// Sequential workflow: assign → confirm owner → set deadline → render
// success, all in one card refresh. Action verbs route to the activity
// handler which mutates tasks + ownership_history and re-renders.

import type { AdaptiveCard } from "./types";

export interface TaskAcknowledgementInput {
  title: string;
  body: string;
}

export interface TaskReassignPickerInput {
  taskId: string;
  title: string;
  currentOwnerDisplayName?: string;
  candidates: { aadId: string; displayName: string }[];
  viewerAadIds: string[];
}

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

// Step 2 of the reassign sequential flow. The user picks a new owner;
// submission fires `task_reassign_submit` which mutates the row and
// re-renders the final task card.
export function taskReassignPickerCard(
  input: TaskReassignPickerInput,
): AdaptiveCard {
  const choices = input.candidates.map((c) => ({
    title: c.displayName,
    value: c.aadId,
  }));

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    refresh: {
      action: {
        type: "Action.Execute",
        verb: "task_reassign",
        data: { taskId: input.taskId },
      },
      userIds: input.viewerAadIds,
    },
    body: [
      {
        type: "TextBlock",
        text: `Reassign — ${input.title}`,
        weight: "Bolder",
        size: "Medium",
        wrap: true,
      },
      ...(input.currentOwnerDisplayName
        ? [
            {
              type: "TextBlock",
              text: `Currently owned by ${input.currentOwnerDisplayName}`,
              isSubtle: true,
              wrap: true,
            },
          ]
        : []),
      choices.length > 0
        ? {
            type: "Input.ChoiceSet",
            id: "targetAadId",
            label: "New owner",
            style: "compact",
            isRequired: true,
            errorMessage: "Pick someone to reassign to.",
            choices,
          }
        : {
            type: "Input.Text",
            id: "targetAadId",
            label: "New owner (AAD object id)",
            isRequired: true,
            errorMessage: "Provide an AAD object id.",
          },
      {
        type: "Input.Text",
        id: "reason",
        label: "Reason (optional)",
        isMultiline: true,
        placeholder: "Why is this moving?",
      },
    ],
    actions: [
      {
        type: "Action.Execute",
        verb: "task_reassign_submit",
        title: "Reassign",
        style: "positive",
        data: { taskId: input.taskId },
      },
    ],
  };
}

// Final acknowledgement card — used to replace a card with a short
// confirmation after a terminal action (e.g. dismiss, ack a nudge).
export function acknowledgementCard(
  input: TaskAcknowledgementInput,
): AdaptiveCard {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: input.title,
        weight: "Bolder",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: input.body,
        isSubtle: true,
        wrap: true,
      },
    ],
  };
}
