// Doctrine and brand voice as a Cloudflare OS context source (integration
// plan, workstream B). Mirrors the shape of the OS Context Library
// (packages/gatekeeper-context): a bounded agent catalog for discovery, then
// search/read over the entries. Everything here recalls from
// sfx-doctrine-canonical only — staging is a queue, not a memory (§5.2) —
// and is read-only by construction: no method writes anything anywhere.
//
// Each function returns the data together with the ObservationDescription
// that covers it, so callers (src/os-bridge/index.ts) can log locally and
// hand the description to an OS ApprovalQueue for authorization before the
// data reaches a gadget.

import { BRAND_RULES, VOICE_RULES } from "../lib/brand";
import type { Profile } from "../memory/driver";
import {
  boundAgentCatalog,
  type AgentCatalog,
  type AgentCatalogEntry,
  type AgentCatalogRequest,
  type ObservationDescription,
} from "../gatekeepers/types";

/** The one non-memory document: the brand + voice rules, always present. */
export const BRAND_VOICE_DOC_ID = "brand-voice";

export interface DoctrineDoc {
  docId: string;
  title: string;
  content: string;
  kind: "brand" | "doctrine";
}

export interface DoctrineHit {
  docId: string;
  title: string;
  snippet: string;
  score: number;
}

export type DoctrineProfile = Pick<Profile, "recall" | "list">;

/** Bounded listing for discovery; canonical doctrine is small by design. */
const CATALOG_SCAN_LIMIT = 200;

function entryTitle(topicKey: string, content: string): string {
  return topicKey || content.slice(0, 60);
}

export async function doctrineCatalog(
  profile: DoctrineProfile,
  request: AgentCatalogRequest
): Promise<{ catalog: AgentCatalog; observation: ObservationDescription }> {
  const memories = await profile.list({ limit: CATALOG_SCAN_LIMIT });
  const entries: AgentCatalogEntry[] = [
    {
      id: BRAND_VOICE_DOC_ID,
      title: "S-FX brand and voice rules",
      description: "How S-FX describes itself and how Arcadia writes. Read before producing any copy.",
    },
    ...memories.map((m) => ({
      id: m.id,
      title: entryTitle(m.topicKey, m.content),
      description: m.content.slice(0, 200),
    })),
  ];
  const catalog = boundAgentCatalog(entries, request);
  return {
    catalog,
    observation: {
      title: "Listed doctrine catalog",
      description: `${catalog.entries.length} entries from sfx-doctrine-canonical (of ${entries.length} known)`,
    },
  };
}

export async function searchDoctrine(
  profile: DoctrineProfile,
  query: string,
  limit = 6
): Promise<{ hits: DoctrineHit[]; observation: ObservationDescription }> {
  const recalled = await profile.recall(query, { limit });
  const hits = recalled.memories.map((m) => ({
    docId: m.id,
    title: entryTitle(m.topicKey, m.content),
    snippet: m.content.slice(0, 300),
    score: m.score,
  }));
  return {
    hits,
    observation: {
      title: `Searched doctrine for "${query.slice(0, 80)}"`,
      description: `${hits.length} hit(s)${recalled.belowConfidenceFloor ? " — below confidence floor" : ""}`,
    },
  };
}

export async function readDoctrineEntry(
  profile: DoctrineProfile,
  docId: string
): Promise<{ doc: DoctrineDoc | null; observation: ObservationDescription }> {
  if (docId === BRAND_VOICE_DOC_ID) {
    return {
      doc: {
        docId,
        title: "S-FX brand and voice rules",
        content: `${BRAND_RULES}\n\n${VOICE_RULES}`,
        kind: "brand",
      },
      observation: { title: "Read brand and voice rules", description: "Static brand/voice document" },
    };
  }
  const memories = await profile.list({ limit: CATALOG_SCAN_LIMIT });
  const memory = memories.find((m) => m.id === docId);
  return {
    doc: memory
      ? {
          docId: memory.id,
          title: entryTitle(memory.topicKey, memory.content),
          content: memory.content,
          kind: "doctrine",
        }
      : null,
    observation: {
      title: `Read doctrine entry ${docId}`,
      description: memory ? `topic "${memory.topicKey}"` : "no such entry in canonical",
    },
  };
}
