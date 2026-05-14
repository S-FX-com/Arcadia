// Structured logger. Emits one JSON line per call to stdout, which
// `wrangler tail` surfaces. Level filtering via LOG_LEVEL env var
// (defaults to "info").

import type { Env } from "../env";

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
  with: (fields: Record<string, unknown>) => Logger;
}

export function logger(ctx: {
  env: Env;
  requestId?: string;
  extra?: Record<string, unknown>;
}): Logger {
  const min = ORDER[(ctx.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

  const emit = (
    level: Level,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (ORDER[level] < min) return;
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        requestId: ctx.requestId,
        ...ctx.extra,
        ...fields,
      }),
    );
  };

  const make = (extra: Record<string, unknown>): Logger => ({
    debug: (m, f) => emit("debug", m, { ...extra, ...f }),
    info: (m, f) => emit("info", m, { ...extra, ...f }),
    warn: (m, f) => emit("warn", m, { ...extra, ...f }),
    error: (m, f) => emit("error", m, { ...extra, ...f }),
    with: (f) => make({ ...extra, ...f }),
  });

  return make({});
}
