// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Static Asset Handler (Phase 7)
//
// Serves the single-page app from the Worker. No external static hosting needed.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import { getAppHTML } from "./frontend/app.html.js";

/**
 * Serves the main webapp HTML page.
 * The HTML includes inline CSS, JS, and MSAL configuration.
 */
export function serveApp(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const workerUrl = `${url.protocol}//${url.host}`;

  const html = getAppHTML({
    clientId: env.WEBAPP_CLIENT_ID,
    tenantId: env.GRAPH_TENANT_ID,
    workerUrl,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://alcdn.msauth.net",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com",
        "frame-src https://login.microsoftonline.com",
        "img-src 'self' data:",
      ].join("; "),
    },
  });
}
