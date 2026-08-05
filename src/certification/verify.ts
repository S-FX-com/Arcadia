// Independent verification (§4 M2). This is what makes the ledger real: a
// human signs, Arcadia checks the subset she can, and a signature she
// disproves becomes a false-certification event attributed to the signer and
// surfaced to their lead.
//
// Verdicts are deliberately conservative. "unverifiable" is not a pass — it
// means Arcadia could not check, and the human signature stands alone.

import { ModelRouter, parseJsonBlock } from "../ai/router";
import type { VerifierKind } from "./checklists";

export type Verdict = "pass" | "fail" | "partial" | "unverifiable";

export interface CheckResult {
  verdict: Verdict;
  evidence: string;
}

export interface VerifyContext {
  env: Env;
  /** Rendered page or document URL. Absent for checklists that have none. */
  targetUrl?: string;
  /** Approved source copy, for the copy-diff verifier. */
  approvedCopy?: string;
}

const FETCH_TIMEOUT_MS = 15_000;

/** Guard against pointing a verifier at internal infrastructure. */
export function isPublicHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (host.startsWith("[")) return false;
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

async function fetchPage(url: string): Promise<{ html: string; status: number }> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const html = await res.text();
  return { html, status: res.status };
}

/** Crude tag strip — enough for link/meta/text extraction without a parser. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// links — crawl every link, report non-200s
// ---------------------------------------------------------------------------

export async function verifyLinks(ctx: VerifyContext): Promise<CheckResult> {
  if (!ctx.targetUrl || !isPublicHttpUrl(ctx.targetUrl)) {
    return { verdict: "unverifiable", evidence: "no public target URL to crawl" };
  }
  let page: { html: string; status: number };
  try {
    page = await fetchPage(ctx.targetUrl);
  } catch (err) {
    return { verdict: "fail", evidence: `target unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (page.status >= 400) {
    return { verdict: "fail", evidence: `target itself returned HTTP ${page.status}` };
  }

  const hrefs = [
    ...new Set(
      [...page.html.matchAll(/href="([^"#][^"]*)"/g)]
        .map((m) => absolutize(m[1] as string, ctx.targetUrl as string))
        .filter((u): u is string => !!u && isPublicHttpUrl(u))
    ),
  ].slice(0, 50);

  if (hrefs.length === 0) {
    return { verdict: "unverifiable", evidence: "no crawlable links found on the page" };
  }

  const broken: string[] = [];
  for (const href of hrefs) {
    try {
      const res = await fetch(href, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
      if (res.status >= 400) broken.push(`${href} → ${res.status}`);
    } catch {
      broken.push(`${href} → unreachable`);
    }
  }
  return broken.length === 0
    ? { verdict: "pass", evidence: `${hrefs.length} links checked, all resolve` }
    : {
        verdict: "fail",
        evidence: `${broken.length}/${hrefs.length} links broken: ${broken.slice(0, 8).join("; ")}`,
      };
}

// ---------------------------------------------------------------------------
// meta — title + meta description present
// ---------------------------------------------------------------------------

export async function verifyMeta(ctx: VerifyContext): Promise<CheckResult> {
  if (!ctx.targetUrl || !isPublicHttpUrl(ctx.targetUrl)) {
    return { verdict: "unverifiable", evidence: "no public target URL" };
  }
  let page: { html: string; status: number };
  try {
    page = await fetchPage(ctx.targetUrl);
  } catch (err) {
    return { verdict: "fail", evidence: `target unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.html)?.[1]?.trim() ?? "";
  const desc =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(page.html)?.[1]?.trim() ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(page.html)?.[1]?.trim() ??
    "";

  const problems: string[] = [];
  if (!title) problems.push("no <title>");
  else if (title.length > 65) problems.push(`title ${title.length} chars (over 65)`);
  if (!desc) problems.push("no meta description");
  else if (desc.length > 160) problems.push(`description ${desc.length} chars (over 160)`);

  return problems.length === 0
    ? { verdict: "pass", evidence: `title "${title}" (${title.length}), description ${desc.length} chars` }
    : { verdict: "fail", evidence: problems.join("; ") };
}

// ---------------------------------------------------------------------------
// mobile — render at 390px and look for horizontal overflow
// ---------------------------------------------------------------------------

export async function verifyMobile(ctx: VerifyContext): Promise<CheckResult> {
  if (!ctx.targetUrl || !isPublicHttpUrl(ctx.targetUrl)) {
    return { verdict: "unverifiable", evidence: "no public target URL" };
  }
  if (!ctx.env.BROWSER) {
    return {
      verdict: "unverifiable",
      evidence: "Browser Rendering binding not configured — the 390px check cannot run",
    };
  }
  let browser: Awaited<ReturnType<typeof import("@cloudflare/puppeteer").default.launch>> | undefined;
  try {
    const puppeteer = (await import("@cloudflare/puppeteer")).default;
    browser = await puppeteer.launch(ctx.env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.goto(ctx.targetUrl, { waitUntil: "load", timeout: FETCH_TIMEOUT_MS });
    const overflow = (await page.evaluate(`(() => {
      const docWidth = document.documentElement.scrollWidth;
      const viewport = window.innerWidth;
      const offenders = [];
      for (const el of Array.from(document.body.querySelectorAll('*')).slice(0, 4000)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > viewport + 2) {
          offenders.push((el.tagName || '').toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
        }
      }
      return { docWidth, viewport, offenders: offenders.slice(0, 8) };
    })()`)) as { docWidth: number; viewport: number; offenders: string[] };

    const shot = (await page.screenshot({ fullPage: false })) as unknown as ArrayBuffer;
    const key = `certifications/mobile/${crypto.randomUUID()}.png`;
    await ctx.env.ARTIFACTS.put(key, shot, { httpMetadata: { contentType: "image/png" } });

    const overflows = overflow.docWidth > overflow.viewport + 2 || overflow.offenders.length > 0;
    return overflows
      ? {
          verdict: "fail",
          evidence: `horizontal overflow at 390px: document ${overflow.docWidth}px vs viewport ${overflow.viewport}px${
            overflow.offenders.length ? `; offenders: ${overflow.offenders.join(", ")}` : ""
          }. Screenshot: ${key}`,
        }
      : { verdict: "pass", evidence: `renders within 390px, no overflow. Screenshot: ${key}` };
  } catch (err) {
    return {
      verdict: "unverifiable",
      evidence: `browser render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// forms — partial: detect forms and obvious misconfiguration
// ---------------------------------------------------------------------------

export async function verifyForms(ctx: VerifyContext): Promise<CheckResult> {
  if (!ctx.targetUrl || !isPublicHttpUrl(ctx.targetUrl)) {
    return { verdict: "unverifiable", evidence: "no public target URL" };
  }
  let page: { html: string; status: number };
  try {
    page = await fetchPage(ctx.targetUrl);
  } catch (err) {
    return { verdict: "fail", evidence: `target unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const forms = [...page.html.matchAll(/<form\b([^>]*)>/gi)].map((m) => m[1] ?? "");
  if (forms.length === 0) {
    return { verdict: "unverifiable", evidence: "no <form> found — nothing to check, delivery is unverified" };
  }
  const problems: string[] = [];
  forms.forEach((attrs, i) => {
    const action = /action=["']([^"']*)["']/i.exec(attrs)?.[1];
    if (action === "" || action === "#") problems.push(`form ${i + 1} has an empty action`);
  });
  // Arcadia cannot confirm an email actually lands in an inbox, so a clean
  // structural check is still only "partial" — the signature carries the rest.
  return problems.length > 0
    ? { verdict: "fail", evidence: problems.join("; ") }
    : {
        verdict: "partial",
        evidence: `${forms.length} form(s) present and structurally sound; actual delivery not verified by Arcadia`,
      };
}

// ---------------------------------------------------------------------------
// spellcheck — model pass over the rendered text
// ---------------------------------------------------------------------------

export async function verifySpelling(ctx: VerifyContext, fallbackText?: string): Promise<CheckResult> {
  let text = fallbackText ?? "";
  if (!text && ctx.targetUrl && isPublicHttpUrl(ctx.targetUrl)) {
    try {
      text = textOf((await fetchPage(ctx.targetUrl)).html);
    } catch (err) {
      return { verdict: "fail", evidence: `target unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (!text.trim()) {
    return { verdict: "unverifiable", evidence: "no rendered text available to proofread" };
  }
  const ai = new ModelRouter(ctx.env);
  const raw = await ai.text("spellcheck", {
    system:
      'You are a proofreader. Find only real spelling and grammar errors — not style, not tone, not British vs American spelling. Ignore brand names, product names, and technical terms. Return ONLY JSON: {"errors": [{"text": "<the exact wrong text>", "correction": "<the fix>"}]}. Return an empty array when the copy is clean.',
    prompt: text.slice(0, 12_000),
    jsonSchema: {
      type: "object",
      properties: {
        errors: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, correction: { type: "string" } },
            required: ["text", "correction"],
          },
        },
      },
      required: ["errors"],
    },
    metadata: { job: "certification-spellcheck" },
  });
  let errors: Array<{ text: string; correction: string }>;
  try {
    errors = parseJsonBlock<{ errors: Array<{ text: string; correction: string }> }>(raw).errors ?? [];
  } catch {
    return { verdict: "unverifiable", evidence: "proofreader returned unparseable output" };
  }
  // Only count errors whose text actually appears — models invent quotes.
  const confirmed = errors.filter((e) => e.text && text.includes(e.text)).slice(0, 10);
  return confirmed.length === 0
    ? { verdict: "pass", evidence: `proofread ${text.length} chars, no errors confirmed` }
    : {
        verdict: "fail",
        evidence: `${confirmed.length} error(s): ${confirmed.map((e) => `"${e.text}" → "${e.correction}"`).join("; ")}`,
      };
}

// ---------------------------------------------------------------------------
// copy_diff — partial: does the live copy still match the approved source?
// ---------------------------------------------------------------------------

export async function verifyCopyDiff(ctx: VerifyContext): Promise<CheckResult> {
  if (!ctx.approvedCopy?.trim()) {
    return { verdict: "unverifiable", evidence: "no approved copy supplied to diff against" };
  }
  if (!ctx.targetUrl || !isPublicHttpUrl(ctx.targetUrl)) {
    return { verdict: "unverifiable", evidence: "no public target URL to compare" };
  }
  let live: string;
  try {
    live = textOf((await fetchPage(ctx.targetUrl)).html);
  } catch (err) {
    return { verdict: "fail", evidence: `target unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const approved = textOf(ctx.approvedCopy);
  const ai = new ModelRouter(ctx.env);
  const raw = await ai.text("copy_diff", {
    system:
      'Compare APPROVED copy against LIVE copy. Report only substantive differences — changed claims, numbers, names, prices, or missing sections. Ignore whitespace, ordering of navigation, and boilerplate. Return ONLY JSON: {"differences": ["..."]}. Empty array means the live copy matches.',
    prompt: `APPROVED:\n${approved.slice(0, 6000)}\n\nLIVE:\n${live.slice(0, 6000)}`,
    metadata: { job: "certification-copy-diff" },
  });
  let differences: string[];
  try {
    differences = parseJsonBlock<{ differences: string[] }>(raw).differences ?? [];
  } catch {
    return { verdict: "unverifiable", evidence: "diff returned unparseable output" };
  }
  return differences.length === 0
    ? { verdict: "partial", evidence: "no substantive differences found (semantic diff, not exact)" }
    : { verdict: "fail", evidence: `${differences.length} difference(s): ${differences.slice(0, 6).join("; ")}` };
}

// ---------------------------------------------------------------------------

export async function runVerifier(
  kind: VerifierKind,
  ctx: VerifyContext,
  signedText?: string
): Promise<CheckResult> {
  switch (kind) {
    case "links":
      return verifyLinks(ctx);
    case "meta":
      return verifyMeta(ctx);
    case "mobile":
      return verifyMobile(ctx);
    case "forms":
      return verifyForms(ctx);
    case "spellcheck":
      return verifySpelling(ctx, signedText);
    case "copy_diff":
      return verifyCopyDiff(ctx);
    case "none":
      return { verdict: "unverifiable", evidence: "human-only item — Arcadia cannot verify this" };
  }
}
