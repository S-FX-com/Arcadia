// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Phase 6: Temporal Knowledge Graph
//
// Adapted from MemPalace's knowledge_graph.py.
// Stores entity-relationship triples with temporal validity windows.
//
//   addFact              — Insert or update a fact (subject→predicate→object)
//   invalidateFact       — End a fact's validity (set valid_to = now)
//   queryEntity          — Get all active facts about an entity
//   queryRelationship    — Get facts by subject + predicate
//   traverseGraph        — BFS traversal from an entity through relationships
//   getEntityTimeline    — Full history (active + invalidated) of an entity
//   extractAndStoreEntities — AI-powered entity extraction from text
//
// All facts live in D1's knowledge_graph table.
// Gated behind env.KNOWLEDGE_GRAPH_ENABLED === "true".
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, EntityType, KGFact, KGFactRow, EntityFacts, GraphTraversal } from "../types.js";

// ─── Row → domain mapping ───────────────────────────────────────────────────

function rowToFact(row: KGFactRow): KGFact {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    subjectType: row.subject_type as EntityType,
    predicate: row.predicate,
    objectId: row.object_id,
    objectName: row.object_name,
    objectType: row.object_type as EntityType,
    confidence: row.confidence,
    source: row.source,
    validFrom: row.valid_from ? new Date(row.valid_from * 1000).toISOString() : null,
    validTo: row.valid_to ? new Date(row.valid_to * 1000).toISOString() : null,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
}

/** Normalize an entity ID: lowercase, spaces → hyphens, strip non-alphanumeric. */
export function normalizeEntityId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "");
}

// ─── Constrained predicate vocabulary ───────────────────────────────────────
// Adapted from MemPalace's relationship types.

export const VALID_PREDICATES = [
  "works-on",
  "manages",
  "is-member-of",
  "is-customer-of",
  "is-contact-for",
  "is-blocked-by",
  "decided",
  "owns",
  "reports-to",
  "depends-on",
  "related-to",
] as const;

export type ValidPredicate = (typeof VALID_PREDICATES)[number];

// ─── CRUD operations ────────────────────────────────────────────────────────

export interface AddFactOptions {
  confidence?: number;
  source?: string;
  validFrom?: number;  // Unix timestamp
  validTo?: number;    // Unix timestamp
}

/**
 * Insert a new fact or update an existing active fact with the same triple.
 *
 * If an active fact with the same (subject_id, predicate, object_id) exists
 * and has no valid_to, its confidence is updated (max of old and new).
 * Otherwise a new fact is inserted.
 *
 * Returns the fact ID (new or existing).
 */
export async function addFact(
  subjectName: string,
  subjectType: EntityType,
  predicate: string,
  objectName: string,
  objectType: EntityType,
  env: Env,
  options: AddFactOptions = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const subjectId = normalizeEntityId(subjectName);
  const objectId = normalizeEntityId(objectName);
  const confidence = options.confidence ?? 0.5;
  const source = options.source ?? null;

  // Check for existing active fact with same triple
  const existing = await env.ARCADIA_DB.prepare(
    `SELECT id, confidence FROM knowledge_graph
     WHERE subject_id = ? AND predicate = ? AND object_id = ?
       AND valid_to IS NULL
     LIMIT 1`
  )
    .bind(subjectId, predicate, objectId)
    .first<{ id: string; confidence: number }>();

  if (existing) {
    // Update confidence if new value is higher
    const newConfidence = Math.max(existing.confidence, confidence);
    await env.ARCADIA_DB.prepare(
      `UPDATE knowledge_graph SET confidence = ?, updated_at = ? WHERE id = ?`
    )
      .bind(newConfidence, now, existing.id)
      .run();
    return existing.id;
  }

  // Insert new fact
  const id = crypto.randomUUID();
  await env.ARCADIA_DB.prepare(
    `INSERT INTO knowledge_graph
       (id, subject_id, subject_name, subject_type, predicate,
        object_id, object_name, object_type, confidence, source,
        valid_from, valid_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      subjectId,
      subjectName,
      subjectType,
      predicate,
      objectId,
      objectName,
      objectType,
      confidence,
      source,
      options.validFrom ?? now,
      options.validTo ?? null,
      now,
      now
    )
    .run();

  return id;
}

/**
 * Invalidate a fact by setting its valid_to to now.
 * Does not delete — preserves history for timeline queries.
 */
export async function invalidateFact(
  factId: string,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE knowledge_graph SET valid_to = ?, updated_at = ? WHERE id = ? AND valid_to IS NULL`
  )
    .bind(now, now, factId)
    .run();
}

/**
 * Invalidate all active facts from a specific source.
 * Useful when pruning memories — their derived KG facts should also expire.
 */
export async function invalidateFactsBySource(
  source: string,
  env: Env
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.ARCADIA_DB.prepare(
    `UPDATE knowledge_graph SET valid_to = ?, updated_at = ?
     WHERE source = ? AND valid_to IS NULL`
  )
    .bind(now, now, source)
    .run();
  return result.meta?.changes ?? 0;
}

// ─── Query operations ───────────────────────────────────────────────────────

