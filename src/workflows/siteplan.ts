// Site planning workflow (§4 Phase 4). Crawl → diagnose → nav map → page
// specs, each step independently durable because a 40-page crawl plus a spec
// per page is far too much for one request.
//
// Melina and Diego approve before anything reaches a client — the plan lands
// in R2 as a reviewable artifact and pauses on an approval gate, exactly like
// Hermes. Arcadia never sends anything to a client (§8).

import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { ModelRouter } from "../ai/router";
import type { Arcadia } from "../agents/arcadia";
import { appendAudit } from "../lib/audit";
import {
  crawlSite,
  diagnose,
  proposeNav,
  specPage,
  type CrawlResult,
  type Diagnosis,
  type NavNode,
  type PageSpec,
} from "../site/plan";
import type { PublishProgress } from "../schema/types";

const NET_RETRY: WorkflowStepConfig = {
  retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};
const LLM_RETRY: WorkflowStepConfig = {
  retries: { limit: 2, delay: "20 seconds", backoff: "exponential" },
  timeout: "15 minutes",
};

export interface SitePlanParams {
  rootUrl: string;
  requestedBy: string;
  client?: string;
  /** How many pages to write full section specs for. */
  specLimit?: number;
}

interface ApprovalPayload {
  approved: boolean;
  reason?: string;
  metadata?: { email?: string };
}

