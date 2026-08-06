// WordPress Gatekeeper (Cloudflare OS integration plan, workstream A).
//
// Two capabilities, each scoped to exactly one resource at mint time:
//
//   openTutorialsSession  — the S-FX tutorials CPT on WP_BASE_URL. The only
//     methods that exist are the ones Hermes needs: search, slug lookup, meta
//     read (observations) and createPost (an action). There is no update and
//     no delete — not denied, absent. Publishing live requires recorded human
//     authorization that this module verifies against the approvals table;
//     the Application Password never leaves src/integrations/wordpress.ts,
//     which nothing outside this gatekeeper may import.
//
//   openSiteCrawlSession — read-only page fetches pinned to one site's origin
//     (site planning, Phase 4). Cross-origin and private-network targets are
//     refused; every fetch is an observation.

import {
  createPost as wpCreatePost,
  findBySlug as wpFindBySlug,
  readMetaKeys as wpReadMetaKeys,
  searchPosts as wpSearchPosts,
  type WpPost,
  type WpPostInput,
} from "../integrations/wordpress";
import { autoPublishAllowed, killSwitch } from "../lib/controls";
import { D1GatekeeperQueue } from "./log";
import {
  GatekeeperDeniedError,
  type ActionAuthorization,
  type ActionKind,
  type ArcadiaActionQueue,
  type GatekeeperContext,
  type ResourceDescription,
} from "./types";

export const WP_ACTION_KINDS = {
  /** Not client-visible — safe to auto-apply (OS autoApprovable semantics). */
  createDraft: { tag: "wp.create_draft", label: "Create WordPress draft" },
  /** Live on the public site — always needs recorded human authorization. */
  publishPost: { tag: "wp.publish_post", label: "Publish WordPress post" },
} satisfies Record<string, ActionKind>;

// ---------------------------------------------------------------------------
// Tutorials CPT session (credentialed).
// ---------------------------------------------------------------------------

export interface TutorialsSession {
  describe(): ResourceDescription;
  /** Search existing tutorials (research / dedupe). Observation. */
  searchPosts(query: string, limit?: number): Promise<WpPost[]>;
  /** Exact slug lookup (publish idempotency). Observation. */
  findBySlug(slug: string): Promise<WpPost | undefined>;
  /** SureRank meta keys off a live post (§9.6). Observation. */
  readMetaKeys(postId: number): Promise<string[]>;
  /**
   * Create a post. A draft applies on its own (never client-visible); status
   * "publish" refuses to apply without authorization the gatekeeper can
   * verify — a real approved approvals row, or the auto-publish control a
   * human enabled after 60 clean days. The kill switch is re-checked here so
   * even a drifted caller cannot publish past it.
   */
  createPost(input: WpPostInput, authorization?: ActionAuthorization): Promise<WpPost>;
}

/** Injectable seams so policy is unit-testable without WordPress or D1. */
export interface TutorialsPorts {
  queue: ArcadiaActionQueue;
  wp: {
    createPost(input: WpPostInput): Promise<WpPost>;
    searchPosts(query: string, limit?: number): Promise<WpPost[]>;
    findBySlug(slug: string): Promise<WpPost | undefined>;
    readMetaKeys(postId: number): Promise<string[]>;
  };
  killSwitchEngaged(): Promise<boolean>;
  autoPublishAllowed(): Promise<boolean>;
  /** Look up an approvals row that a human has already approved. */
  approvedApproval(approvalId: string): Promise<{ decidedBy: string } | null>;
}

export function tutorialsResource(env: { WP_BASE_URL: string; WP_TUTORIALS_REST_BASE?: string }): string {
  const host = new URL(env.WP_BASE_URL).host;
  return `wp:${host}:${env.WP_TUTORIALS_REST_BASE ?? "tutorials"}`;
}

