// Hermes publish chain (§4 Phase 1a). Each step is independently durable and
// retryable: selectTopic → research → draft → brandCheck → seoFields →
// linkCheck → approvalGate → publish → log. The approval gate is a human tap
// on the Cloudflare Access-protected dashboard — never a Teams card, never
// skipped inside the 60-day draft-first window.

import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import type { Hermes } from "../agents/hermes";
import { haiku, sonnet } from "../integrations/anthropic";
import { createPost, findBySlug, searchPosts } from "../integrations/wordpress";
import { appendAudit } from "../lib/audit";
import { brandViolations, VOICE_RULES } from "../lib/brand";
import {
  autoPublishAllowed,
  killSwitch,
  nextPublishWindowStart,
  withinPublishWindow,
} from "../lib/controls";
import { DOCTRINE_CANONICAL } from "../memory/driver";
import { embedText, SelfHostedMemoryDriver } from "../memory/self-hosted";
import type { PublishParams, PublishProgress } from "../schema/types";

const NET_RETRY: WorkflowStepConfig = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};
const LLM_RETRY: WorkflowStepConfig = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};

/** Semantic-dedupe threshold against published_log (cosine on bge-base 768). */
const DUPLICATE_SCORE = 0.86;

interface TopicRow {
  id: string;
  title: string;
  keywords: string;
  notes: string | null;
  priority: number;
  status: string;
}

interface SelectedTopic {
  id: string;
  title: string;
  keywords: string[];
  notes?: string;
}

interface Research {
  internal: Array<{ title: string; url: string; slug: string }>;
  external: Array<{ title: string; url: string }>;
  serpSkipped: boolean;
}

interface Draft {
  title: string;
  html: string;
  excerpt: string;
  doctrineEntries: string[];
}

interface Seo {
  slug: string;
  metaTitle: string;
  metaDescription: string;
  meta: Record<string, string>;
}

interface ApprovalPayload {
  approved: boolean;
  reason?: string;
  metadata?: { email?: string };
}

function parseJsonBlock<T>(raw: string): T {
  const stripped = raw.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`model returned no JSON object: ${raw.slice(0, 200)}`);
  return JSON.parse(stripped.slice(start, end + 1)) as T;
}

/**
 * linkCheck fetches URLs out of LLM-generated HTML — a prompt-injected draft
 * must not be able to aim the Worker at loopback/link-local/private targets.
 */
function isCheckableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a = 0, b = 0] = host.split(".").map(Number);
      if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254))
        return false;
    }
    if (host.startsWith("[")) return false; // IPv6 literals — not worth allowlisting
    return true;
  } catch {
    return false;
  }
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

