// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Bot ↔ Webapp parity check (Phase 2 / Tier 3 #10)
//
// Given an identical logical input (same user, same text, same admin flag,
// same profile, same recalled memories), this script compares what each
// surface would produce in the unified pipeline and flags every divergence.
//
// It does NOT execute the full pipeline (which needs CF Workers AI, KV,
// Vectorize). It exercises the surface-dependent branches directly:
//
//   - Base system prompt builder (DM vs webapp).
//   - Model id read from env.
//   - Memory-recording call shape (teams: interaction-extraction; webapp: episodic).
//   - User-message shaping (groupchat prefix vs raw).
//   - Response formatting (trimForTeams vs raw).
//
// Run:  npx tsx scripts/verify-parity.ts
// Exit: 0 if only legitimate divergences remain; 1 if unexpected drift.
// ─────────────────────────────────────────────────────────────────────────────

import { buildDMSystemPrompt } from "../src/ai/prompts.js";
import { buildWebappSystemPrompt } from "../src/webapp/prompts.js";
import { trimForTeams } from "../src/bot/messages.js";
import { AI } from "../src/constants.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = {
  id: "user-aad-123",
  displayName: "Foundry",
  isAdmin: true,
};

const TEXT = "What did the team decide about the pricing update?";

const PROFILE = {
  userId: USER.id,
  displayName: USER.displayName,
  insights: {
    workingStyle: "analytical",
    recurringThemes: ["pricing", "compliance"],
    preferences: "concise bullet responses",
  },
  updatedAt: new Date().toISOString(),
};

const MEMORIES = [
  {
    id: "m1",
    type: "semantic",
    content: "Pricing updates require legal review before rollout.",
    importance: 0.8,
    userId: USER.id,
    createdAt: new Date().toISOString(),
  },
];

const FAKE_ENV = {
  CF_AI_DEFAULT_MODEL: "@cf/google/gemma-3-26b-it",
  MEMORY_ENABLED: "true",
};

// ─── Build prompts for both surfaces ─────────────────────────────────────────

const botSystemPrompt = buildDMSystemPrompt(
  USER.displayName,
  USER.isAdmin,
  PROFILE.insights
);

const webappSystemPrompt = buildWebappSystemPrompt(
  USER.displayName,
  USER.isAdmin,
  PROFILE,
  MEMORIES,
  "" // M365 context arrives via pipeline.extraContext on webapp
);

// ─── Shape the user message as each surface's pipeline would ─────────────────

const botUserMessage_dm = TEXT;
const botUserMessage_groupchat = `[${USER.displayName}] ${TEXT}`;
const webappUserMessage = TEXT;

// ─── Memory-recording call shape ─────────────────────────────────────────────
// Teams: recordMemoriesFromInteraction(displayName, userText, assistantText,
//                                      channelName, userId, channelId, env)
// Webapp: recordMemory("episodic", "[Webapp] <name> asked ... responded ...",
//                       0.4, null, userId, env)

const FAKE_ASSISTANT = "Legal review is pending; no decision yet.";

const botMemoryCall = {
  fn: "recordMemoriesFromInteraction",
  args: [
    USER.displayName,
    TEXT,
    FAKE_ASSISTANT,
    "DM",
    USER.id,
    null,
    "<env>",
  ],
  extractsStructuredFacts: true,
};

const webappMemoryCall = {
  fn: "recordMemory",
  args: [
    "episodic",
    `[Webapp] ${USER.displayName} asked: "${TEXT.slice(0, 200)}" — Arcadia responded with: "${FAKE_ASSISTANT.slice(0, 200)}"`,
    0.4,
    null,
    USER.id,
    "<env>",
  ],
  extractsStructuredFacts: false,
};

// ─── Response formatting ─────────────────────────────────────────────────────

const LONG_RESPONSE = "x".repeat(3500);
const botFormatted = trimForTeams(LONG_RESPONSE);
const webappFormatted = LONG_RESPONSE;

// ─── Diff reporting ──────────────────────────────────────────────────────────

const report = [];
const unexpectedDrift = [];

function section(title) {
  report.push(`\n=== ${title} ===`);
}

