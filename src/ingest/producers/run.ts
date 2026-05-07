// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Ingest producer driver (Phase 3a)
//
// runIngestProducers(env) is the per-cron entrypoint. For each user with
// a live webapp session token it:
//   1. Reads the previous delta_state.delta_link for the (user, resource).
//   2. Calls the producer's fetchPage(ctx, previousLink).
//   3. Enqueues the resulting messages onto INGEST_QUEUE.
//   4. Persists the new cursor + last_run_at + status.
//
// Pagination: when a producer returns done=false, the driver leaves the
// stored cursor pointing at the next page so the *next* cron pass picks
// up where this one left off. We never spin a tight loop within a single
// pass — each pass advances at most one page per (user, resource) so a
// pathological tenant can't starve other users.
// ─────────────────────────────────────────────────────────────────────────────

import { createLogger } from "../../lib/logger.js";
import type { Env } from "../../types.js";
import { recordResourceAcl } from "../../graph/acl.js";
import type { Producer } from "./types.js";
import { mailProducer } from "./mail.js";
import { driveProducer } from "./drive.js";
import { calendarProducer } from "./calendar.js";
import { plannerProducer } from "./planner.js";
import { onenoteProducer } from "./onenote.js";
import { sharepointProducer } from "./sharepoint.js";

const log = createLogger({ component: "ingest-producers" });

const PRODUCERS: Producer[] = [
	mailProducer,
	driveProducer,
	calendarProducer,
	plannerProducer,
	onenoteProducer,
	sharepointProducer,
];

interface SessionRow {
	user_id: string;
	access_token: string;
	token_expiry: number;
}

async function activeSessions(env: Env): Promise<SessionRow[]> {
	const now = Math.floor(Date.now() / 1000);
	const result = await env.ARCADIA_DB.prepare(
		`SELECT user_id, access_token, token_expiry
		   FROM webapp_sessions
		  WHERE token_expiry > ?
		  GROUP BY user_id
		  ORDER BY last_active DESC
		  LIMIT 50`,
	)
		.bind(now)
		.all<SessionRow>();
	return result.results;
}

async function readCursor(env: Env, userAadId: string, resource: string): Promise<string | null> {
	const row = await env.ARCADIA_DB.prepare(
		`SELECT delta_link FROM delta_state WHERE user_aad_id = ? AND resource = ?`,
	)
		.bind(userAadId, resource)
		.first<{ delta_link: string }>();
	return row?.delta_link ?? null;
}

async function writeCursor(env: Env, userAadId: string, resource: string, cursor: string, status: "ok" | "error", err?: string): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.ARCADIA_DB.prepare(
		`INSERT INTO delta_state (user_aad_id, resource, delta_link, last_run_at, last_status, last_error)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_aad_id, resource) DO UPDATE SET
		   delta_link = excluded.delta_link,
		   last_run_at = excluded.last_run_at,
		   last_status = excluded.last_status,
		   last_error  = excluded.last_error`,
	)
		.bind(userAadId, resource, cursor, now, status, err ?? null)
		.run();
}

export interface IngestRunStats {
	users: number;
	enqueued: number;
	skipped: number;
	failed: number;
}

export async function runIngestProducers(env: Env): Promise<IngestRunStats> {
	if (!env.INGEST_QUEUE) {
		log.warn("ingest_queue_unbound", { reason: "INGEST_QUEUE binding missing" });
		return { users: 0, enqueued: 0, skipped: 0, failed: 0 };
	}

	const sessions = await activeSessions(env);
	const stats: IngestRunStats = { users: sessions.length, enqueued: 0, skipped: 0, failed: 0 };

	for (const session of sessions) {
		const { decryptToken } = await import("../../webapp/crypto.js");
		let accessToken: string;
		try {
			accessToken = await decryptToken(session.access_token, env.WEBAPP_SESSION_SECRET);
		} catch (err) {
			log.warn("session_decrypt_failed", { userAadId: session.user_id }, err);
			stats.skipped++;
			continue;
		}

		for (const producer of PRODUCERS) {
			const resource = producer.resourceKey({ env, userAadId: session.user_id, accessToken });
			const previousLink = await readCursor(env, session.user_id, resource);
			try {
				const page = await producer.fetchPage({ env, userAadId: session.user_id, accessToken }, previousLink);
				for (const ch of page.changes) {
					await env.INGEST_QUEUE.send(ch.message);
					if (ch.principals && ch.principals.length > 0 && ch.message.kind === "upsert") {
						// Record ACL up front so strict-mode recall finds the
						// row the moment it lands.
						await recordResourceAcl(ch.message.resourceType, ch.message.resourceId, ch.principals, env)
							.catch((err) => log.warn("producer_acl_write_failed", { resourceType: ch.message.resourceType }, err));
					}
					stats.enqueued++;
				}
				await writeCursor(env, session.user_id, resource, page.cursor, "ok");
			} catch (err) {
				log.warn("producer_failed", { userAadId: session.user_id, resource }, err);
				await writeCursor(env, session.user_id, resource, previousLink ?? "", "error", err instanceof Error ? err.message : String(err));
				stats.failed++;
			}
		}
	}

	log.info("ingest_run_complete", { ...stats });
	return stats;
}
