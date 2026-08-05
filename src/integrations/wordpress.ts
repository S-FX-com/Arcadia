// WordPress REST client for Hermes. Publishes to the `tutorials` custom post
// type under the /how-do-i/ slug prefix, authenticated with an Application
// Password (human-generated, §9.1).

import type { SeoFields } from "../schema/types";

export interface WpEnv {
  WP_BASE_URL: string; // e.g. https://www.s-fx.com
  WP_USERNAME: string; // e.g. sfxdotcom
  WP_APP_PASSWORD: string; // secret
  /** REST base of the tutorials CPT; defaults to "tutorials". */
  WP_TUTORIALS_REST_BASE?: string;
}

export interface WpPostInput {
  title: string;
  content: string;
  excerpt?: string;
  slug: string;
  status: "draft" | "publish";
  meta?: Record<string, string>;
}

export interface WpPost {
  id: number;
  link: string;
  slug: string;
  status: string;
  title: string;
  meta?: Record<string, unknown>;
}

/** WP REST returns rendered fields as { rendered: string }. */
interface WpRawPost extends Omit<WpPost, "title"> {
  title: string | { rendered?: string };
}

function normalizePost(raw: WpRawPost): WpPost {
  return {
    ...raw,
    title: typeof raw.title === "string" ? raw.title : (raw.title?.rendered ?? ""),
  };
}

export class WpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string
  ) {
    super(message);
    this.name = "WpError";
  }
}

function restBase(env: WpEnv): string {
  const cpt = env.WP_TUTORIALS_REST_BASE ?? "tutorials";
  return `${env.WP_BASE_URL.replace(/\/$/, "")}/wp-json/wp/v2/${cpt}`;
}

function authHeader(env: WpEnv): string {
  return `Basic ${btoa(`${env.WP_USERNAME}:${env.WP_APP_PASSWORD}`)}`;
}

async function wpFetch(env: WpEnv, url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new WpError(`WordPress ${init?.method ?? "GET"} ${url} → ${res.status}`, res.status, body.slice(0, 2000));
  }
  return res;
}

export async function createPost(env: WpEnv, input: WpPostInput): Promise<WpPost> {
  const res = await wpFetch(env, restBase(env), {
    method: "POST",
    body: JSON.stringify(input),
  });
  return normalizePost((await res.json()) as WpRawPost);
}

/** Search existing tutorials — used by research/dedupe to avoid cannibalizing. */
export async function searchPosts(env: WpEnv, query: string, limit = 10): Promise<WpPost[]> {
  const url = `${restBase(env)}?search=${encodeURIComponent(query)}&per_page=${limit}&_fields=id,link,slug,title,status`;
  const res = await wpFetch(env, url);
  return ((await res.json()) as WpRawPost[]).map(normalizePost);
}

/** Exact slug lookup — the publish step's idempotency check across retries. */
export async function findBySlug(env: WpEnv, slug: string): Promise<WpPost | undefined> {
  const url = `${restBase(env)}?slug=${encodeURIComponent(slug)}&status=publish,draft&_fields=id,link,slug,title,status`;
  const res = await wpFetch(env, url);
  const posts = ((await res.json()) as WpRawPost[]).map(normalizePost);
  return posts[0];
}

/**
 * Read the SureRank meta keys off a live tutorial post (§9.6). Guessing the
 * keys silently produces posts with no SEO fields, so callers must fail
 * loudly when this returns nothing usable.
 */
export async function readMetaKeys(env: WpEnv, postId: number): Promise<string[]> {
  const res = await wpFetch(env, `${restBase(env)}/${postId}?_fields=meta`);
  const body = (await res.json()) as { meta?: Record<string, unknown> };
  return Object.keys(body.meta ?? {});
}

/** Map generic SEO fields onto the configured SureRank meta keys. */
export function buildMeta(seo: SeoFields): Record<string, string> {
  return { ...seo.sureRankMeta };
}