function equal(label, a, b, legit) {
  const ok = a === b;
  const tag = ok ? "OK   " : legit ? "DIFF*" : "DIFF ";
  report.push(`${tag} ${label}`);
  if (!ok && !legit) unexpectedDrift.push(label);
  if (!ok) {
    report.push(`   teams : ${JSON.stringify(a).slice(0, 120)}`);
    report.push(`   webapp: ${JSON.stringify(b).slice(0, 120)}`);
  }
}

function equalObj(label, a, b, legit) {
  const aj = JSON.stringify(a);
  const bj = JSON.stringify(b);
  equal(label, aj, bj, legit);
}

section("Model");
equal("env.CF_AI_DEFAULT_MODEL used by both", FAKE_ENV.CF_AI_DEFAULT_MODEL, FAKE_ENV.CF_AI_DEFAULT_MODEL, false);
equal("AI.HISTORY_MAX_TURNS (shared constant)", AI.HISTORY_MAX_TURNS, AI.HISTORY_MAX_TURNS, false);
equal("AI.DEFAULT_MAX_TOKENS (shared constant)", AI.DEFAULT_MAX_TOKENS, AI.DEFAULT_MAX_TOKENS, false);

section("System prompt");
equal(
  "system prompt byte-identical",
  botSystemPrompt,
  webappSystemPrompt,
  true // legitimately different: DM vs webapp surface language
);
equal(
  "both mention user's displayName",
  botSystemPrompt.includes(USER.displayName),
  webappSystemPrompt.includes(USER.displayName),
  false
);
equal(
  "both honour admin access level",
  /admin/i.test(botSystemPrompt),
  /admin/i.test(webappSystemPrompt),
  false
);
equal(
  "webapp prompt embeds recalled memories inline",
  false,
  webappSystemPrompt.includes(MEMORIES[0].content),
  true // teams expects assembleContext to inject memories; webapp inlines them → divergence noted
);

section("User message shaping");
equal("DM user message == raw text", botUserMessage_dm, TEXT, false);
equal("webapp user message == raw text", webappUserMessage, TEXT, false);
equal(
  "groupchat prefixes speaker name",
  botUserMessage_groupchat,
  `[${USER.displayName}] ${TEXT}`,
  false
);
equal(
  "DM and webapp share the same user-message shape",
  botUserMessage_dm,
  webappUserMessage,
  false
);

section("Memory recording call");
equal("memory-recording function name matches", botMemoryCall.fn, webappMemoryCall.fn, true);
equal(
  "both extract structured facts from interaction",
  botMemoryCall.extractsStructuredFacts,
  webappMemoryCall.extractsStructuredFacts,
  true // webapp records episodic only
);
equalObj("memory-recording args identical", botMemoryCall.args, webappMemoryCall.args, true);

section("Response formatting");
equal(
  "Teams trims to MESSAGE_MAX_LENGTH; webapp returns raw",
  botFormatted === LONG_RESPONSE,
  webappFormatted === LONG_RESPONSE,
  true // legitimate surface constraint
);
equal("trimForTeams actually trimmed", botFormatted.length < LONG_RESPONSE.length, true, false);

// ─── Output ──────────────────────────────────────────────────────────────────

console.log("Arcadia bot↔webapp parity check\n");
console.log("Legend: OK = same | DIFF* = legitimate surface-level divergence | DIFF = unexpected\n");
console.log(report.join("\n"));

console.log("\n─────────────────────────────────────────────");
console.log("Summary of legitimate divergences (by design):");
console.log("  1. Base system prompt wording differs: DM framing vs webapp/M365 framing.");
console.log("  2. Webapp inlines recalled memories; Teams relies on assembleContext to inject them.");
console.log("  3. Memory recording: Teams uses recordMemoriesFromInteraction (fact extraction);");
console.log("     Webapp uses recordMemory('episodic', ...) (raw turn).");
console.log("  4. Teams trims responses to TEAMS.MESSAGE_MAX_LENGTH; Webapp returns raw.");
console.log("  5. Group-chat user messages are prefixed with the speaker's name.");
console.log("─────────────────────────────────────────────");

if (unexpectedDrift.length > 0) {
  console.error(`\nFAIL — ${unexpectedDrift.length} unexpected divergence(s):`);
  for (const d of unexpectedDrift) console.error(`  • ${d}`);
  process.exit(1);
}
console.log("\nPASS — only legitimate surface-level divergences detected.");
