import { describe, expect, it } from "vitest";
import { readCookie, seal, unseal } from "../src/lib/session";
import { beginLogin, readIdentity, redirectToLogin, ssoConfig, SsoError } from "../src/lib/sso";

const SECRET = "test-session-secret-not-a-real-one";

const env = (over: Partial<Env> = {}): Env =>
  ({
    GRAPH_TENANT_ID: "11111111-2222-3333-4444-555555555555",
    GRAPH_CLIENT_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    GRAPH_CLIENT_SECRET: "client-secret",
    SSO_SESSION_SECRET: SECRET,
    ...over,
  }) as Env;

const withCookie = (url: string, cookie?: string) =>
  new Request(url, cookie ? { headers: { Cookie: cookie } } : undefined);

/** The sealed value of the login cookie beginLogin set on a response. */
const loginCookieValue = (res: Response): string => {
  const value = res.headers.get("Set-Cookie")?.split(";")[0]?.split("=")[1];
  if (!value) throw new Error("beginLogin set no login cookie");
  return value;
};

describe("session sealing", () => {
  it("round-trips a payload", async () => {
    const token = await seal(SECRET, { email: "shane@s-fx.com", exp: 99 });
    expect(await unseal(SECRET, token)).toEqual({ email: "shane@s-fx.com", exp: 99 });
  });

  it("rejects a payload tampered with after signing", async () => {
    const token = await seal(SECRET, { email: "shane@s-fx.com" });
    const forged = (await seal(SECRET, { email: "mallory@s-fx.com" })).split(".")[0];
    expect(await unseal(SECRET, `${forged}.${token.split(".")[1]}`)).toBeNull();
  });

  it("rejects a signature made with a different secret", async () => {
    const token = await seal("some-other-secret", { email: "mallory@s-fx.com" });
    expect(await unseal(SECRET, token)).toBeNull();
  });

  it("rejects malformed and absent tokens", async () => {
    expect(await unseal(SECRET, undefined)).toBeNull();
    expect(await unseal(SECRET, "")).toBeNull();
    expect(await unseal(SECRET, "no-dot")).toBeNull();
    expect(await unseal(SECRET, ".onlysig")).toBeNull();
    expect(await unseal(SECRET, "onlypayload.")).toBeNull();
  });
});

describe("readCookie", () => {
  it("picks one cookie out of several", () => {
    const request = withCookie("https://arcadia.s-fx.com/", "a=1; arcadia_session=xyz; b=2");
    expect(readCookie(request, "arcadia_session")).toBe("xyz");
    expect(readCookie(request, "missing")).toBeUndefined();
  });
});

describe("ssoConfig", () => {
  it("names every unset variable rather than failing vaguely", () => {
    try {
      ssoConfig({} as Env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SsoError);
      expect((err as SsoError).reason).toBe("sso_not_configured");
      expect((err as SsoError).message).toContain("GRAPH_CLIENT_ID");
      expect((err as SsoError).message).toContain("SSO_SESSION_SECRET");
    }
  });

  it("reads the one Entra app registration Graph also uses", () => {
    const cfg = ssoConfig(env({ GRAPH_TENANT_ID: "graph-tenant" }));
    expect(cfg.tenantId).toBe("graph-tenant");
    expect(cfg.clientId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});

describe("beginLogin", () => {
  it("redirects to the tenant with PKCE and stashes the guards in a cookie", async () => {
    const res = await beginLogin(env(), new Request("https://arcadia.s-fx.com/auth/login"));
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("Location") as string);
    expect(location.origin).toBe("https://login.microsoftonline.com");
    expect(location.pathname).toBe("/11111111-2222-3333-4444-555555555555/oauth2/v2.0/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe("https://arcadia.s-fx.com/auth/callback");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();

    const cookie = res.headers.get("Set-Cookie") as string;
    expect(cookie).toContain("arcadia_login=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    // Strict would withhold the cookie on the cross-site return from Entra.
    expect(cookie).toContain("SameSite=Lax");
  });

  it("never sends the PKCE verifier to the identity provider", async () => {
    const res = await beginLogin(env(), new Request("https://arcadia.s-fx.com/auth/login"));
    const location = res.headers.get("Location") as string;
    const sealed = loginCookieValue(res);
    const pending = (await unseal<{ verifier: string }>(SECRET, sealed)) as { verifier: string };
    expect(pending.verifier).toBeTruthy();
    expect(location).not.toContain(pending.verifier);
  });

  it("refuses an off-site returnTo instead of becoming an open redirect", async () => {
    for (const hostile of ["//evil.com", "/\\evil.com", "https://evil.com"]) {
      const res = await beginLogin(
        env(),
        new Request(`https://arcadia.s-fx.com/auth/login?returnTo=${encodeURIComponent(hostile)}`)
      );
      const sealed = loginCookieValue(res);
      const pending = (await unseal<{ returnTo: string }>(SECRET, sealed)) as { returnTo: string };
      // Falls back to the front door — the chat with Arcadia — not to the
      // hostile target.
      expect(pending.returnTo).toBe("/");
    }
  });

  it("keeps a same-origin returnTo", async () => {
    const res = await beginLogin(
      env(),
      new Request("https://arcadia.s-fx.com/auth/login?returnTo=%2Fapproval%2Fledger%3Ftab%3Dopen")
    );
    const sealed = loginCookieValue(res);
    const pending = (await unseal<{ returnTo: string }>(SECRET, sealed)) as { returnTo: string };
    expect(pending.returnTo).toBe("/approval/ledger?tab=open");
  });
});

describe("readIdentity", () => {
  const url = "https://arcadia.s-fx.com/approval";

  it("accepts a live signed session", async () => {
    const cookie = await seal(SECRET, {
      email: "shane@s-fx.com",
      aadId: "oid-1",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const identity = await readIdentity(env(), withCookie(url, `arcadia_session=${cookie}`));
    expect(identity).toEqual({ email: "shane@s-fx.com", aadId: "oid-1" });
  });

  it("refuses an expired session", async () => {
    const cookie = await seal(SECRET, {
      email: "shane@s-fx.com",
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    expect(await readIdentity(env(), withCookie(url, `arcadia_session=${cookie}`))).toBeNull();
  });

  it("refuses a forged session and a missing one", async () => {
    const forged = await seal("attacker-secret", {
      email: "mallory@s-fx.com",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    expect(await readIdentity(env(), withCookie(url, `arcadia_session=${forged}`))).toBeNull();
    expect(await readIdentity(env(), withCookie(url))).toBeNull();
  });

  it("returns null instead of throwing when SSO is unconfigured", async () => {
    expect(await readIdentity({} as Env, withCookie(url, "arcadia_session=whatever"))).toBeNull();
  });

  describe("DEV_MODE", () => {
    it("bypasses SSO on a loopback host", async () => {
      const identity = await readIdentity(env({ DEV_MODE: "true" }), new Request("http://localhost:8787/approval"));
      expect(identity).toEqual({ email: "dev@localhost" });
    });

    it("does not bypass on the deployed host even if the flag leaks into prod", async () => {
      expect(await readIdentity(env({ DEV_MODE: "true" }), new Request(url))).toBeNull();
    });
  });
});

describe("redirectToLogin", () => {
  it("preserves where the browser was headed", () => {
    const res = redirectToLogin(new Request("https://arcadia.s-fx.com/approval/ledger?tab=open"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/auth/login?returnTo=${encodeURIComponent("/approval/ledger?tab=open")}`
    );
  });
});
