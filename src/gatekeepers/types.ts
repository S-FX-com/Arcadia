// Cloudflare OS gatekeeper contract, mirrored for Arcadia.
//
// Cloudflare OS (github.com/cloudflare/cloudflare-os) defines this contract in
// packages/workshop-shared/src/gatekeeper.ts. That package is workspace-only —
// it is not published to npm — so the shapes Arcadia implements are mirrored
// here with the same names and fields, and must be kept in sync by hand when
// the OS contract moves (clone the OS repo into /reference to diff).
//
// Arcadia adopts the model in-process today: every external read is an
// observation authorized before data returns to the caller, every side effect
// is an action that carries recorded human authorization before it applies,
// and both land append-only in D1 (src/gatekeepers/log.ts). The same shapes
// are exposed over Workers RPC (src/os-bridge/) so a deployed Cloudflare OS
// instance can front Arcadia with a thin gatekeeper package later.
//
// Deliberately not mirrored: hooks (ApprovalQueue.bindHook), observers
// (Gatekeeper.addObserver), and the OAuth connect flow — those belong to the
// OS kernel's gadget-sharing machinery. The os-bridge documents where they
// would attach when S-FX deploys an OS instance.

// ---------------------------------------------------------------------------
// Observations — read-only operations. Logged for review; the log is what
// lets a future OS deployment re-check a recipient's access when something
// built on this data is shared ("policy follows the data").
// ---------------------------------------------------------------------------

export interface ObservationDescription {
  /** Brief one-line summary of the observation, like an email subject line. */
  title: string;
  /** Complete Markdown description with every detail relevant to review. */
  description: string;
  /** Sensitive: must never be shared beyond the account owner. */
  prohibitAllSharing?: boolean;
  /** Observer ids (Gatekeeper.addObserver) who must not see this observation. */
  excludeObservers?: string[];
}

export interface ObservationAuthorizer {
  /**
   * Called on every read, and awaited BEFORE any data returns to the caller.
   * Throwing blocks the observation; the exception propagates to the caller.
   */
  authorizeObservation(description: ObservationDescription): Promise<void>;
}

// ---------------------------------------------------------------------------
// Actions — side effects. Submitted first, applied only once authorized.
// ---------------------------------------------------------------------------

/** Stable machine tag + display label; policy keys on tag. */
export interface ActionKind {
  tag: string;
  label: string;
}

export interface ActionDescription {
  title: string;
  description: string;
  /** Does the gatekeeper implement revert for this action? */
  implementsRevert: boolean;
  /** Agent should not keep working until this action is decided. */
  awaitDecision?: boolean;
  /**
   * Author's verdict that this action is safe to auto-apply without a human
   * tap. Absent → never auto-applied. In Arcadia this maps to actions that
   * are not client-visible (a WordPress draft, a memory fact) — anything
   * live still requires recorded human authorization.
   */
  autoApprovable?: boolean;
  actionKind?: ActionKind;
}