/**
 * Get all active facts about an entity (as subject or object) at a given time.
 * Default: current time (only active facts).
 */
export async function queryEntity(
  entityId: string,
  env: Env,
  asOf?: number
): Promise<EntityFacts> {
  const normalizedId = normalizeEntityId(entityId);
  const ts = asOf ?? Math.floor(Date.now() / 1000);

  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM knowledge_graph
     WHERE (subject_id = ? OR object_id = ?)
       AND (valid_from IS NULL OR valid_from <= ?)
       AND (valid_to IS NULL OR valid_to > ?)
     ORDER BY confidence DESC, created_at DESC
     LIMIT 50`
  )
    .bind(normalizedId, normalizedId, ts, ts)
    .all<KGFactRow>();

  const facts = result.results.map(rowToFact);

  // Determine entity name and type from first match
  let entityName = entityId;
  let entityType: EntityType = "concept";

  if (facts.length > 0) {
    const first = facts[0]!;
    if (first.subjectId === normalizedId) {
      entityName = first.subjectName;
      entityType = first.subjectType;
    } else {
      entityName = first.objectName;
      entityType = first.objectType;
    }
  }

  return { entityId: normalizedId, entityName, entityType, facts };
}

/**
 * Get all active facts matching a subject + predicate.
 */
export async function queryRelationship(
  subjectId: string,
  predicate: string,
  env: Env
): Promise<KGFact[]> {
  const normalizedId = normalizeEntityId(subjectId);
  const now = Math.floor(Date.now() / 1000);

  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM knowledge_graph
     WHERE subject_id = ? AND predicate = ?
       AND (valid_to IS NULL OR valid_to > ?)
     ORDER BY confidence DESC
     LIMIT 20`
  )
    .bind(normalizedId, predicate, now)
    .all<KGFactRow>();

  return result.results.map(rowToFact);
}

/**
 * BFS traversal from an entity through relationships.
 * Returns connected entities within `depth` hops.
 */
export async function traverseGraph(
  entityId: string,
  depth: number,
  env: Env
): Promise<GraphTraversal> {
  const rootId = normalizeEntityId(entityId);
  const now = Math.floor(Date.now() / 1000);
  const maxDepth = Math.min(depth, 3); // Cap at 3 to prevent runaway queries

  const visited = new Set<string>();
  const nodes: GraphTraversal["nodes"] = [];
  const edges: GraphTraversal["edges"] = [];
  let frontier = [rootId];

  for (let d = 0; d <= maxDepth && frontier.length > 0; d++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      // Get facts where this entity is subject or object
      const result = await env.ARCADIA_DB.prepare(
        `SELECT * FROM knowledge_graph
         WHERE (subject_id = ? OR object_id = ?)
           AND (valid_to IS NULL OR valid_to > ?)
         ORDER BY confidence DESC
         LIMIT 20`
      )
        .bind(currentId, currentId, now)
        .all<KGFactRow>();

      for (const row of result.results) {
        // Add current node if not already added
        if (row.subject_id === currentId) {
          if (!nodes.some((n) => n.id === currentId)) {
            nodes.push({
              id: currentId,
              name: row.subject_name,
              type: row.subject_type as EntityType,
              distance: d,
            });
          }
          // Add neighbor
          if (!visited.has(row.object_id)) {
            nextFrontier.push(row.object_id);
            if (!nodes.some((n) => n.id === row.object_id)) {
              nodes.push({
                id: row.object_id,
                name: row.object_name,
                type: row.object_type as EntityType,
                distance: d + 1,
              });
            }
          }
          edges.push({
            from: row.subject_id,
            to: row.object_id,
            predicate: row.predicate,
          });
        } else {
          if (!nodes.some((n) => n.id === currentId)) {
            nodes.push({
              id: currentId,
              name: row.object_name,
              type: row.object_type as EntityType,
              distance: d,
            });
          }
          if (!visited.has(row.subject_id)) {
            nextFrontier.push(row.subject_id);
            if (!nodes.some((n) => n.id === row.subject_id)) {
              nodes.push({
                id: row.subject_id,
                name: row.subject_name,
                type: row.subject_type as EntityType,
                distance: d + 1,
              });
            }
          }
          edges.push({
            from: row.subject_id,
            to: row.object_id,
            predicate: row.predicate,
          });
        }
      }
    }

    frontier = nextFrontier;
  }

  return { root: rootId, depth: maxDepth, nodes, edges };
}

/**
 * Get the full timeline (active + invalidated) of an entity, ordered by time.
 * Enables "what was true about X in January?" queries.
 */
