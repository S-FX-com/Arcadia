// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Ingest producer types (Phase 3a)
//
// Each "resource" Arcadia ingests has a Producer adapter. The driver
// (run.ts) walks `delta_state` per (user, resource), invokes the
// adapter to fetch the next page of changes, and enqueues
// IngestMessage payloads onto the arcadia-ingest queue. Adapters are
// pure: they don't write D1 themselves, they just return what changed.
// ─────────────────────────────────────────────────────────────────────────────

import type { AclPrincipal, Env, ResourceType } from "../../types.js";
import type { IngestMessage } from "../queue-consumer.js";

export interface ProducerContext {
	env: Env;
	userAadId: string;
	accessToken: string;
}

/** A single change item the producer wants to enqueue. */
export interface ProducedChange {
	message: IngestMessage;
	/** Optional principals; recorded by the consumer if present and non-empty. */
	principals?: AclPrincipal[];
}

export interface ProducerPage {
	/** Changes to enqueue this page. */
	changes: ProducedChange[];
	/**
	 * Opaque cursor returned by Graph (`@odata.deltaLink` for the final
	 * page, `@odata.nextLink` for intermediate pages). The driver will
	 * call the adapter again with this cursor on the next pass when
	 * `done=false`, or persist it as the new delta_link when `done=true`.
	 */
	cursor: string;
	done: boolean;
}

export interface Producer {
	/** Stable id used as the `resource` column in delta_state. */
	resourceKey: (ctx: ProducerContext) => string;
	/** Maps to ResourceType for the resulting documents. */
	resourceType: ResourceType;
	/**
	 * Fetch the next page. `previousLink` is null on the very first run
	 * for this (user, resource); thereafter it's the previous pass's
	 * cursor.
	 */
	fetchPage: (ctx: ProducerContext, previousLink: string | null) => Promise<ProducerPage>;
}
