// At-risk nudge Universal Action card.
//
// Sent when a task or thread has been silent past its threshold and the
// nudge engine has decided a gentle reminder is warranted. The engine
// honours Presence, so this card is never sent to someone showing Busy
// or Do not disturb.

import type { AdaptiveCard } from "./types";

export interface NudgeInput {
  nudgeId: string;
  targetAadId: string;
  subject: string;
  reason: string;
  taskId?: string;
  threadUrl?: string;
}

export function nudgeCard(input: NudgeInput): AdaptiveCard {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    refresh: {
      action: {
        type: "Action.Execute",
        verb: "nudge_acknowledge",
        data: { nudgeId: input.nudgeId },
      },
      userIds: [input.targetAadId],
    },
    body: [
      {
        type: "TextBlock",
        text: input.subject,
        weight: "Bolder",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: input.reason,
        isSubtle: true,
        wrap: true,
      },
    ],
    actions: [
      {
        type: "Action.Execute",
        verb: "nudge_acknowledge",
        title: "On it",
        style: "positive",
        data: { nudgeId: input.nudgeId, taskId: input.taskId },
      },
      {
        type: "Action.Execute",
        verb: "nudge_snooze",
        title: "Later today",
        data: { nudgeId: input.nudgeId },
      },
    ],
  };
}
