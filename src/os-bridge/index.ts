// Arcadia as a Cloudflare OS gatekeeper backend (integration plan, workstreams
// B and C).
//
// Cloudflare OS gatekeepers are Workers the OS workshop binds as services and
// drives over Workers RPC (cloudflare-os AGENTS.md, packages/gatekeeper-*).
// This entrypoint makes Arcadia bindable exactly that way: when S-FX deploys
// an OS instance (github.com/cloudflare/cloudflare-os-starter), a thin
// `gatekeeper-arcadia` package in that deployment binds this class
// (service = "arcadia", entrypoint = "ArcadiaOsGatekeeper") and adapts it to
// the kernel's Gatekeeper interface. The adapter obligation is small and
// explicit:
//
//   - every session method returns { data, observation } — the adapter MUST
//     `await approvalQueue.authorizeObservation(observation)` before handing
//     `data` to a gadget or agent, which preserves the OS invariant that
//     reads are authorized before data flows;
//   - there are no side-effecting methods, so applyAction/rejectAction never
//     fire (exactly like the OS Context Library, which is also read-only);
//   - `context.actor` is the OS-side user's email. Service bindings only
//     exist inside the S-FX Cloudflare account, so the caller is trusted to
//     assert it, same as the workshop is trusted with its users' identities.
//
// Until that deployment exists, nothing binds this entrypoint and it is dead
// code with zero routes — it is NOT reachable over HTTP.
//
// Everything the session serves is also logged locally (gk_observations,
// gatekeeper 'os-bridge') so the dashboard shows what left Arcadia for OS
// workspaces, on whose behalf, regardless of what the OS side does.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { AskResult } from "../agents/arcadia";
import { D1GatekeeperQueue } from "../gatekeepers/log";
import {
  GatekeeperDeniedError,
  type AgentCatalog,
  type AgentCatalogRequest,
  type GatekeeperContext,
  type ObservationDescription,
  type SupportedResource,
  type VendorDescription,
} from "../gatekeepers/types";
import { requireCapability, resolveUser, type UserRecord } from "../lib/rbac";
import { DOCTRINE_CANONICAL } from "../memory/driver";
import { SelfHostedMemoryDriver } from "../memory/self-hosted";
import { askArcadia } from "./ask-arcadia";
import {
  doctrineCatalog,
  readDoctrineEntry,
  searchDoctrine,
  type DoctrineDoc,
  type DoctrineHit,
  type DoctrineProfile,
} from "./doctrine-skill";

/** Every read leaves as data + the observation that must authorize it. */
export interface Observed<T> {
  data: T;
  observation: ObservationDescription;
}

/** What the OS coding agent sees for this binding (getTypeScriptTypes). */
const ARCADIA_OS_TYPES = `
/**
 * Arcadia — the S-FX operations intelligence layer. Read-only.
 * Doctrine answers are Cited or Inferred. Inferred is labeled and may queue
 * a gap for Shane; she does not refuse a workable request.
 */
interface ArcadiaOps {
  /** Discover what is readable: brand/voice rules plus canonical doctrine entries. */
  getAgentCatalog(request: { limit: number }): Promise<Observed<AgentCatalog>>;
  /** Semantic search over ratified doctrine. */
  search(query: string, limit?: number): Promise<Observed<DoctrineHit[]>>;
  /** Read one catalog entry ("brand-voice" or a doctrine entry id). */
  read(docId: string): Promise<Observed<DoctrineDoc | null>>;
  /** Ask Arcadia a question. Escalates to the gap queue when doctrine cannot answer. */
  ask(question: string): Promise<Observed<AskArcadiaResult>>;
}

/** data + the observation your gatekeeper must authorize before using data. */
interface Observed<T> { data: T; observation: { title: string; description: string } }

interface AgentCatalog { entries: { id: string; title: string; description: string }[]; truncated?: boolean }
interface DoctrineHit { docId: string; title: string; snippet: string; score: number }
interface DoctrineDoc { docId: string; title: string; content: string; kind: "brand" | "doctrine" }
interface AskArcadiaResult { escalated: boolean; mode: "cited" | "inferred"; answer: string; citations: string[]; gapId?: string }
`;

export class ArcadiaOsSession extends RpcTarget {
  constructor(
    private readonly env: Env,
    private readonly queue: D1GatekeeperQueue,
    private readonly user: UserRecord,
    private readonly profile: DoctrineProfile
  ) {
    super();
  }

  /** Log locally, then hand the observation to the OS side inside the envelope. */
  private async observed<T>(data: T, observation: ObservationDescription): Promise<Observed<T>> {
    await this.queue.authorizeObservation(observation);
    return { data, observation };
  }

  async getAgentCatalog(request: AgentCatalogRequest): Promise<Observed<AgentCatalog>> {
    const { catalog, observation } = await doctrineCatalog(this.profile, request);
    return this.observed(catalog, observation);
  }

  async search(query: string, limit = 6): Promise<Observed<DoctrineHit[]>> {
    const { hits, observation } = await searchDoctrine(this.profile, query, limit);
    return this.observed(hits, observation);
  }

  async read(docId: string): Promise<Observed<DoctrineDoc | null>> {
    const { doc, observation } = await readDoctrineEntry(this.profile, docId);
    return this.observed(doc, observation);
  }

  async ask(question: string): Promise<Observed<AskResult>> {
    // Same capability the dashboard enforces for the same surface.
    requireCapability(this.user, "ask_arcadia");
    const { result, observation } = await askArcadia(this.env, question, this.user.email);
    return this.observed(result, observation);
  }
}

export class ArcadiaOsGatekeeper extends WorkerEntrypoint<Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Arcadia",
      url: "https://www.s-fx.com/",
      tagline: "S-FX doctrine, brand voice, and Ask Arcadia",
      description:
        "Read-only access to S-FX ratified doctrine and brand rules, plus Ask Arcadia — " +
        "Cited when doctrine covers it, Inferred (labeled) when it does not, with gaps batched for Shane.",
      providesAuth: false,
      // Accounts map to staff the OS deployment has already authenticated
      // against the same Entra directory; no per-user OAuth flow to run here.
      autoProvisionsAccount: true,
    };
  }

  /** Agent-singleton style, like the OS Context Library: no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return ARCADIA_OS_TYPES;
  }

  /**
   * Mint a session for one OS-side human. Deactivated staff get nothing —
   * the capability never exists, rather than existing and failing.
   */
  async startSession(context: GatekeeperContext): Promise<ArcadiaOsSession> {
    if (!context.actor || !context.actor.includes("@")) {
      throw new GatekeeperDeniedError(
        "context.actor must be the acting user's email",
        "os-bridge"
      );
    }
    const user = await resolveUser(this.env, { email: context.actor });
    if (!user.active) {
      throw new GatekeeperDeniedError(`${context.actor} is deactivated`, "os-bridge");
    }
    const profile = await new SelfHostedMemoryDriver(this.env).getProfile(DOCTRINE_CANONICAL);
    const queue = new D1GatekeeperQueue(
      this.env.DB,
      "os-bridge",
      `memory:${DOCTRINE_CANONICAL}`,
      context
    );
    return new ArcadiaOsSession(this.env, queue, user, profile);
  }
}
