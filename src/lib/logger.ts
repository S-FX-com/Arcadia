// Structured JSON logger.
//
// Workers emit one line per call to console.log so the Cloudflare
// log stream stays JSON-shaped. Every entry carries an ISO timestamp,
// a level, an event name, and any caller-supplied fields. A request id
// is propagated when supplied so a single request fans out across log
// lines under one correlation key.

import type { Env } from "../env";

export type Level = "debug" | "info" | "warn" | "error";

// Permissive fields type — accepts plain interfaces (which aren't
// assignable to Record<string, unknown> under strict settings without
// an explicit index signature) plus literal objects.
export type LogFields = Record<string, unknown> | object;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVEL_RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLevel(v: string | undefined): Level {
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

export interface LoggerOpts {
  env?: Pick<Env, "LOG_LEVEL">;
  requestId?: string;
  base?: Record<string, unknown>;
}

export function logger(opts: LoggerOpts = {}): Logger {
  const threshold = LEVEL_RANK[parseLevel(opts.env?.LOG_LEVEL)];
  const base: Record<string, unknown> = {
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.base ?? {}),
  };

  const emit =
    (level: Level) =>
    (event: string, fields?: LogFields): void => {
      if (LEVEL_RANK[level] < threshold) return;
      const line = {
        ts: new Date().toISOString(),
        level,
        event,
        ...base,
        ...((fields ?? {}) as Record<string, unknown>),
      };
      console.log(JSON.stringify(line));
    };

  const self: Logger = {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child(extra) {
      return logger({
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        base: { ...base, ...extra },
      });
    },
  };
  return self;
}