export class SitePlanWorkflow extends AgentWorkflow<Arcadia, SitePlanParams, PublishProgress, Env> {
  async run(event: AgentWorkflowEvent<SitePlanParams>, step: AgentWorkflowStep) {
    const env = this.env;
    const workflowId = this.workflowId;
    const { rootUrl, requestedBy, client } = event.payload;
    const specLimit = Math.min(event.payload.specLimit ?? 8, 20);
    const ai = new ModelRouter(env);

    await this.reportProgress({ step: "crawl", status: "running", percent: 0.1 });
    const crawl = await step.do("crawl", NET_RETRY, async (): Promise<CrawlResult> => crawlSite(rootUrl));
    if (crawl.pages.length === 0) {
      await step.reportError(`crawl found no pages at ${rootUrl}`);
      throw new Error(`crawl found no pages at ${rootUrl}`);
    }

    await this.reportProgress({ step: "diagnose", status: "running", percent: 0.3 });
    const diagnoses = await step.do("diagnose", LLM_RETRY, async (): Promise<Diagnosis[]> =>
      diagnose(ai, crawl)
    );

    await this.reportProgress({ step: "nav", status: "running", percent: 0.45 });
    const nav = await step.do("propose-nav", LLM_RETRY, async (): Promise<NavNode[]> =>
      proposeNav(ai, crawl, diagnoses)
    );

    // One step per page: a failed spec retries alone instead of redoing the
    // whole plan.
    const targets = crawl.pages.filter((p) => p.status < 400).slice(0, specLimit);
    const pageSpecs: PageSpec[] = [];
    for (const [i, page] of targets.entries()) {
      await this.reportProgress({
        step: "page-specs",
        status: "running",
        percent: 0.5 + (0.35 * i) / Math.max(1, targets.length),
        message: `spec ${i + 1}/${targets.length}: ${page.url}`,
      });
      const spec = await step.do(`spec-${i}`, LLM_RETRY, async (): Promise<PageSpec | null> =>
        (await specPage(ai, page, nav)) ?? null
      );
      if (spec) pageSpecs.push(spec);
    }

    const artifactKey = await step.do("store-plan", NET_RETRY, async (): Promise<string> => {
      const key = `site-plans/${workflowId}.html`;
      await env.ARTIFACTS.put(key, renderPlan({ rootUrl, client, crawl, diagnoses, nav, pageSpecs }), {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
      await env.DB.prepare(
        `INSERT INTO site_plans (id, root_url, client, requested_by, artifact_key, pages_crawled, findings, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'awaiting_approval')`
      )
        .bind(
          workflowId,
          rootUrl,
          client ?? null,
          requestedBy,
          key,
          crawl.pages.length,
          diagnoses.length
        )
        .run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO approvals (id, workflow_id, kind, subject, summary)
         VALUES (?1, ?2, 'site_plan', ?3, ?4)`
      )
        .bind(
          `apr_${workflowId}`,
          workflowId,
          rootUrl,
          `Site plan for ${client ?? rootUrl}: ${diagnoses.length} findings, ${pageSpecs.length} page specs`
        )
        .run();
      await appendAudit(env.DB, {
        actor: "arcadia",
        action: "site_plan_ready",
        subject: rootUrl,
        workflowId,
        detail: `${crawl.pages.length} pages crawled, ${diagnoses.length} findings, ${pageSpecs.length} specs`,
      });
      return key;
    });

    // Melina and Diego approve before anything reaches a client.
    await this.reportProgress({
      step: "approval",
      status: "pending",
      percent: 0.9,
      waitingForApproval: true,
      message: `site plan for ${client ?? rootUrl} awaiting review`,
    });
    const approvalEvent = (await step.waitForEvent("wait-for-approval", {
      type: "approval",
      timeout: "14 days",
    })) as { payload: ApprovalPayload };
    const payload = approvalEvent.payload;
    const decidedBy = payload.metadata?.email ?? "unknown";

    await step.do("record-decision", NET_RETRY, async () => {
      await env.DB.prepare(
        `UPDATE site_plans SET status = ?2, approved_by = ?3, decided_at = datetime('now') WHERE id = ?1`
      )
        .bind(workflowId, payload.approved ? "approved" : "rejected", decidedBy)
        .run();
      await appendAudit(env.DB, {
        actor: decidedBy,
        action: payload.approved ? "site_plan_approved" : "site_plan_rejected",
        subject: rootUrl,
        workflowId,
        detail: payload.reason,
      });
    });

    await step.reportComplete({ approved: payload.approved, artifactKey, by: decidedBy });
    return { approved: payload.approved, artifactKey };
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderNav(nodes: NavNode[], depth = 0): string {
  return `<ul>${nodes
    .map(
      (n) =>
        `<li><strong>${esc(n.label)}</strong>${n.url ? ` <code>${esc(n.url)}</code>` : ""}<br><em>${esc(n.why)}</em>${
          n.children?.length ? renderNav(n.children, depth + 1) : ""
        }</li>`
    )
    .join("")}</ul>`;
}

/** The deliverable. Reasoning sits beside every recommendation, by design. */
function renderPlan(input: {
  rootUrl: string;
  client?: string | undefined;
  crawl: CrawlResult;
  diagnoses: Diagnosis[];
  nav: NavNode[];
  pageSpecs: PageSpec[];
}): string {
  const { rootUrl, client, crawl, diagnoses, nav, pageSpecs } = input;
  return `<h1>Site plan — ${esc(client ?? rootUrl)}</h1>
<p><small>${esc(rootUrl)} · ${crawl.pages.length} pages crawled · ${crawl.orphans.length} orphans · ${
    crawl.skipped.length
  } unreachable</small></p>
<p><em>Every recommendation below carries its reasoning. If a reason does not convince you, the recommendation is wrong — say so.</em></p>

<h2>What's wrong now (${diagnoses.length})</h2>
${diagnoses
  .map(
    (d) =>
      `<h3>${esc(d.finding)} <small>[${d.severity}]</small></h3><p><strong>Why this matters:</strong> ${esc(
        d.why
      )}</p>${d.pages.length ? `<ul>${d.pages.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : ""}`
  )
  .join("")}

<h2>Proposed navigation</h2>
${nav.length ? renderNav(nav) : "<p>No navigation proposed.</p>"}

<h2>Page specifications (${pageSpecs.length})</h2>
${pageSpecs
  .map(
    (spec) =>
      `<h3>${esc(spec.url)}</h3><p><strong>Intent:</strong> ${esc(spec.intent)}<br><strong>Why this page exists:</strong> ${esc(
        spec.why
      )}</p><table border="1" cellpadding="6" cellspacing="0"><tr><th>Section</th><th>Purpose</th><th>Components</th><th>Copy direction</th><th>Why</th></tr>${spec.sections
        .map(
          (s) =>
            `<tr><td>${esc(s.section)}</td><td>${esc(s.purpose)}</td><td>${esc(
              (s.components ?? []).join(", ")
            )}</td><td>${esc(s.copyDirection)}</td><td><em>${esc(s.why)}</em></td></tr>`
        )
        .join("")}</table>`
  )
  .join("")}`;
}
