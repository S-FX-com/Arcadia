import { afterEach, describe, expect, it, vi } from "vitest";
import { graph, graphAllPages } from "../../src/graph/client";
import type { Env } from "../../src/env";

// Unit test (node env): the Graph client is exercised against a stubbed
// global fetch. Two behaviours are covered — the absolute-URL pagination fix
// in buildUrl, and graphAllPages following @odata.nextLink to the deltaLink.

const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN_URL =
  "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token";

function fakeEnv(): Env {
  // Only the fields appToken() + the client read. KV is a null cache so
  // every call re-mints a token (which the fetch stub serves).
  return {
    GRAPH_TENANT_ID: "tenant-1",
    GRAPH_CLIENT_ID: "client-1",
    GRAPH_CLIENT_SECRET: "secret-1",
    ARCADIA_CACHE: {
      get: async () => null,
      put: async () => undefined,
    },
  } as unknown as Env;
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "tok",
      expires_in: 3600,
      token_type: "Bearer",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("graph client pagination", () => {
  it("follows @odata.nextLink across pages and returns the final deltaLink", async () => {
    const graphCalls: string[] = [];
    const pages: Record<string, unknown> = {
      [`${GRAPH}/users/delta`]: {
        value: [{ id: "u1" }],
        "@odata.nextLink": `${GRAPH}/users/delta?$skiptoken=p2`,
      },
      [`${GRAPH}/users/delta?$skiptoken=p2`]: {
        value: [{ id: "u2" }, { id: "u3" }],
        "@odata.deltaLink": `${GRAPH}/users/delta?$deltatoken=DTOK`,
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.startsWith(TOKEN_URL)) return tokenResponse();
        graphCalls.push(url);
        const body = pages[url];
        if (body === undefined) throw new Error(`unexpected url: ${url}`);
        return jsonResponse(body);
      }),
    );

    const { items, deltaLink } = await graphAllPages<{ id: string }>(
      fakeEnv(),
      { path: "/users/delta" },
    );

    expect(items.map((i) => i.id)).toEqual(["u1", "u2", "u3"]);
    expect(deltaLink).toBe(`${GRAPH}/users/delta?$deltatoken=DTOK`);
    // Page 2 was fetched from the absolute nextLink verbatim — no double
    // prefix (the bug this fix targets).
    expect(graphCalls).toEqual([
      `${GRAPH}/users/delta`,
      `${GRAPH}/users/delta?$skiptoken=p2`,
    ]);
    expect(graphCalls.some((u) => u.includes("/v1.0/https://"))).toBe(false);
  });

  it("uses an absolute https path verbatim in graph()", async () => {
    const graphCalls: string[] = [];
    const abs = `${GRAPH}/sites?$skiptoken=abc`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.startsWith(TOKEN_URL)) return tokenResponse();
        graphCalls.push(url);
        return jsonResponse({ value: [] });
      }),
    );

    await graph(fakeEnv(), { path: abs });
    expect(graphCalls).toEqual([abs]);
  });

  it("stops at maxPages even when nextLink never terminates", async () => {
    let page = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.startsWith(TOKEN_URL)) return tokenResponse();
        page += 1;
        return jsonResponse({
          value: [{ id: `p${page}` }],
          "@odata.nextLink": `${GRAPH}/loop?p=${page + 1}`,
        });
      }),
    );

    const { items } = await graphAllPages<{ id: string }>(
      fakeEnv(),
      { path: "/loop" },
      { maxPages: 3 },
    );
    expect(items).toHaveLength(3);
  });
});
