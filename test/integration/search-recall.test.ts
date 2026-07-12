// Integration tests for P3 item 3 of EXECUTION-PLAN.md: Microsoft Search as
// a *recall surface* that augments Arcadia's vector recall in chat
// (src/webapp/chat-stream.ts). When the chat request carries a delegated
// `x-graph-token`, handleChatStream ALSO runs microsoftSearch for the user's
// message and merges the (Graph security-trimmed) hits into the context
// handed to the model, in a section clearly separate from recalled memory.
//
// Sessions are minted the same way delegated-search.test.ts / sources-api.
// test.ts do: a locally-generated RSA keypair stands in for Microsoft's
// tenant JWKS (keyResolver seam) and exchangeAndSeal() issues the real
// sealed session. The delegated-auth + Microsoft Search hops and the
// streaming provider are all substituted via handleChatStream's injectable
// ChatStreamDeps seam, so no live Entra tenant, Graph, or Anthropic endpoint
// is touched — and the assembled prompt is captured off the streamer.
import { env } from "cloudflare:test";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { CompleteRequest } from "../../src/ai/types";
import type { Env } from "../../src/env";
import type { DelegatedIdentity } from "../../src/graph/delegated";
import type { SearchResultItem } from "../../src/graph/search";
import { MemoryStore } from "../../src/memory/store";
import { logger } from "../../src/lib/logger";
import { exchangeAndSeal, type Session } from "../../src/webapp/auth";
import {
  handleChatStream,
  type ChatStreamDeps,
  type ChatStreamer,
} from "../../src/webapp/chat-stream";

const testEnv = env as unknown as Env;
const log = logger();

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  keyResolver = (() => pair.publicKey) as unknown as JWTVerifyGetKey;
});

async function mintToken(oid: string): Promise<string> {
  return new SignJWT({ tid: testEnv.GRAPH_TENANT_ID, oid })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(
      `https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`,
    )
    .setAudience(testEnv.WEBAPP_CLIENT_ID)
    .sign(privateKey);
}

async function mintSession(oid: string): Promise<Session> {
  const token = await mintToken(oid);
  const { session } = await exchangeAndSeal(testEnv, token, { keyResolver });
  return session;
}

const CANNED_HITS: SearchResultItem[] = [
  {
    type: "driveItem",
    id: "drive-item-1",
    title: "Q3 Budget Plan.docx",
    summary: "quarterly budget breakdown",
    webUrl: "https://contoso.sharepoint.com/Q3Plan.docx",
    lastModified: "2026-06-01T12:00:00Z",
  },
  {
    type: "message",
    id: "message-1",
    title: "Re: launch timeline",
    summary: "confirming the launch date",
    webUrl: null,
    lastModified: null,
  },
];

// Vectorize + Workers AI aren't simulatable under miniflare, so we inject a
// MemoryStore whose vector-search seam returns no hits — these tests exercise
// the live-search augmentation, not memory recall (covered by
// unified-recall.test.ts).
function emptyMemory(): MemoryStore {
  return new MemoryStore(testEnv, async () => []);
}

/** Streamer that records the assembled request and emits a canned response. */
function capturingStreamer(captured: { req?: CompleteRequest }): ChatStreamer {
  return {
    async *stream(req: CompleteRequest) {
      captured.req = req;
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const };
    },
  };
}

function chatRequest(message: string, graphToken?: string): Request {
  return new Request("https://arcadia.test/api/webapp/chat/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(graphToken ? { "x-graph-token": graphToken } : {}),
    },
    body: JSON.stringify({ message }),
  });
}

/** Concatenate every message's content, i.e. the full assembled prompt. */
function promptText(req: CompleteRequest | undefined): string {
  return (req?.messages ?? []).map((m) => m.content).join("\n");
}

