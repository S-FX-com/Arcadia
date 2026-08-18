// Site planning (§4 Phase 4) — absorbs the sunset Kamino tool.
//
// Crawl → diagnose → propose nav map → spec each page section-by-section
// against the Brixies/ACSS/Bricks stack.
//
// HARD REQUIREMENT: output includes reasoning, not just recommendations. One
// line of rationale per decision. The team has not internalized IA concepts
// after dozens of iterations; an opaque generator makes that permanent and
// leaves Shane as the only person who can evaluate the output. Every type
// here therefore carries a `why`, and the code refuses output that omits it.

import { ModelRouter, parseJsonBlock } from "../ai/router";
import type { SiteCrawlSession } from "../gatekeepers/site-crawl";

export interface CrawledPage {
  url: string;
  title: string;
  h1: string[];
  h2: string[];
  wordCount: number;
  internalLinksOut: string[];
  status: number;
  metaDescription?: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Pages nothing links to — reachable only by knowing the URL. */
  orphans: string[];
  /** Clicks from the home page; > 3 is a finding. */
  depth: Record<string, number>;
  skipped: string[];
}

export interface Diagnosis {
  finding: string;
  /** Why this matters — never omitted. */
  why: string;
  severity: "high" | "medium" | "low";
  pages: string[];
}

export interface NavNode {
  label: string;
  url?: string;
  why: string;
  children?: NavNode[];
}

export interface SectionSpec {
  section: string;
  purpose: string;
  /** Brixies/ACSS/Bricks components to build it with. */
  components: string[];
  copyDirection: string;
  why: string;
}

export interface PageSpec {
  url: string;
  intent: string;
  why: string;
  sections: SectionSpec[];
}

export interface SitePlan {
  diagnoses: Diagnosis[];
  nav: NavNode[];
  pageSpecs: PageSpec[];
}

const MAX_PAGES = 40;
const REASONING_RULE = `Every recommendation MUST carry a "why" — one line explaining the reasoning in plain language a non-specialist can evaluate and disagree with. A recommendation without reasoning is worthless: the team is learning IA from this output, not just following it. Never write "best practice" or "industry standard" as a reason; say what it does for this specific site's visitors.`;

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

