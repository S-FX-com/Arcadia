// Action-verb registry.
//
// One entry per verb, keyed by verb.name. executeAction() (the framework
// choke point) is handed a verb from this registry; the framework — not
// the verb — enforces kill switch, ladder, budget, and audit. Adding a
// verb here does not grant it any autonomy: with no action_policy row a
// verb runs at its defaultLevel (never above 'confirm').

import type { ActionVerb } from "../framework";
import { assignTaskVerb } from "./assign-task";
import { completeTaskVerb } from "./complete-task";
import { createTaskVerb } from "./create-task";
import { draftMessageVerb } from "./draft-message";
import { scheduleMeetingVerb } from "./schedule-meeting";
import { sendMailVerb } from "./send-mail";
import { sendMessageVerb } from "./send-message";

export const verbs: Record<string, ActionVerb> = {
  [draftMessageVerb.name]: draftMessageVerb,
  [sendMessageVerb.name]: sendMessageVerb,
  [sendMailVerb.name]: sendMailVerb,
  [scheduleMeetingVerb.name]: scheduleMeetingVerb,
  [createTaskVerb.name]: createTaskVerb,
  [assignTaskVerb.name]: assignTaskVerb,
  [completeTaskVerb.name]: completeTaskVerb,
};

export {
  assignTaskVerb,
  completeTaskVerb,
  createTaskVerb,
  draftMessageVerb,
  scheduleMeetingVerb,
  sendMailVerb,
  sendMessageVerb,
};
export { makeSendMessageVerb } from "./send-message";
export { makeSendMailVerb } from "./send-mail";
export { makeScheduleMeetingVerb } from "./schedule-meeting";
export { makeCreateTaskVerb } from "./create-task";
