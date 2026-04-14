// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp HTML Template (Phase 7)
//
// Main HTML page served at /app. Includes inline CSS and JS.
// Config values are injected server-side.
// ─────────────────────────────────────────────────────────────────────────────

import { APP_CSS } from "./styles.css.js";
import { getClientJS } from "./client.js.js";

/**
 * Returns the complete HTML page as a string with config injected.
 */
export function getAppHTML(config: {
  clientId: string;
  tenantId: string;
  workerUrl: string;
}): string {
  const redirectUri = `${config.workerUrl}/app/auth/callback`;
  const clientJS = getClientJS({
    clientId: config.clientId,
    tenantId: config.tenantId,
    redirectUri,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Arcadia — S-FX</title>
  <meta name="description" content="Arcadia operational intelligence — your AI-powered M365 assistant">
  <meta name="theme-color" content="#060a14">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>✦</text></svg>">

  <!-- MSAL.js for Azure AD authentication (Using unpkg + jsdelivr fallback) -->
  <script src="https://unpkg.com/@azure/msal-browser@2.38.3/lib/msal-browser.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.3/lib/msal-browser.min.js"></script>

  <style>${APP_CSS}</style>
</head>
<body>
  <div id="app">
    <!-- Loading state before MSAL initializes -->
    <div class="login-screen">
      <div class="login-logo">
        <div class="login-badge">S-FX Technology</div>
        <h1><span>Arcadia</span></h1>
        <p>Initializing...</p>
      </div>
    </div>
  </div>

  <script>${clientJS}</script>
</body>
</html>`;
}
