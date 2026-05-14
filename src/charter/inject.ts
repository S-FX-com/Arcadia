// Charter injection into system prompts.
//
// Every assistant call-site that builds a system prompt for the
// router should wrap it with injectCharter() so the active charter
// rides along as canonical context.
//
// The charter is cached in KV for a short window so we don't hit D1
// on every request — the charter changes rarely and the staleness
// bound is the user-visible upper bound on "how long until my edit
// takes effect". CHARTER_CACHE_TTL_SECONDS keeps it small (60s by
// default).

import type { Env } from "../env";
import { CharterStore } from "./store";

const CACHE_KEY = "charter:active:v1";
const CACHE_TTL_SECONDS = 60;

interface CachedCharter {
  body: string | null;
  version: number;
}

/**
 * Returns `base` with the active charter inserted ahead of it. If no
 * charter has been published, returns `base` unchanged.
 */
export async function injectCharter(
  env: Env,
  base: string,
): Promise<string> {
  const charter = await readActive(env);
  if (!charter || !charter.body) return base;
  return `${charterPreamble(charter.body)}\n\n${base}`;
}

/** Returns just the active charter body, or null. */
export async function activeCharterBody(env: Env): Promise<string | null> {
  return (await readActive(env)).body;
}

async function readActive(env: Env): Promise<CachedCharter> {
  const cached = (await env.ARCADIA_CACHE.get(CACHE_KEY, {
    type: "json",
  })) as CachedCharter | null;
  if (cached) return cached;

  const store = new CharterStore(env);
  const active = await store.active();
  const fresh: CachedCharter = {
    body: active?.body ?? null,
    version: active?.version ?? 0,
  };
  await env.ARCADIA_CACHE.put(CACHE_KEY, JSON.stringify(fresh), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
  return fresh;
}

/** Invalidate the KV cache — call after CharterStore.publish(). */
export async function invalidateCharterCache(env: Env): Promise<void> {
  await env.ARCADIA_CACHE.delete(CACHE_KEY);
}

function charterPreamble(body: string): string {
  return `Operator charter — canonical ground truth (overrides inferred memory):\n${body.trim()}`;
}