describe("Microsoft Search as a chat recall surface", () => {
  it("merges live search hits into the prompt when x-graph-token is present", async () => {
    const session = await mintSession("recall-user-1");
    const captured: { req?: CompleteRequest } = {};

    let searchedQuery: string | undefined;
    let oboReceivedUserToken: string | undefined;
    const OBO_TOKEN = "fake-obo-token";

    const deps: ChatStreamDeps = {
      resolveDelegated: async (): Promise<DelegatedIdentity> => ({
        aadId: session.aadId,
        tenantId: session.tenantId,
        userToken: "raw-user-token",
      }),
      delegatedGraphToken: async (_env, userToken) => {
        oboReceivedUserToken = userToken;
        return OBO_TOKEN;
      },
      microsoftSearch: async (_env, oboToken, query) => {
        searchedQuery = query;
        expect(oboToken).toBe(OBO_TOKEN);
        return CANNED_HITS;
      },
      createStreamer: () => capturingStreamer(captured),
      createMemoryStore: () => emptyMemory(),
    };

    const res = await handleChatStream(
      chatRequest("what's the Q3 budget?", "graph-token-abc"),
      testEnv,
      session,
      log,
      deps,
    );

    // SSE contract intact.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const streamBody = await res.text();
    expect(streamBody).toContain("event: done");

    // The delegated hops ran with the verified user's token, and the search
    // used the chat message as its query.
    expect(oboReceivedUserToken).toBe("raw-user-token");
    expect(searchedQuery).toBe("what's the Q3 budget?");

    // The live hits reached the model, under their own delimited section.
    const prompt = promptText(captured.req);
    expect(prompt).toContain("Live Microsoft 365 search results:");
    expect(prompt).toContain("Q3 Budget Plan.docx");
    expect(prompt).toContain("quarterly budget breakdown");
    expect(prompt).toContain("Re: launch timeline");
  });

  it("stays memory-only (no live section) when x-graph-token is absent", async () => {
    const session = await mintSession("recall-user-2");
    const captured: { req?: CompleteRequest } = {};

    let searchCalled = false;
    const deps: ChatStreamDeps = {
      resolveDelegated: async () => {
        throw new Error("resolveDelegated must not run without a token");
      },
      delegatedGraphToken: async () => {
        throw new Error("delegatedGraphToken must not run without a token");
      },
      microsoftSearch: async () => {
        searchCalled = true;
        return CANNED_HITS;
      },
      createStreamer: () => capturingStreamer(captured),
      createMemoryStore: () => emptyMemory(),
    };

    const res = await handleChatStream(
      chatRequest("what's the Q3 budget?"),
      testEnv,
      session,
      log,
      deps,
    );

    expect(res.status).toBe(200);
    await res.text();

    expect(searchCalled).toBe(false);
    const prompt = promptText(captured.req);
    expect(prompt).not.toContain("Live Microsoft 365 search results:");
    expect(prompt).not.toContain("Q3 Budget Plan.docx");
  });

  it("degrades to memory-only when the live search throws (chat never breaks)", async () => {
    const session = await mintSession("recall-user-3");
    const captured: { req?: CompleteRequest } = {};

    const deps: ChatStreamDeps = {
      resolveDelegated: async (): Promise<DelegatedIdentity> => ({
        aadId: session.aadId,
        tenantId: session.tenantId,
        userToken: "raw-user-token",
      }),
      delegatedGraphToken: async () => "fake-obo-token",
      microsoftSearch: async () => {
        throw new Error("AADSTS65001: consent required");
      },
      createStreamer: () => capturingStreamer(captured),
      createMemoryStore: () => emptyMemory(),
    };

    const res = await handleChatStream(
      chatRequest("what's the Q3 budget?", "graph-token-abc"),
      testEnv,
      session,
      log,
      deps,
    );

    // The stream still completes normally — the failure is swallowed.
    expect(res.status).toBe(200);
    const streamBody = await res.text();
    expect(streamBody).toContain("event: done");
    expect(streamBody).not.toContain("event: error");

    const prompt = promptText(captured.req);
    expect(prompt).not.toContain("Live Microsoft 365 search results:");
  });
});
