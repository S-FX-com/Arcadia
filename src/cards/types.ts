// Shared types and verbs for Arcadia's Universal Action cards.
//
// Every card uses Action.Execute (not Action.Submit). The verb routes to
// a handler in src/runtime/activity-handler.ts when invoked. Cards
// include a `refresh` block keyed to the recipient's AAD id(s) so each
// viewer sees content filtered to their ACL.

export type Verb =
  | "digest_refresh"
  | "digest_dismiss"
  | "task_accept"
  | "task_reassign"
  | "task_reassign_submit"
  | "task_complete"
  | "task_snooze"
  | "nudge_acknowledge"
  | "nudge_snooze"
  | "memory_correct"
  | "feedback";

export interface ActionExecute {
  type: "Action.Execute";
  verb: Verb;
  title?: string;
  data?: Record<string, unknown>;
  iconUrl?: string;
  style?: "default" | "positive" | "destructive";
}

export interface CardEnvelope {
  contentType: "application/vnd.microsoft.card.adaptive";
  content: AdaptiveCard;
}

export interface AdaptiveCard {
  type: "AdaptiveCard";
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json";
  version: "1.5";
  refresh?: {
    action: ActionExecute;
    userIds?: string[];
  };
  body: unknown[];
  actions?: ActionExecute[];
  msteams?: { width?: "Full" };
}

export function wrap(card: AdaptiveCard): CardEnvelope {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: card,
  };
}