export interface ApprovalQueue extends ObservationAuthorizer {
  /**
   * Submit an action for approval. Returns quickly; the action must not be
   * carried out until it is decided. Arcadia keys actions by a stable string
   * (retry-safe inside durable workflow steps) where the OS kernel uses
   * sequential integers — the os-bridge converts at the boundary.
   */
  submitAction(actionKey: string, description: ActionDescription): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vendor / resource descriptions — what the OS Connectors surface displays.
// ---------------------------------------------------------------------------

export interface AvatarImage {
  url: string;
}

export interface VendorDescription {
  displayName: string;
  url: string;
  logo?: AvatarImage;
  color?: string;
  tagline?: string;
  description?: string;
  providesAuth?: boolean;
  /** Vendor can mint an account with no OAuth flow (see os-bridge). */
  autoProvisionsAccount?: boolean;
}

export interface SupportedResource {
  /** URLPattern string, e.g. "https://www.s-fx.com/*" */
  urlPattern: string;
  title: string;
  description: string;
  icon?: AvatarImage;
  grantable?: boolean;
}

export interface ResourceDescription {
  url: string;
  title: string;
  snippet: string;
  /** Default binding name the OS agent sees, e.g. "SFX_TUTORIALS". */
  suggestedBindingName: string;
  /** Type name within getTypeScriptTypes() output. */
  tsType: string;
}

// ---------------------------------------------------------------------------
// Agent catalog — bounded discovery metadata, injected into agent context as
// untrusted data. Caps and bounding behavior mirrored from the OS verbatim.
// ---------------------------------------------------------------------------

export interface AgentCatalogEntry {
  id: string;
  title: string;
  description: string;
}

export interface AgentCatalog {
  entries: AgentCatalogEntry[];
  truncated?: boolean;
}

export interface AgentCatalogRequest {
  limit: number;
}

export const AGENT_CATALOG_MAX_ENTRIES = 25;
export const AGENT_CATALOG_MAX_ID_LENGTH = 256;
export const AGENT_CATALOG_MAX_TITLE_LENGTH = 100;
export const AGENT_CATALOG_MAX_DESCRIPTION_LENGTH = 400;

/** Clamp a catalog to the request's limit and the hard caps. */
export function boundAgentCatalog(
  entries: AgentCatalogEntry[],
  request: AgentCatalogRequest
): AgentCatalog {
  const requestedLimit = Number.isFinite(request.limit)
    ? Math.max(0, Math.floor(request.limit))
    : 0;
  const limit = Math.min(requestedLimit, AGENT_CATALOG_MAX_ENTRIES);
  return {
    entries: entries.slice(0, limit).map((entry) => ({
      id: entry.id.slice(0, AGENT_CATALOG_MAX_ID_LENGTH),
      title: entry.title.slice(0, AGENT_CATALOG_MAX_TITLE_LENGTH),
      description: entry.description.slice(0, AGENT_CATALOG_MAX_DESCRIPTION_LENGTH),
    })),
    truncated: entries.length > limit,
  };
}

// ---------------------------------------------------------------------------
// Arcadia-local plumbing (not part of the OS contract).
// ---------------------------------------------------------------------------

/** Who a capability session acts for, and under which durable run. */
export interface GatekeeperContext {
  /** Workflow id, sweep id, or OS session id — joins the log to the run. */
  sessionId: string;
  /** 'hermes' | 'radar' | 'arcadia' | a human email | an OS workspace id. */
  actor: string;
}

/**
 * Evidence that a side-effecting action is authorized. The governing rule —
 * Arcadia surfaces and attributes, humans decide and sign — means a live
 * action must carry a named human decision or a control a human enabled.
 */
export type ActionAuthorization =
  /** A human tapped the approval gate; approvalId joins the approvals row. */
  | { kind: "human_approval"; approvalId: string; decidedBy: string }
  /** Hermes auto-publish after 60 clean days, enabled by a human (§4). */
  | { kind: "auto_publish" }
  /** A stage-advance dispatch rule (Phase 3), attributed to the reviewer. */
  | { kind: "dispatch_rule"; rule: string; onBehalfOf: string };

/**
 * The full queue surface Arcadia's sessions drive: the OS ApprovalQueue plus
 * the decision/apply records the OS kernel would keep on its side. D1-backed
 * in production (src/gatekeepers/log.ts); tests inject a recording fake.
 */
export interface ArcadiaActionQueue extends ApprovalQueue {
  /** Authorize a submitted action; throws unless evidence (or autoApprovable) covers it. */
  recordDecision(actionKey: string, authorization?: ActionAuthorization): Promise<void>;
  recordApplied(actionKey: string, result: string): Promise<void>;
  recordFailed(actionKey: string, error: string): Promise<void>;
}

/** Thrown when a session refuses an out-of-scope or unauthorized call. */
export class GatekeeperDeniedError extends Error {
  constructor(
    message: string,
    public readonly gatekeeper: string
  ) {
    super(message);
    this.name = "GatekeeperDeniedError";
  }
}
