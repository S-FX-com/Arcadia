// Site crawl gatekeeper (Cloudflare OS integration plan, workstream A).
//
// One capability, scoped to exactly one site at mint time: read-only page
// fetches pinned to the root URL's origin, for Phase 4 site planning. There is
// no write method anywhere in this module — not denied, absent. Cross-origin
// and private-network targets are refused, and every fetch is an observation
// logged before the HTML reaches the caller.

import { D1GatekeeperQueue } from "./log";
import {
  GatekeeperDeniedError,
  type ArcadiaActionQueue,
  type GatekeeperContext,
} from "./types";

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
 * private ranges: a crawl target is model- and client-supplied, and a Worker
 * that will fetch 127.0.0.1 on request is an SSRF hole.
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
    throw new GatekeeperDeniedError(`refusing to crawl ${rootUrl}`, "site-crawl");
  }
  const rootHost = new URL(rootUrl).host;
  return {
    rootUrl,
    async fetchPage(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new GatekeeperDeniedError(`not a URL: ${url}`, "site-crawl");
      }
      if (parsed.host !== rootHost) {
        throw new GatekeeperDeniedError(
          `session is scoped to ${rootHost}; refusing ${parsed.host}`,
          "site-crawl"
        );
      }
      if (!isSafeCrawlTarget(url)) {
        throw new GatekeeperDeniedError(`unsafe crawl target: ${url}`, "site-crawl");
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
    queue: new D1GatekeeperQueue(env.DB, "site-crawl", `crawl:${new URL(rootUrl).host}`, ctx),
    fetchPage: async (url) => {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
      return { status: res.status, html: res.status < 400 ? await res.text() : "" };
    },
  });
}
