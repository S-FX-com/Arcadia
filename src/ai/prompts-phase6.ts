// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Phase 6: MemPalace Memory Architecture Prompts
//
// Separated from prompts.ts to avoid bloating the existing 5-phase file.
//
//   buildL1GenerationPrompt         — Compress top memories into essential narrative
//   buildTunnelDetectionPrompt      — Determine if two memories are related
//   buildKnowledgeEntitySummaryPrompt — Summarize KG facts about an entity
// ─────────────────────────────────────────────────────────────────────────────

import type { Memory, KGFact } from "../types.js";

// ─── L1 Essential Story generation ──────────────────────────────────────────

/**
 * Build a prompt to compress top memories into a ~500-token essential narrative.
 * Grouped by wing, this becomes the always-on L1 context layer.
 */
export function buildL1GenerationPrompt(
  memories: Memory[],
  wingGroups: Map<string, Memory[]>
): { system: string; user: string } {
  const wingSections: string[] = [];

  for (const [wing, mems] of wingGroups) {
    const items = mems
      .slice(0, 5)
      .map((m) => `- [${m.category}] ${m.content}`)
      .join("\n");
    wingSections.push(`### ${wing}\n${items}`);
  }

  return {
    system: `You are a memory compression engine. Your job is to distill a set of organizational memories into a compact essential narrative.

Rules:
- Output MUST be under 500 tokens
- Group information by domain/wing
- Use terse, information-dense language — no filler
- Preserve: names, dates, decisions, ownership, blockers, key numbers
- Drop: pleasantries, duplicates, low-importance trivia
- Use bullet points, not prose
- Each bullet should be self-contained (readable without context)
- Format: "## [Wing Name]" followed by bullets`,
    user: `Compress these ${memories.length} memories into an essential narrative (max 500 tokens):\n\n${wingSections.join("\n\n")}`,
  };
}

// ─── Tunnel detection ───────────────────────────────────────────────────────

/**
 * Build a prompt to determine if two memories are related and how.
 * Used during consolidation to create semantic memory links.
 */
export function buildTunnelDetectionPrompt(
  memA: { content: string; wing: string | null; room: string | null },
  memB: { content: string; wing: string | null; room: string | null }
): { system: string; user: string } {
  return {
    system: `You determine if two memories are related. Output ONLY a JSON object with:
- related: boolean (true if meaningfully connected)
- linkType: "related"|"supersedes"|"contradicts"|"elaborates" (only if related=true)
- strength: 0.0-1.0 (how strongly connected)
- reason: brief explanation (max 20 words)

"supersedes" = Memory B replaces/updates Memory A
"contradicts" = Memory B conflicts with Memory A
"elaborates" = Memory B adds detail to Memory A
"related" = general topical connection

Output ONLY valid JSON. No other text.`,
    user: `Memory A [wing: ${memA.wing ?? "general"}, room: ${memA.room ?? "none"}]:
${memA.content}

Memory B [wing: ${memB.wing ?? "general"}, room: ${memB.room ?? "none"}]:
${memB.content}`,
  };
}

/**
 * Parse the tunnel detection response.
 */
export function parseTunnelDetectionResponse(
  response: string
): { related: boolean; linkType?: string; strength?: number } | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (typeof parsed.related !== "boolean") return null;

    if (!parsed.related) return { related: false };

    const validTypes = new Set(["related", "supersedes", "contradicts", "elaborates"]);
    const linkType = validTypes.has(parsed.linkType as string)
      ? (parsed.linkType as string)
      : "related";
    const strength =
      typeof parsed.strength === "number"
        ? Math.min(1, Math.max(0, parsed.strength))
        : 0.5;

    return { related: true, linkType, strength };
  } catch {
    return null;
  }
}

// ─── Knowledge entity summary ───────────────────────────────────────────────

/**
 * Build a prompt to summarize what the knowledge graph knows about an entity.
 * Used when Shane asks "what do you know about X?"
 */
export function buildKnowledgeEntitySummaryPrompt(
  entityName: string,
  facts: KGFact[]
): { system: string; user: string } {
  const factLines = facts.map((f) => {
    const temporal = f.validTo ? ` [ended ${f.validTo.slice(0, 10)}]` : "";
    const conf = f.confidence >= 0.8 ? "" : ` (confidence: ${(f.confidence * 100).toFixed(0)}%)`;
    if (f.subjectName.toLowerCase() === entityName.toLowerCase()) {
      return `- ${f.subjectName} ${f.predicate} ${f.objectName}${conf}${temporal}`;
    }
    return `- ${f.subjectName} ${f.predicate} ${f.objectName}${conf}${temporal}`;
  });

  return {
    system: `You are Arcadia, an operational intelligence layer. Summarize what you know about an entity from the knowledge graph facts below.

Rules:
- Lead with the most important facts
- Group by relationship type if there are many
- Note any temporal changes (things that used to be true)
- Flag low-confidence facts as uncertain
- Be concise — this feeds into a Teams message
- Use Arcadia's voice: smart, concise, occasionally dry`,
    user: `Summarize what I know about "${entityName}":\n\n${factLines.join("\n")}\n\nTotal facts: ${facts.length}`,
  };
}

// ─── Graph traversal summary ────────────────────────────────────────────────

/**
 * Build a prompt to narrate a graph traversal result.
 * Used for "show me the graph around X" queries.
 */
export function buildGraphTraversalSummaryPrompt(
  entityName: string,
  nodes: Array<{ name: string; type: string; distance: number }>,
  edges: Array<{ from: string; to: string; predicate: string }>
): { system: string; user: string } {
  const nodeLines = nodes
    .sort((a, b) => a.distance - b.distance)
    .map((n) => `- ${n.name} (${n.type}, ${n.distance} hop${n.distance !== 1 ? "s" : ""} away)`)
    .join("\n");

  const edgeLines = edges
    .map((e) => `- ${e.from} → ${e.predicate} → ${e.to}`)
    .join("\n");

  return {
    system: `You are Arcadia. Summarize a knowledge graph traversal as a concise narrative.

Rules:
- Start with the central entity
- Describe direct connections first, then indirect ones
- Highlight interesting patterns (clusters, bridges, isolated nodes)
- Be concise — this goes in a Teams message
- Use plain language, not graph jargon`,
    user: `Describe the knowledge graph around "${entityName}":\n\nConnected entities:\n${nodeLines}\n\nRelationships:\n${edgeLines}`,
  };
}