export class PublishWorkflow extends AgentWorkflow<Hermes, PublishParams, PublishProgress, Env> {
  async run(event: AgentWorkflowEvent<PublishParams>, step: AgentWorkflowStep) {
    const env = this.env;
    const workflowId = this.workflowId;
    const params = event.payload;

    // -- 0. Controls gate — kill switch checked at workflow start (§4). ------
    const halted = await step.do("check-kill-switch", async () => {
      const ks = await killSwitch(env);
      return ks.engaged ? `kill switch engaged by ${ks.by ?? "unknown"}` : null;
    });
    if (halted) {
      await step.reportComplete({ skipped: halted });
      return { skipped: halted };
    }

    // -- 1. selectTopic — D1 queue + semantic dedupe vs published_log. -------
    await this.reportProgress({ step: "selectTopic", status: "running", percent: 0.05 });
    const topic = await step.do("select-topic", NET_RETRY, async (): Promise<SelectedTopic | null> => {
      const candidates = params.requestedTopicId
        ? await env.DB.prepare(`SELECT * FROM topics WHERE id = ?1 AND status = 'queued'`)
            .bind(params.requestedTopicId)
            .all<TopicRow>()
        : await env.DB.prepare(
            `SELECT * FROM topics WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 5`
          ).all<TopicRow>();

      for (const row of candidates.results) {
        const keywords = JSON.parse(row.keywords || "[]") as string[];
        const vector = await embedText(env, `${row.title} ${keywords.join(" ")}`);
        const near = await env.VEC_PUBLISHED_LOG.query(vector, { topK: 1 });
        const top = near.matches[0];
        if (top && top.score >= DUPLICATE_SCORE) {
          await env.DB.prepare(
            `UPDATE topics SET status = 'duplicate', last_error = ?1, updated_at = datetime('now') WHERE id = ?2`
          )
            .bind(`semantic duplicate of published ${top.id} (score ${top.score.toFixed(3)})`, row.id)
            .run();
          continue;
        }
        const claim = await env.DB.prepare(
          `UPDATE topics SET status = 'in_progress', workflow_id = ?1, updated_at = datetime('now')
           WHERE id = ?2 AND status = 'queued'`
        )
          .bind(workflowId, row.id)
          .run();
        if ((claim.meta.changes ?? 0) === 1) {
          return {
            id: row.id,
            title: row.title,
            keywords,
            ...(row.notes ? { notes: row.notes } : {}),
          };
        }
      }
      return null;
    });
    if (!topic) {
      await step.reportComplete({ skipped: "no eligible topics in queue" });
      return { skipped: "no_topics" };
    }

    // -- 2. research — internal WP posts + optional SERP check. --------------
    await this.reportProgress({ step: "research", status: "running", percent: 0.15, topicId: topic.id });
    const research = await step.do("research", NET_RETRY, async (): Promise<Research> => {
      const internal = (await searchPosts(env, topic.title, 8)).map((p) => ({
        title: typeof p === "object" && "title" in p ? String((p as { title: { rendered?: string } | string }).title instanceof Object ? (p.title as { rendered?: string }).rendered ?? "" : p.title) : "",
        url: p.link,
        slug: p.slug,
      }));
      let external: Research["external"] = [];
      let serpSkipped = true;
      if (env.SERPAPI_KEY) {
        const res = await fetch(
          `https://serpapi.com/search.json?engine=google&num=5&q=${encodeURIComponent(topic.title)}&api_key=${env.SERPAPI_KEY}`
        );
        if (res.ok) {
          const body = (await res.json()) as { organic_results?: Array<{ title: string; link: string }> };
          external = (body.organic_results ?? []).slice(0, 5).map((r) => ({ title: r.title, url: r.link }));
          serpSkipped = false;
        }
      }
      return { internal, external, serpSkipped };
    });

    // -- 3. draft — Sonnet, recalling voice/positioning from doctrine. -------
    await this.reportProgress({ step: "draft", status: "running", percent: 0.3, topicId: topic.id });
    const doctrine = await step.do("recall-doctrine", NET_RETRY, async () => {
      const profile = await new SelfHostedMemoryDriver(env).getProfile(DOCTRINE_CANONICAL);
      const recalled = await profile.recall(
        `voice, positioning, and rules relevant to a tutorial titled: ${topic.title}`,
        { limit: 6 }
      );
      return recalled.memories.map((m) => ({ id: m.id, content: m.content }));
    });

    const draft = await step.do("draft", LLM_RETRY, async (): Promise<Draft> => {
      const doctrineBlock = doctrine.length
        ? `Doctrine to honor (canonical, ratified):\n${doctrine.map((d) => `- ${d.content}`).join("\n")}`
        : "No doctrine entries recalled yet — apply the voice rules strictly.";
      const internalLinks = research.internal
        .slice(0, 4)
        .map((p) => `- ${p.title}: ${p.url}`)
        .join("\n");
      const raw = await sonnet(env, {
        system: `You write SEO tutorials for s-fx.com under the /how-do-i/ prefix.\n${VOICE_RULES}\n${doctrineBlock}\nReturn ONLY a JSON object: {"title": string, "html": string, "excerpt": string}. html is the post body (h2/h3/p/ul/ol/code, no <html> wrapper). Where genuinely relevant, link to existing posts from the list provided.`,
        prompt: `Topic: ${topic.title}\nKeywords: ${topic.keywords.join(", ")}\n${topic.notes ? `Notes: ${topic.notes}\n` : ""}Existing related posts (link only if relevant):\n${internalLinks || "(none)"}\n${research.external.length ? `Competing results to outdo, not copy:\n${research.external.map((r) => `- ${r.title}`).join("\n")}` : ""}`,
        maxTokens: 8000,
        metadata: { job: "hermes-draft", workflow: workflowId },
      });
      const parsed = parseJsonBlock<{ title: string; html: string; excerpt: string }>(raw);
      if (!parsed.title || !parsed.html) throw new Error("draft JSON missing title or html");
      return { ...parsed, doctrineEntries: doctrine.map((d) => d.id) };
    });

    // -- 4. brandCheck — deterministic + one revision, then fail loudly. -----
    await this.reportProgress({ step: "brandCheck", status: "running", percent: 0.45, topicId: topic.id });
    const checked = await step.do("brand-check", LLM_RETRY, async (): Promise<Draft> => {
      let current = draft;
      let violations = brandViolations(`${current.title} ${current.html} ${current.excerpt}`);
      if (violations.length > 0) {
        const raw = await sonnet(env, {
          system: `${VOICE_RULES}\nRewrite the post to remove every occurrence of the banned terms while keeping the meaning. Return ONLY JSON: {"title": string, "html": string, "excerpt": string}.`,
          prompt: `Banned terms found: ${violations.join(", ")}\n\n${JSON.stringify({ title: current.title, html: current.html, excerpt: current.excerpt })}`,
          maxTokens: 8000,
          metadata: { job: "hermes-brand-revise", workflow: workflowId },
        });
        const revised = parseJsonBlock<{ title: string; html: string; excerpt: string }>(raw);
        current = { ...revised, doctrineEntries: current.doctrineEntries };
        violations = brandViolations(`${current.title} ${current.html} ${current.excerpt}`);
      }
      if (violations.length > 0) {
        throw new Error(`brandCheck failed after revision — banned terms remain: ${violations.join(", ")}`);
      }
      return current;
    });

    // -- 5. seoFields — SureRank keys are read off a live post, never guessed.
    await this.reportProgress({ step: "seoFields", status: "running", percent: 0.55, topicId: topic.id });
    const seo = await step.do("seo-fields", LLM_RETRY, async (): Promise<Seo> => {
      // `||`, not `??` — the var ships as "" in wrangler.jsonc, and an empty
      // string must fall through to the KV override.
      const rawKeys = env.SURERANK_META_KEYS || (await env.CONTROL.get("config:surerank_meta_keys"));
      if (!rawKeys) {
        // Guessing silently produces posts with no SEO fields — worse than
        // failing loudly (§9.6).
        throw new Error(
          "SureRank meta keys not configured. Pull a live tutorial post with ?_fields=meta, then set SURERANK_META_KEYS (or KV config:surerank_meta_keys) to the actual keys (§9.6)."
        );
      }
      const keys = JSON.parse(rawKeys) as Record<string, string>;
      if (!keys.title || !keys.description) {
        throw new Error(`SURERANK_META_KEYS must map "title" and "description" to real meta keys; got: ${rawKeys}`);
      }
      const raw = await haiku(env, {
        system: `Write SEO fields. Return ONLY JSON: {"metaTitle": string (<= 60 chars), "metaDescription": string (<= 155 chars)}.`,
        prompt: `Post title: ${checked.title}\nExcerpt: ${checked.excerpt}\nKeywords: ${topic.keywords.join(", ")}`,
        maxTokens: 300,
        metadata: { job: "hermes-seo", workflow: workflowId },
      });
      const fields = parseJsonBlock<{ metaTitle: string; metaDescription: string }>(raw);
      return {
        // The /how-do-i/ prefix comes from the tutorials CPT permalink
        // structure in WordPress, not the slug itself.
        slug: slugify(checked.title),
        metaTitle: fields.metaTitle.slice(0, 60),
        metaDescription: fields.metaDescription.slice(0, 155),
        meta: {
          [keys.title]: fields.metaTitle.slice(0, 60),
          [keys.description]: fields.metaDescription.slice(0, 155),
        },
      };
    });

    // -- 6. linkCheck — every link resolves; broken anchors are unwrapped. ---
    await this.reportProgress({ step: "linkCheck", status: "running", percent: 0.65, topicId: topic.id });
    const linked = await step.do("link-check", NET_RETRY, async () => {
      const hrefs = [...new Set([...checked.html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1] as string))]
        .filter(isCheckableUrl)
        .slice(0, 25);
      const broken: string[] = [];
      for (const url of hrefs) {
        try {
          const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10_000) });
          if (res.status >= 400) broken.push(url);
        } catch {
          broken.push(url);
        }
      }
      if (hrefs.length > 0 && broken.length > hrefs.length / 2) {
        throw new Error(`linkCheck: ${broken.length}/${hrefs.length} links broken — draft not publishable`);
      }
      let html = checked.html;
      for (const url of broken) {
        // Unwrap the anchor, keep the text — no 404s ship (§4 step 6).
        html = html.replace(
          new RegExp(`<a\\b[^>]*href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>(.*?)</a>`, "gs"),
          "$1"
        );
      }
      return { html, checkedCount: hrefs.length, removed: broken };
    });
    const finalDraft: Draft = { ...checked, html: linked.html };

    // -- 7. approvalGate — human tap required (SDK pause/resume). ------------
    const autoPublish = await step.do("check-auto-publish", async () => autoPublishAllowed(env.DB));
    let decidedBy = "auto-publish";
    if (!autoPublish) {
      await step.do("raise-approval", NET_RETRY, async () => {
        const previewKey = `hermes/drafts/${workflowId}.html`;
        await env.ARTIFACTS.put(
          previewKey,
          `<h1>${finalDraft.title}</h1>\n<p><em>${finalDraft.excerpt}</em></p>\n<p><small>slug: ${seo.slug} · meta title: ${seo.metaTitle} · meta description: ${seo.metaDescription} · links checked: ${linked.checkedCount}, removed: ${linked.removed.length}</small></p>\n<hr/>\n${finalDraft.html}`,
          { httpMetadata: { contentType: "text/html; charset=utf-8" } }
        );
        await env.DB.prepare(
          `INSERT OR IGNORE INTO approvals (id, workflow_id, kind, subject, summary)
           VALUES (?1, ?2, 'hermes_publish', ?3, ?4)`
        )
          .bind(`apr_${workflowId}`, workflowId, topic.id, finalDraft.title)
          .run();
        await env.DB.prepare(
          `UPDATE topics SET status = 'awaiting_approval', updated_at = datetime('now') WHERE id = ?1`
        )
          .bind(topic.id)
          .run();
        await appendAudit(env.DB, {
          actor: "hermes",
          action: "approval_requested",
          subject: topic.id,
          workflowId,
          doctrineEntries: finalDraft.doctrineEntries,
          detail: finalDraft.title,
        });
      });
      await this.reportProgress({
        step: "approvalGate",
        status: "pending",
        percent: 0.75,
        topicId: topic.id,
        waitingForApproval: true,
        message: `awaiting approval: ${finalDraft.title}`,
      });

      const approvalEvent = (await step.waitForEvent("wait-for-approval", {
        type: "approval",
        timeout: "7 days",
      })) as { payload: ApprovalPayload };
      const payload = approvalEvent.payload;

      if (!payload.approved) {
        await step.do("handle-rejection", NET_RETRY, async () => {
          // Rejecting discards cleanly and returns the topic to the queue (§4).
          await env.DB.prepare(
            `UPDATE topics SET status = 'queued', workflow_id = NULL, updated_at = datetime('now') WHERE id = ?1`
          )
            .bind(topic.id)
            .run();
          await appendAudit(env.DB, {
            actor: payload.metadata?.email ?? "unknown",
            action: "publish_rejected_handled",
            subject: topic.id,
            workflowId,
            detail: payload.reason,
          });
        });
        await step.reportComplete({ rejected: true, by: payload.metadata?.email });
        return { rejected: true };
      }
      decidedBy = payload.metadata?.email ?? "unknown";
      await step.do("mark-approved", NET_RETRY, async () => {
        // Leave 'awaiting_approval' the moment a human decides: if anything
        // fails after this point (including after the WP post goes live),
        // onWorkflowError must land the topic on 'failed' for a human to
        // inspect — never back on 'queued' where a rerun would re-publish it.
        await env.DB.prepare(
          `UPDATE topics SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?1`
        )
          .bind(topic.id)
          .run();
      });
    } else {
      await step.do("audit-auto-publish", NET_RETRY, async () => {
        await appendAudit(env.DB, {
          actor: "hermes",
          action: "approval_gate_skipped",
          subject: topic.id,
          workflowId,
          detail: "auto-publish enabled by a human after 60 clean days",
        });
      });
    }

    // -- 8. publish — business hours only; kill switch re-checked. -----------
    const wakeAt = await step.do("check-publish-window", async () =>
      withinPublishWindow(env) ? null : nextPublishWindowStart(env).toISOString()
    );
    if (wakeAt) {
      await this.reportProgress({
        step: "publish",
        status: "pending",
        percent: 0.85,
        topicId: topic.id,
        message: `outside publish window — sleeping until ${wakeAt}`,
      });
      await step.sleepUntil("sleep-until-publish-window", new Date(wakeAt));
    }
    const haltedLate = await step.do("final-kill-check", async () => {
      const ks = await killSwitch(env);
      return ks.engaged ? `kill switch engaged by ${ks.by ?? "unknown"}` : null;
    });
    if (haltedLate) {
      await step.do("return-topic-after-halt", NET_RETRY, async () => {
        await env.DB.prepare(
          `UPDATE topics SET status = 'queued', workflow_id = NULL, updated_at = datetime('now') WHERE id = ?1`
        )
          .bind(topic.id)
          .run();
      });
      await step.reportComplete({ skipped: haltedLate });
      return { skipped: haltedLate };
    }

    await this.reportProgress({ step: "publish", status: "running", percent: 0.9, topicId: topic.id });
    const post = await step.do("publish", NET_RETRY, async (): Promise<{ id: number; link: string }> => {
      // Idempotency across step retries: if the slug already exists AND the
      // title matches, the earlier attempt landed — reuse it. A same-slug
      // post with a different title is somebody else's; WordPress will
      // suffix the new slug on create.
      const existing = await findBySlug(env, seo.slug);
      if (existing && existing.title.trim().toLowerCase() === finalDraft.title.trim().toLowerCase()) {
        return { id: existing.id, link: existing.link };
      }
      const created = await createPost(env, {
        title: finalDraft.title,
        content: finalDraft.html,
        excerpt: finalDraft.excerpt,
        slug: seo.slug,
        status: "publish",
        meta: seo.meta,
      });
      return { id: created.id, link: created.link };
    });

    // -- 9. log — provenance: doctrine entries and sources used (§4). --------
    await step.do("log", NET_RETRY, async () => {
      const logId = `pub_${workflowId}`;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO published_log
           (id, topic_id, workflow_id, wp_post_id, slug, title, url, status, doctrine_entries, sources, approved_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'published', ?8, ?9, ?10)`
      )
        .bind(
          logId,
          topic.id,
          workflowId,
          post.id,
          seo.slug,
          finalDraft.title,
          post.link,
          JSON.stringify(finalDraft.doctrineEntries),
          JSON.stringify([...research.internal.map((r) => r.url), ...research.external.map((r) => r.url)]),
          decidedBy
        )
        .run();
      const vector = await embedText(env, `${finalDraft.title} ${topic.keywords.join(" ")}`);
      await env.VEC_PUBLISHED_LOG.upsert([{ id: logId, values: vector, metadata: { slug: seo.slug } }]);
      await env.DB.prepare(
        `UPDATE topics SET status = 'published', updated_at = datetime('now') WHERE id = ?1`
      )
        .bind(topic.id)
        .run();
      await appendAudit(env.DB, {
        actor: "hermes",
        action: "published",
        subject: topic.id,
        workflowId,
        doctrineEntries: finalDraft.doctrineEntries,
        detail: post.link,
      });
    });

    await step.reportComplete({ published: true, url: post.link, approvedBy: decidedBy });
    return { published: true, url: post.link };
  }
}
