// Shared helpers for action verbs.
//
// Two concerns live here so the individual verb modules stay tiny:
//
//   1. Param validation — verbs receive `unknown` raw params (from a card
//      submit, an MCP tool call, a routine step) and must fail closed on
//      anything malformed. These guards throw, which executeAction turns
//      into a 'rejected' outcome without ever calling execute().
//
//   2. Injectable seams — the outbound-write verbs (mail, calendar,
//      channel post, Planner push) call Graph / Bot Framework / Planner.
//      Tests substitute a spy for the seam and assert the request shape
//      without touching the network. The seam types are deliberately the
//      *narrow* call signature the verbs use (not `typeof graph`, whose
//      generic return type a plain spy can't satisfy), so a fake is a
//      one-line arrow.

import type { Env } from "../../env";
import type { GraphRequest } from "../../graph/client";
import type { Logger } from "../../lib/logger";
import type { BotActor, ConversationRef } from "../../runtime/bot-outbound";
import type { PushOpts } from "../../tasks/planner-sync";
import type { Task } from "../../tasks/types";

// --- Injectable seams -------------------------------------------------------

export type GraphFn = (env: Env, req: GraphRequest) => Promise<unknown>;
export type OboTokenFn = (env: Env, userToken: string) => Promise<string>;
export type PostTextFn = (
  env: Env,
  ref: ConversationRef,
  text: string,
  log: Logger,
  opts?: { from?: BotActor },
) => Promise<void>;
export type PushTaskFn = (
  env: Env,
  task: Task,
  opts: PushOpts,
  log: Logger,
) => Promise<string | null>;

/** Seam bundle for verbs that make a delegated (OBO) Graph write. */
export interface GraphDeps {
  graph: GraphFn;
  delegatedGraphToken: OboTokenFn;
}

// --- Param validation -------------------------------------------------------

export function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("params must be an object");
  }
  return raw as Record<string, unknown>;
}

export function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string: ${key}`);
  }
  return v;
}

export function optString(
  o: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`invalid string: ${key}`);
  return v;
}

export function reqStringArray(
  o: Record<string, unknown>,
  key: string,
): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`missing required array: ${key}`);
  }
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`invalid string in array: ${key}`);
    }
  }
  return v as string[];
}

/** Clip free text for a one-line describe() summary. */
export function clip(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