export function tutorialsSessionFromPorts(resource: string, ports: TutorialsPorts): TutorialsSession {
  return {
    describe(): ResourceDescription {
      return {
        url: `https://${resource.split(":")[1]}/`,
        title: "S-FX tutorials",
        snippet: "The tutorials custom post type under /how-do-i/ on the S-FX site.",
        suggestedBindingName: "SFX_TUTORIALS",
        tsType: "SfxTutorials",
      };
    },

    async searchPosts(query, limit = 10) {
      const posts = await ports.wp.searchPosts(query, limit);
      await ports.queue.authorizeObservation({
        title: `Searched tutorials for "${query.slice(0, 80)}"`,
        description: `${posts.length} result(s): ${posts.map((p) => p.slug).join(", ") || "none"}`,
      });
      return posts;
    },

    async findBySlug(slug) {
      const post = await ports.wp.findBySlug(slug);
      await ports.queue.authorizeObservation({
        title: `Looked up tutorial slug "${slug}"`,
        description: post ? `Found post ${post.id} (${post.status})` : "No post with that slug",
      });
      return post;
    },

    async readMetaKeys(postId) {
      const keys = await ports.wp.readMetaKeys(postId);
      await ports.queue.authorizeObservation({
        title: `Read meta keys off post ${postId}`,
        description: `Keys: ${keys.join(", ") || "(none exposed)"}`,
      });
      return keys;
    },

    async createPost(input, authorization) {
      const publishing = input.status === "publish";
      const kind = publishing ? WP_ACTION_KINDS.publishPost : WP_ACTION_KINDS.createDraft;
      const actionKey = `${kind.tag}:${input.slug}`;
      await ports.queue.submitAction(actionKey, {
        title: `${publishing ? "Publish" : "Draft"}: ${input.title.slice(0, 120)}`,
        description: `slug "${input.slug}", ${input.content.length} chars, meta keys: ${Object.keys(input.meta ?? {}).join(", ") || "none"}`,
        implementsRevert: false,
        actionKind: kind,
        ...(publishing ? {} : { autoApprovable: true }),
      });

      try {
        if (publishing) {
          if (await ports.killSwitchEngaged()) {
            throw new GatekeeperDeniedError("kill switch is engaged — publish refused", "wordpress");
          }
          if (!authorization) {
            throw new GatekeeperDeniedError(
              "publishing live requires human authorization and none was provided",
              "wordpress"
            );
          }
          // Verify the evidence, don't trust the caller's word for it.
          if (authorization.kind === "human_approval") {
            const row = await ports.approvedApproval(authorization.approvalId);
            if (!row || row.decidedBy !== authorization.decidedBy) {
              throw new GatekeeperDeniedError(
                `approval ${authorization.approvalId} is not an approved decision by ${authorization.decidedBy}`,
                "wordpress"
              );
            }
          } else if (authorization.kind === "auto_publish") {
            if (!(await ports.autoPublishAllowed())) {
              throw new GatekeeperDeniedError(
                "auto-publish is not enabled (60-day draft-first rule, §4)",
                "wordpress"
              );
            }
          } else {
            throw new GatekeeperDeniedError(
              `authorization kind "${authorization.kind}" cannot publish content`,
              "wordpress"
            );
          }
          await ports.queue.recordDecision(actionKey, authorization);
        } else {
          await ports.queue.recordDecision(actionKey);
        }

        const post = await ports.wp.createPost(input);
        await ports.queue.recordApplied(actionKey, `post ${post.id} → ${post.link}`);
        return post;
      } catch (err) {
        await ports.queue.recordFailed(actionKey, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
  };
}

/** Production wiring: D1-backed queue, real WP client, real controls. */
export function openTutorialsSession(env: Env, ctx: GatekeeperContext): TutorialsSession {
  const resource = tutorialsResource(env);
  return tutorialsSessionFromPorts(resource, {
    queue: new D1GatekeeperQueue(env.DB, "wordpress", resource, ctx),
    wp: {
      createPost: (input) => wpCreatePost(env, input),
      searchPosts: (query, limit) => wpSearchPosts(env, query, limit),
      findBySlug: (slug) => wpFindBySlug(env, slug),
      readMetaKeys: (postId) => wpReadMetaKeys(env, postId),
    },
    killSwitchEngaged: async () => (await killSwitch(env)).engaged,
    autoPublishAllowed: () => autoPublishAllowed(env.DB),
    approvedApproval: async (approvalId) => {
      const row = await env.DB.prepare(
        `SELECT decided_by FROM approvals WHERE id = ?1 AND status = 'approved'`
      )
        .bind(approvalId)
        .first<{ decided_by: string | null }>();
      return row?.decided_by ? { decidedBy: row.decided_by } : null;
    },
  });
}

// ---------------------------------------------------------------------------
// Site crawl session (read-only, uncredentialed, one origin).
// ---------------------------------------------------------------------------

export interface CrawlFetchResult {
  status: number;
  html: string;
}

export interface SiteCrawlSession {
  readonly rootUrl: string;
  /** Fetch one page inside the session's origin. Observation. */
  fetchPage(url: string): Promise<CrawlFetchResult>;
}

/**
 * A crawl-injected URL must not aim the Worker at loopback, link-local, or
 * private ranges — same posture as the Hermes link check.
 */
export function isSafeCrawlTarget(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (host.startsWith("[")) return false; // IPv6 literals — not worth allowlisting
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a = 0, b = 0] = host.split(".").map(Number);
      if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface CrawlPorts {
  queue: Pick<ArcadiaActionQueue, "authorizeObservation">;
  fetchPage(url: string): Promise<CrawlFetchResult>;
}

export function crawlSessionFromPorts(rootUrl: string, ports: CrawlPorts): SiteCrawlSession {
  if (!isSafeCrawlTarget(rootUrl)) {
    throw new GatekeeperDeniedError(`refusing to crawl ${rootUrl}`, "wordpress");
  }
  const rootHost = new URL(rootUrl).host;
  return {
    rootUrl,
    async fetchPage(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new GatekeeperDeniedError(`not a URL: ${url}`, "wordpress");
      }
      if (parsed.host !== rootHost) {
        throw new GatekeeperDeniedError(
          `session is scoped to ${rootHost}; refusing ${parsed.host}`,
          "wordpress"
        );
      }
      if (!isSafeCrawlTarget(url)) {
        throw new GatekeeperDeniedError(`unsafe crawl target: ${url}`, "wordpress");
      }
      const result = await ports.fetchPage(url);
      await ports.queue.authorizeObservation({
        title: `Crawled ${parsed.pathname || "/"}`,
        description: `${url} → HTTP ${result.status}, ${result.html.length} chars`,
      });
      return result;
    },
  };
}

/** Production wiring for the Phase 4 site-plan crawl. */
export function openSiteCrawlSession(env: Env, ctx: GatekeeperContext, rootUrl: string): SiteCrawlSession {
  return crawlSessionFromPorts(rootUrl, {
    queue: new D1GatekeeperQueue(env.DB, "wordpress", `crawl:${new URL(rootUrl).host}`, ctx),
    fetchPage: async (url) => {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
      return { status: res.status, html: res.status < 400 ? await res.text() : "" };
    },
  });
}
