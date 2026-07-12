// Action-confirmation Universal Action card.
//
// Sent when a 'confirm'-level verb has been attempted and parked as
// 'awaiting_confirmation' in action_log (src/actions/framework.ts). The
// card shows what Arcadia is about to do and offers Approve / Reject. Each
// button is an Action.Execute carrying { actionId }; the verbs route to
// action_confirm / action_reject in src/runtime/invoke-dispatch.ts, which
// calls confirmAction with the invoking user as the actor.

import type { AdaptiveCard } from "./types";

export interface ActionConfirmInput {
  actionId: string;
  description: string;
  /** Optional: restrict the card refresh to specific viewers. */
  targetAadId?: string;
}

export function actionConfirmCard(input: ActionConfirmInput): AdaptiveCard {
  const data = { actionId: input.actionId };
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    ...(input.targetAadId
      ? {
          refresh: {
            action: {
              type: "Action.Execute" as const,
              verb: "action_confirm" as const,
              data,
            },
            userIds: [input.targetAadId],
          },
        }
      : {}),
    body: [
      {
        type: "TextBlock",
        text: "Confirm this action?",
        weight: "Bolder",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: input.description,
        isSubtle: true,
        wrap: true,
      },
    ],
    actions: [
      {
        type: "Action.Execute",
        verb: "action_confirm",
        title: "Approve",
        style: "positive",
        data,
      },
      {
        type: "Action.Execute",
        verb: "action_reject",
        title: "Reject",
        style: "destructive",
        data,
      },
    ],
  };
}
