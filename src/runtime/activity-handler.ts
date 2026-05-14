// Microsoft 365 Agents SDK activity handler.
//
// Bot Framework + Webchat activities arrive here, are normalized to the
// SDK's Activity type, and dispatched through the agent runtime.
//
// Real wiring lands in the Runtime + AI + Memory commit.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";

export async function handleActivity(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
  log: Logger,
): Promise<Response> {
  log.warn("activity_handler_unimplemented");
  return new Response("not implemented", { status: 501 });
}
