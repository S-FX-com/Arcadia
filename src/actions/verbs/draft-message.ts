// draft_message — prepare a message draft, never send.
//
// This verb's execute() is pure: it returns the draft so the framework
// can surface it for a human to send. It is the 'draft'-level sibling of
// send_message; its defaultLevel is 'draft' so that even with no policy
// row Arcadia will prepare-but-not-send.

import type { ActionVerb } from "../framework";
import { asObject, clip, optString, reqString } from "./_util";

export interface DraftMessageParams {
  text: string;
  channelId?: string;
  chatId?: string;
}

export interface MessageDraft {
  text: string;
  channelId?: string;
  chatId?: string;
}

export const draftMessageVerb: ActionVerb<DraftMessageParams> = {
  name: "draft_message",
  defaultLevel: "draft",

  parse(raw): DraftMessageParams {
    const o = asObject(raw);
    const text = reqString(o, "text");
    const channelId = optString(o, "channelId");
    const chatId = optString(o, "chatId");
    return {
      text,
      ...(channelId ? { channelId } : {}),
      ...(chatId ? { chatId } : {}),
    };
  },

  describe(p): string {
    const target = p.channelId ?? p.chatId;
    return target
      ? `Draft message to ${target}: "${clip(p.text)}"`
      : `Draft message: "${clip(p.text)}"`;
  },

  async execute(_ctx, p) {
    const draft: MessageDraft = {
      text: p.text,
      ...(p.channelId ? { channelId: p.channelId } : {}),
      ...(p.chatId ? { chatId: p.chatId } : {}),
    };
    return { ok: true, detail: { draft } };
  },
};
