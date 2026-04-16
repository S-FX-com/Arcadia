import {
  queryEntity,
  traverseGraph,
  getEntityTimeline,
  countActiveFacts,
} from "../../memory/knowledge-graph.js";
import { callAI } from "../../ai/router.js";
import {
  buildKnowledgeEntitySummaryPrompt,
  buildGraphTraversalSummaryPrompt,
} from "../../ai/prompts-phase6.js";
import { features } from "../../features.js";
import type { Env } from "../../types.js";
import type { IntentHandler } from "./types.js";

export async function runKnowledgeCommand(rawText: string, env: Env): Promise<string> {
  if (!features.knowledgeGraph(env)) {
    return "Knowledge graph is not enabled. Set `KNOWLEDGE_GRAPH_ENABLED=true` to activate.";
  }

  const graphMatch = /(?:graph|show\s+(?:me\s+)?(?:the\s+)?graph)\s+(?:of|for|about|around)?\s*(.+)/i.exec(rawText);
  if (graphMatch && graphMatch[1]) {
    const entityName = graphMatch[1].trim();
    const traversal = await traverseGraph(entityName, 2, env);
    if (traversal.nodes.length === 0) {
      return `I don't have any knowledge graph data about "${entityName}" yet.`;
    }
    const prompt = buildGraphTraversalSummaryPrompt(entityName, traversal.nodes, traversal.edges);
    const response = await callAI(prompt.system, prompt.user, env);
    return response.text;
  }

  const timelineMatch = /timeline\s+(?:of|for)?\s*(.+)/i.exec(rawText);
  if (timelineMatch && timelineMatch[1]) {
    const entityName = timelineMatch[1].trim();
    const timeline = await getEntityTimeline(entityName, env);
    if (timeline.length === 0) {
      return `No timeline data for "${entityName}" yet.`;
    }
    const lines = timeline.map((f) => {
      const status = f.validTo ? "(ended)" : "(active)";
      const date = f.validFrom ?? f.createdAt;
      return `- [${date.slice(0, 10)}] ${f.subjectName} ${f.predicate} ${f.objectName} ${status}`;
    });
    return `**Timeline for "${entityName}":**\n${lines.join("\n")}`;
  }

  const knowMatch = /(?:knowledge|know\s+about|what\s+do\s+you\s+know\s+about|entities?)\s*(.+)?/i.exec(rawText);
  if (knowMatch && knowMatch[1]?.trim()) {
    const entityName = knowMatch[1].trim();
    const entityFacts = await queryEntity(entityName, env);
    if (entityFacts.facts.length === 0) {
      return `I don't have any knowledge about "${entityName}" in the graph yet.`;
    }
    const prompt = buildKnowledgeEntitySummaryPrompt(entityName, entityFacts.facts);
    const response = await callAI(prompt.system, prompt.user, env);
    return response.text;
  }

  const factCount = await countActiveFacts(env);
  return `**Knowledge Graph:**\n- Active facts: ${factCount}\n\nTry:\n- \`knowledge [name]\` — what I know about someone/something\n- \`graph [name]\` — connected entities\n- \`timeline [name]\` — history over time`;
}

export const handle: IntentHandler = async (ctx) => {
  if (!ctx.isAdmin) {
    return { text: "Knowledge graph commands are available to administrators only." };
  }
  const text = await runKnowledgeCommand(ctx.command.rawText, ctx.env);
  return { text };
};
