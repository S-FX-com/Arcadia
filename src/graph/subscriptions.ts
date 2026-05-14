// Microsoft Graph change-notification webhook.
//
// Handles:
//   - Validation handshake (returns validationToken in plain text)
//   - Normal notifications (verifies clientState HMAC, fans out to handlers)
//   - Lifecycle events (renew / re-authorize)
//
// Today only the validation handshake is wired so subscriptions can be
// created. Notification fan-out lands in the Graph commit.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";

export async function handleGraphNotification(
  request: Request,
  _env: Env,
  _ctx: ExecutionContext,
  log: Logger,
): Promise<Response> {
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    log.info("graph_validation_handshake");
    return new Response(validationToken, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  log.warn("graph_notification_unimplemented");
  return new Response("not implemented", { status: 501 });
}
