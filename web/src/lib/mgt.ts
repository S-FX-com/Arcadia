// Microsoft Graph Toolkit bootstrap.
//
// Lazy-loads @microsoft/mgt and configures the MSAL2 provider so the
// `<mgt-person>`, `<mgt-agenda>`, `<mgt-people-picker>` web components
// resolve identities through the same Entra app registration used by
// the webapp session.
//
// Configuration comes from Vite env vars (PUBLIC_-prefixed):
//   PUBLIC_WEBAPP_CLIENT_ID   The Entra app's client id.
//   PUBLIC_MGT_REDIRECT_URI   Redirect URI registered for that app.
//   PUBLIC_MGT_SCOPES         Comma-separated Graph scopes (optional).
//   PUBLIC_WEBAPP_API_SCOPE   Scope for tokens issued for our own webapp
//                             API (aud = WEBAPP_CLIENT_ID), used by both
//                             the /api/webapp/auth/exchange token and the
//                             x-graph-token sent to /api/webapp/search.
//                             Defaults to the standard exposed-API scope
//                             `api://<clientId>/access_as_user`, which
//                             matches the audiences verifyEntraToken
//                             accepts on the worker side
//                             (src/lib/entra-verify.ts).
//
// Bootstrap is idempotent — calling configureMgt() twice is a no-op
// after the first successful initialisation.

let configured = false;

const DEFAULT_SCOPES = [
	"User.Read",
	"People.Read",
	"Calendars.Read",
	"Files.Read",
	"Sites.Read.All",
];

export async function configureMgt(): Promise<boolean> {
	if (configured) return true;
	if (typeof window === "undefined") return false;

	const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
	const clientId = env.PUBLIC_WEBAPP_CLIENT_ID;
	if (!clientId) {
		// Without a client id we can't initialise the provider; the
		// custom-element tags will fall through to placeholder text.
		return false;
	}

	const redirectUri = env.PUBLIC_MGT_REDIRECT_URI ?? window.location.origin;
	const scopes = (env.PUBLIC_MGT_SCOPES?.split(",").map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_SCOPES;

	try {
		const [{ Providers }, { Msal2Provider }] = await Promise.all([
			import("@microsoft/mgt-element"),
			import("@microsoft/mgt-msal2-provider"),
		]);
		await import("@microsoft/mgt-components");

		Providers.globalProvider = new Msal2Provider({
			clientId,
			redirectUri,
			scopes,
		});

		configured = true;
		return true;
	} catch (e) {
		// MGT not installed yet — fall through silently.
		// eslint-disable-next-line no-console
		console.warn("mgt_init_failed", e);
		return false;
	}
}

/**
 * Acquire an access token for Arcadia's own webapp API (aud =
 * WEBAPP_CLIENT_ID), via the same MSAL2 provider `configureMgt()` sets up
 * for the MGT web components. This is the token shape both
 * `/api/webapp/auth/exchange` (the session cookie) and `/api/webapp/search`
 * (the `x-graph-token` header, exchanged server-side via On-Behalf-Of —
 * see src/graph/delegated.ts) expect: a v2.0 Entra token whose audience is
 * this app registration, not a Graph-scoped token.
 *
 * Returns null when MGT isn't configured or no account is signed in yet —
 * callers should treat that the same as "not authenticated".
 */
export async function getApiToken(): Promise<string | null> {
	const ok = await configureMgt();
	if (!ok) return null;

	const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
	const clientId = env.PUBLIC_WEBAPP_CLIENT_ID;
	if (!clientId) return null;
	const apiScope = env.PUBLIC_WEBAPP_API_SCOPE ?? `api://${clientId}/access_as_user`;

	try {
		const { Providers, ProviderState } = await import("@microsoft/mgt-element");
		const provider = Providers.globalProvider;
		if (!provider || provider.state !== ProviderState.SignedIn) return null;
		return await provider.getAccessToken({ scopes: [apiScope] });
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn("mgt_get_api_token_failed", e);
		return null;
	}
}