function isCrawlable(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return false;
    return !/\.(pdf|zip|jpg|jpeg|png|gif|svg|webp|mp4|css|js)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function extractAll(html: string, re: RegExp): string[] {
  return [...html.matchAll(re)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim()).filter(Boolean);
}

function textLength(html: string): number {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Breadth-first crawl from the root, same host only, capped. Pages are
 * fetched through a site-scoped gatekeeper session
 * (src/gatekeepers/site-crawl.ts): the session refuses anything off the
 * root's origin and logs every fetch as an observation.
 */
export async function crawlSite(session: SiteCrawlSession, maxPages = MAX_PAGES): Promise<CrawlResult> {
  const rootUrl = session.rootUrl;
  if (!isCrawlable(rootUrl)) throw new Error(`refusing to crawl ${rootUrl}`);
  const pages: CrawledPage[] = [];
  const skipped: string[] = [];
  const depth: Record<string, number> = { [rootUrl]: 0 };
  const seen = new Set<string>([rootUrl]);
  const queue: string[] = [rootUrl];
  const linkedTo = new Set<string>();

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift() as string;
    let html: string;
    let status: number;
    try {
      const res = await session.fetchPage(url);
      status = res.status;
      html = res.html;
    } catch {
      skipped.push(url);
      continue;
    }
    if (!html) {
      pages.push({ url, title: "", h1: [], h2: [], wordCount: 0, internalLinksOut: [], status });
      continue;
    }

    const hrefs = [...html.matchAll(/href="([^"#][^"]*)"/g)]
      .map((m) => {
        try {
          return new URL(m[1] as string, url).toString().split("#")[0] as string;
        } catch {
          return undefined;
        }
      })
      .filter((u): u is string => !!u && sameHost(u, rootUrl) && isCrawlable(u));

    for (const href of new Set(hrefs)) {
      linkedTo.add(href);
      if (!seen.has(href) && pages.length + queue.length < maxPages) {
        seen.add(href);
        depth[href] = (depth[url] ?? 0) + 1;
        queue.push(href);
      }
    }

    pages.push({
      url,
      title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "",
      h1: extractAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi),
      h2: extractAll(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi),
      wordCount: textLength(html),
      internalLinksOut: [...new Set(hrefs)],
      status,
      ...(function () {
        const d = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1];
        return d ? { metaDescription: d } : {};
      })(),
    });
  }

  const orphans = pages
    .map((p) => p.url)
    .filter((u) => u !== rootUrl && !linkedTo.has(u));

  return { pages, orphans, depth, skipped };
}

/** Deterministic findings, computed not guessed. */
export function structuralDiagnoses(crawl: CrawlResult): Diagnosis[] {
  const found: Diagnosis[] = [];

  if (crawl.orphans.length > 0) {
    found.push({
      finding: `${crawl.orphans.length} orphan page(s): nothing on the site links to them`,
      why: "A visitor can only reach these by typing the URL or arriving from search, so any effort spent on them is mostly wasted and search engines treat them as low-value.",
      severity: "high",
      pages: crawl.orphans.slice(0, 10),
    });
  }

  const deep = Object.entries(crawl.depth).filter(([, d]) => d > 3).map(([u]) => u);
  if (deep.length > 0) {
    found.push({
      finding: `${deep.length} page(s) sit more than 3 clicks from the home page`,
      why: "Each extra click loses visitors. Anything worth having on the site should be reachable in three moves or fewer from the front door.",
      severity: "medium",
      pages: deep.slice(0, 10),
    });
  }

  const thin = crawl.pages.filter((p) => p.status < 400 && p.wordCount > 0 && p.wordCount < 200);
  if (thin.length > 0) {
    found.push({
      finding: `${thin.length} thin page(s) under 200 words`,
      why: "There is not enough on the page to answer a visitor's question or to rank for anything, so it competes with your stronger pages without earning its place.",
      severity: "medium",
      pages: thin.map((p) => p.url).slice(0, 10),
    });
  }

  const broken = crawl.pages.filter((p) => p.status >= 400);
  if (broken.length > 0) {
    found.push({
      finding: `${broken.length} page(s) returned an error`,
      why: "A visitor who follows an internal link to an error page usually leaves rather than hunting for the right one.",
      severity: "high",
      pages: broken.map((p) => `${p.url} (${p.status})`).slice(0, 10),
    });
  }

  const noMeta = crawl.pages.filter((p) => p.status < 400 && !p.metaDescription);
  if (noMeta.length > 0) {
    found.push({
      finding: `${noMeta.length} page(s) have no meta description`,
      why: "Search engines write their own snippet when you don't, so you lose control of the first sentence a searcher reads about you.",
      severity: "low",
      pages: noMeta.map((p) => p.url).slice(0, 10),
    });
  }

  const multiH1 = crawl.pages.filter((p) => p.h1.length > 1);
  if (multiH1.length > 0) {
    found.push({
      finding: `${multiH1.length} page(s) have more than one H1`,
      why: "Two competing headlines means the page has not decided what it is about, and neither will the visitor.",
      severity: "low",
      pages: multiH1.map((p) => p.url).slice(0, 10),
    });
  }

  // Duplicated intent: pages whose titles collapse to the same subject.
  const byTitle = new Map<string, string[]>();
  for (const p of crawl.pages) {
    if (p.status >= 400 || !p.title) continue;
    const key = p.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 4).join(" ");
    byTitle.set(key, [...(byTitle.get(key) ?? []), p.url]);
  }
  const dupes = [...byTitle.values()].filter((urls) => urls.length > 1);
  if (dupes.length > 0) {
    found.push({
      finding: `${dupes.length} group(s) of pages target the same subject`,
      why: "When two pages answer the same question, they split the visitors and the search ranking between them instead of one page doing the job well.",
      severity: "medium",
      pages: dupes.flat().slice(0, 10),
    });
  }

  return found;
}

const REASONED_ARRAY_RULE = 'Return ONLY JSON. Every object MUST include a "why" field.';

