// Failure alerting.
//
// alert() always logs at error level and, when ALERT_WEBHOOK_URL is set,
// additionally POSTs a compact JSON payload to that webhook. It is
// fire-and-forget and never throws: any webhook failure is swallowed (logged
// at warn), so alerting can never take down the cron/queue handler that
// called it. Wrap the returned promise in ctx.waitUntil() at call sites so
// the POST is allowed to finish after the handler returns.

import type { Env } from "../env";
import { logger, type Logger } from "./logger";

export interface AlertPayload {
  event: string;
  detail: Record<string, unknown>;
  ts: string;
}

export async function alert(
  env: Pick<Env, "ALERT_WEBHOOK_URL" | "LOG_LEVEL">,
  event: string,
  detail: Record<string, unknown>,
  log?: Logger,
): Promise<void> {
  const l = log ?? logger({ env });
  l.error(event, detail);

  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return;

  const payload: AlertPayload = {
    event,
    detail,
    ts: new Date().toISOString(),
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Never propagate — alerting must not break the caller.
    l.warn("alert_webhook_failed", { event, error: String(e) });
  }
}
