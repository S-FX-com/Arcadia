// /api/webapp/proposals — the operator review queue (EXECUTION-PLAN §Phase 4).
//
//   GET    /api/webapp/proposals[?status=pending]
//     Lists improvement proposals (src/learning/proposals.ts), newest first.
//     Optional ?status= filters to one of pending|approved|rejected|applied.
//
//   POST   /api/webapp/proposals/:id/approve
//     Applies the proposal by kind, then marks it 'applied':
//       - charter_amendment → CharterStore.publish() a new charter version
//         (current body + the suggested clause, or the payload's full body).
//       - memory_correction → MemoryStore.forget() the target memory.
//       - procedure        → set memories.promoted = 1 for the target.
//       - routine          → enable the target routine if the payload names
//         one; otherwise nothing to apply — 'applied' records ratification.
//
//   POST   /api/webapp/proposals/:id/reject
//     Marks the proposal 'rejected'. No change is applied.
//
// Every route requires session.isAdmin === true (set by routes.ts after
// consulting users.is_admin / ADMIN_USER_AAD_ID). Nothing here edits
// Arcadia's behaviour without an operator's explicit approval — Arcadia
// proposes, Shane ratifies (SOUL.md + D5).

import type { Env } from "../env";
import { CharterStore } from "../charter/store";
import { MemoryStore } from "../memory/store";
import {
  ProposalStore,
  type Proposal,
  type ProposalStatus,
} from "../learning/proposals";
import type { Session } from "./auth";

const STATUSES: ProposalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "applied",
];

export async function handleProposals(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  if (!session.isAdmin) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/webapp/proposals              -> [api, webapp, proposals]
  // /api/webapp/proposals/:id/approve  -> [..., id, action]
  const id = segments[3];
  const action = segments[4];

  const store = new ProposalStore(env);

  if (!id) {
    if (request.method === "GET") {
      const statusParam = url.searchParams.get("status");
      const status =
        statusParam && (STATUSES as string[]).includes(statusParam)
          ? (statusParam as ProposalStatus)
          : undefined;
      const proposals = await store.list(status);
      return Response.json({ proposals });
    }
    return methodNotAllowed();
  }

  if (request.method !== "POST") return methodNotAllowed();

  if (action === "approve") return approve(env, store, id, session);
  if (action === "reject") return reject(store, id, session);

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function approve(
  env: Env,
  store: ProposalStore,
  id: string,
  session: Session,
): Promise<Response> {
  const proposal = await store.byId(id);
  if (!proposal) return Response.json({ error: "not_found" }, { status: 404 });
  if (proposal.status !== "pending") {
    return Response.json({ error: "not_pending" }, { status: 409 });
  }

  try {
    await applyProposal(env, proposal);
  } catch (e) {
    return Response.json(
      { error: `apply_failed: ${String(e)}` },
      { status: 400 },
    );
  }

  await store.resolve(id, "applied", session.aadId);
  return Response.json({ ok: true, status: "applied" });
}

async function reject(
  store: ProposalStore,
  id: string,
  session: Session,
): Promise<Response> {
  const proposal = await store.byId(id);
  if (!proposal) return Response.json({ error: "not_found" }, { status: 404 });
  if (proposal.status !== "pending") {
    return Response.json({ error: "not_pending" }, { status: 409 });
  }
  await store.resolve(id, "rejected", session.aadId);
  return Response.json({ ok: true, status: "rejected" });
}

/** Apply an approved proposal by kind. Throws on a malformed payload. */
async function applyProposal(env: Env, proposal: Proposal): Promise<void> {
  switch (proposal.kind) {
    case "charter_amendment": {
      const payload = asRecord(proposal.payload);
      const charter = new CharterStore(env);
      const fullBody = str(payload?.body);
      let body: string;
      if (fullBody) {
        body = fullBody;
      } else {
        const clause = str(payload?.suggestedClause);
        if (!clause) throw new Error("no_clause");
        const current = await charter.active();
        body = current?.body
          ? `${current.body.trim()}\n\n${clause}`
          : clause;
      }
      await charter.publish(body);
      return;
    }

    case "memory_correction": {
      const payload = asRecord(proposal.payload);
      const memId = str(payload?.targetMemoryId) ?? str(payload?.memoryId);
      if (!memId) throw new Error("no_target_memory");
      await new MemoryStore(env).forget(memId);
      return;
    }

    case "procedure": {
      const payload = asRecord(proposal.payload);
      const memId = str(payload?.targetMemoryId) ?? str(payload?.memoryId);
      if (!memId) throw new Error("no_target_memory");
      await env.ARCADIA_DB.prepare(
        `UPDATE memories SET promoted = 1, updated_at = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), memId)
        .run();
      return;
    }

    case "routine": {
      const payload = asRecord(proposal.payload);
      const routineId = str(payload?.routineId);
      if (routineId) {
        await env.ARCADIA_DB.prepare(
          `UPDATE routines SET enabled = 1, updated_at = ? WHERE id = ?`,
        )
          .bind(new Date().toISOString(), routineId)
          .run();
      }
      // No routine id/def to activate — marking 'applied' records the
      // operator's ratification; the payload is the audit trail.
      return;
    }
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
