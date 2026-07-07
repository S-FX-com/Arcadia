// send_mail — send mail as the staff user via delegated (OBO) Graph.
//
// This is an *access-plane* write: the mail must come from the human's own
// mailbox, so a delegated token is mandatory. ctx.userToken carries the
// verified user token; it is exchanged for a Graph token via On-Behalf-Of
// and used to POST /me/sendMail. With no userToken the verb fails closed
// with 'delegated_required' rather than silently falling back to app-only.

import type { ActionVerb } from "../framework";
import { graph } from "../../graph/client";
import { delegatedGraphToken } from "../../graph/delegated";
import {
  asObject,
  clip,
  optString,
  reqString,
  reqStringArray,
  type GraphDeps,
} from "./_util";

export interface SendMailParams {
  to: string[];
  subject: string;
  body: string;
}

export function makeSendMailVerb(
  deps: GraphDeps = { graph, delegatedGraphToken },
): ActionVerb<SendMailParams> {
  return {
    name: "send_mail",
    defaultLevel: "confirm",

    parse(raw): SendMailParams {
      const o = asObject(raw);
      return {
        to: reqStringArray(o, "to"),
        subject: reqString(o, "subject"),
        // Allow an empty body string.
        body: optString(o, "body") ?? "",
      };
    },

    describe(p): string {
      return `Send mail to ${p.to.join(", ")}: "${clip(p.subject)}"`;
    },

    async execute(ctx, p) {
      if (!ctx.userToken) return { ok: false, error: "delegated_required" };
      const token = await deps.delegatedGraphToken(ctx.env, ctx.userToken);
      await deps.graph(ctx.env, {
        method: "POST",
        path: "/me/sendMail",
        token,
        body: {
          message: {
            subject: p.subject,
            body: { contentType: "Text", content: p.body },
            toRecipients: p.to.map((address) => ({
              emailAddress: { address },
            })),
          },
          saveToSentItems: true,
        },
      });
      return { ok: true, detail: { to: p.to, subject: p.subject } };
    },
  };
}

export const sendMailVerb = makeSendMailVerb();