export async function getEntityTimeline(
  entityId: string,
  env: Env
): Promise<KGFact[]> {
  const normalizedId = normalizeEntityId(entityId);

  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM knowledge_graph
     WHERE subject_id = ? OR object_id = ?
     ORDER BY valid_from ASC, created_at ASC
     LIMIT 100`
  )
    .bind(normalizedId, normalizedId)
    .all<KGFactRow>();

  return result.results.map(rowToFact);
}

// ─── AI-powered entity extraction ───────────────────────────────────────────

/**
 * Extract entities and relationships from text using Workers AI,
 * then store them as knowledge graph facts.
 *
 * This is a fire-and-forget operation — failures are logged but not thrown.
 */
export async function extractAndStoreEntities(
  content: string,
  sourceType: string,
  env: Env
): Promise<void> {
  try {
    // Use Workers AI to extract entity triples from the text
    const prompt = buildEntityExtractionPrompt(content);

    const result = await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct" as Parameters<typeof env.AI.run>[0],
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: 512,
        temperature: 0.1,
      } as Parameters<typeof env.AI.run>[1]
    );

    const r = result as { response?: string };
    if (!r.response) return;

    // Parse the AI response — expect JSON array of triples
    const triples = parseEntityTriples(r.response);

    for (const triple of triples) {
      try {
        await addFact(
          triple.subjectName,
          triple.subjectType,
          triple.predicate,
          triple.objectName,
          triple.objectType,
          env,
          { confidence: triple.confidence ?? 0.6, source: sourceType }
        );
      } catch (err) {
        console.warn(`[Arcadia] KG: failed to store triple:`, err);
      }
    }

    if (triples.length > 0) {
      console.log(`[Arcadia] KG: extracted ${triples.length} triples from ${sourceType}.`);
    }
  } catch (err) {
    console.warn(`[Arcadia] KG: entity extraction failed:`, err);
  }
}

// ─── Entity extraction prompt ───────────────────────────────────────────────

interface EntityTriple {
  subjectName: string;
  subjectType: EntityType;
  predicate: string;
  objectName: string;
  objectType: EntityType;
  confidence?: number;
}

function buildEntityExtractionPrompt(content: string): { system: string; user: string } {
  return {
    system: `You extract entity-relationship triples from text. Output ONLY a JSON array — no other text.

Each triple has:
- subjectName: entity name (proper casing)
- subjectType: person|project|customer|team|channel|concept
- predicate: one of: works-on, manages, is-member-of, is-customer-of, is-contact-for, is-blocked-by, decided, owns, reports-to, depends-on, related-to
- objectName: entity name (proper casing)
- objectType: person|project|customer|team|channel|concept
- confidence: 0.0-1.0 (how confident you are)

Rules:
- Only extract clearly stated relationships, not speculative ones
- Use proper names when available
- Normalize predicate to the allowed list
- Return [] if no clear entities found
- Maximum 5 triples per extraction`,
    user: `Extract entity-relationship triples from this text:\n\n${content.slice(0, 1500)}`,
  };
}

/**
 * Parse AI response into entity triples. Tolerant of malformed output.
 */
function parseEntityTriples(response: string): EntityTriple[] {
  try {
    // Try to extract JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];

    const validTypes = new Set(["person", "project", "customer", "team", "channel", "concept"]);
    const validPredicates = new Set(VALID_PREDICATES);

    return parsed
      .filter((item): item is Record<string, unknown> => {
        if (typeof item !== "object" || item === null) return false;
        const obj = item as Record<string, unknown>;
        return (
          typeof obj.subjectName === "string" &&
          typeof obj.subjectType === "string" &&
          typeof obj.predicate === "string" &&
          typeof obj.objectName === "string" &&
          typeof obj.objectType === "string" &&
          validTypes.has(obj.subjectType) &&
          validTypes.has(obj.objectType) &&
          validPredicates.has(obj.predicate as ValidPredicate)
        );
      })
      .slice(0, 5) // Hard cap at 5 triples
      .map((obj) => ({
        subjectName: obj.subjectName as string,
        subjectType: obj.subjectType as EntityType,
        predicate: obj.predicate as string,
        objectName: obj.objectName as string,
        objectType: obj.objectType as EntityType,
        confidence: typeof obj.confidence === "number" ? Math.min(1, Math.max(0, obj.confidence)) : 0.6,
      }));
  } catch {
    return [];
  }
}

// ─── Maintenance ────────────────────────────────────────────────────────────

/**
 * Count active facts in the knowledge graph.
 */
export async function countActiveFacts(env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.ARCADIA_DB.prepare(
    `SELECT COUNT(*) as cnt FROM knowledge_graph
     WHERE valid_to IS NULL OR valid_to > ?`
  )
    .bind(now)
    .first<{ cnt: number }>();
  return result?.cnt ?? 0;
}

/**
 * Expire stale facts that haven't been updated in a long time
 * and have low confidence. Called during deep consolidation.
 */
export async function expireStaleKGFacts(
  env: Env,
  maxAgeDays = 90,
  minConfidence = 0.3
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - maxAgeDays * 86400;

  const result = await env.ARCADIA_DB.prepare(
    `UPDATE knowledge_graph SET valid_to = ?, updated_at = ?
     WHERE valid_to IS NULL
       AND updated_at < ?
       AND confidence < ?`
  )
    .bind(now, now, cutoff, minConfidence)
    .run();

  const expired = result.meta?.changes ?? 0;
  if (expired > 0) {
    console.log(`[Arcadia] KG: expired ${expired} stale low-confidence facts.`);
  }
  return expired;
}