/** Model-assisted diagnosis on top of the structural findings. */
export async function diagnose(ai: ModelRouter, crawl: CrawlResult): Promise<Diagnosis[]> {
  const structural = structuralDiagnoses(crawl);
  const inventory = crawl.pages
    .filter((p) => p.status < 400)
    .map((p) => `${p.url} | "${p.title}" | h1: ${p.h1.join(" / ")} | ${p.wordCount} words`)
    .join("\n");

  const raw = await ai.text("site_ia", {
    system: `You are an information architect reviewing a site. Find problems the structural scan cannot see: missing conversion paths, subjects a visitor would expect and cannot find, navigation labels that describe the company instead of the visitor's task, and pages whose purpose is unclear.

${REASONING_RULE}
${REASONED_ARRAY_RULE} Shape: {"diagnoses": [{"finding", "why", "severity": "high"|"medium"|"low", "pages": ["url"]}]}`,
    prompt: `Site inventory:\n${inventory}\n\nAlready found structurally (do not repeat these):\n${structural.map((d) => `- ${d.finding}`).join("\n")}`,
    metadata: { job: "site-diagnose" },
  });

  let modelFound: Diagnosis[] = [];
  try {
    modelFound = (parseJsonBlock<{ diagnoses: Diagnosis[] }>(raw).diagnoses ?? [])
      // Enforce the hard requirement: no reasoning, no finding.
      .filter((d) => d.finding && d.why && d.why.trim().length > 15)
      .map((d) => ({ ...d, pages: Array.isArray(d.pages) ? d.pages : [] }));
  } catch {
    modelFound = [];
  }
  return [...structural, ...modelFound];
}

export async function proposeNav(ai: ModelRouter, crawl: CrawlResult, diagnoses: Diagnosis[]): Promise<NavNode[]> {
  const inventory = crawl.pages
    .filter((p) => p.status < 400)
    .map((p) => `${p.url} | "${p.title}"`)
    .join("\n");
  const raw = await ai.text("site_ia", {
    system: `Propose a navigation map. Group pages by the visitor's task, not by the company's internal structure. Prefer labels a visitor would say out loud. Keep everything within three clicks of the home page.

${REASONING_RULE}
${REASONED_ARRAY_RULE} Shape: {"nav": [{"label", "url"?, "why", "children"?: [same shape]}]}`,
    prompt: `Pages:\n${inventory}\n\nProblems to fix with this structure:\n${diagnoses.map((d) => `- ${d.finding}`).join("\n")}`,
    metadata: { job: "site-nav" },
  });
  try {
    const nav = parseJsonBlock<{ nav: NavNode[] }>(raw).nav ?? [];
    const prune = (nodes: NavNode[]): NavNode[] =>
      nodes
        .filter((n) => n.label && n.why && n.why.trim().length > 10)
        .map((n) => ({ ...n, ...(n.children ? { children: prune(n.children) } : {}) }));
    return prune(nav);
  } catch {
    return [];
  }
}

export async function specPage(ai: ModelRouter, page: CrawledPage, nav: NavNode[]): Promise<PageSpec | undefined> {
  const raw = await ai.text("site_page_spec", {
    system: `Spec this page section by section for a build on the Brixies / Automatic.css (ACSS) / Bricks Builder stack. Name real components and ACSS utility classes where they apply. Each section states its purpose, the copy direction, and why the section belongs on the page at all.

${REASONING_RULE}
${REASONED_ARRAY_RULE} Shape: {"intent", "why", "sections": [{"section", "purpose", "components": ["..."], "copyDirection", "why"}]}`,
    prompt: `Page: ${page.url}\nCurrent title: "${page.title}"\nCurrent H1: ${page.h1.join(" / ")}\nCurrent H2s: ${page.h2.join(" / ")}\nWord count: ${page.wordCount}\n\nProposed site navigation:\n${JSON.stringify(nav).slice(0, 2000)}`,
    metadata: { job: "site-page-spec" },
  });
  try {
    const parsed = parseJsonBlock<Omit<PageSpec, "url">>(raw);
    if (!parsed.intent || !parsed.why) return undefined;
    const sections = (parsed.sections ?? []).filter((s) => s.section && s.why && s.why.trim().length > 10);
    if (sections.length === 0) return undefined;
    return { url: page.url, intent: parsed.intent, why: parsed.why, sections };
  } catch {
    return undefined;
  }
}
