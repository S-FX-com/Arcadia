#!/usr/bin/env bash
# Arcadia v4 provisioning (§3, §9). Everything here is repeatable from a clean
# clone; the human-only steps in CLAUDE.md §9 are NOT automated and are
# printed at the end. Run: npm run setup
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Arcadia setup: Cloudflare resources =="
command -v npx >/dev/null || { echo "npx not found — install Node 20+"; exit 1; }

# --- D1 -----------------------------------------------------------------
if ! npx wrangler d1 list 2>/dev/null | grep -q "arcadia-ops"; then
  echo "-- creating D1 database arcadia-ops"
  npx wrangler d1 create arcadia-ops
  echo "!! paste the database_id printed above into wrangler.jsonc (d1_databases[0].database_id)"
else
  echo "-- D1 arcadia-ops exists"
fi

# --- KV ------------------------------------------------------------------
echo "-- KV namespace CONTROL (create once; paste the id into wrangler.jsonc)"
npx wrangler kv namespace create CONTROL 2>/dev/null || echo "   (already exists or paste id manually)"

# --- R2 ------------------------------------------------------------------
npx wrangler r2 bucket create arcadia-artifacts 2>/dev/null || echo "-- R2 arcadia-artifacts exists"

# --- Queues --------------------------------------------------------------
npx wrangler queues create arcadia-vectorize 2>/dev/null || echo "-- queue arcadia-vectorize exists"
npx wrangler queues create arcadia-vectorize-dlq 2>/dev/null || echo "-- queue arcadia-vectorize-dlq exists"

# --- Vectorize (768-dim cosine — @cf/baai/bge-base-en-v1.5) ---------------
# Vectorize is NOT covered by wrangler auto-provisioning; create explicitly.
for idx in arcadia-doctrine-canonical arcadia-doctrine-staging arcadia-episodic; do
  npx wrangler vectorize create "$idx" --dimensions=768 --metric=cosine 2>/dev/null \
    || echo "-- vectorize index $idx exists"
done

# --- Reference clone (gitignored, §2) -------------------------------------
if [ ! -d reference ]; then
  echo "-- cloning cloudflare/agents into reference/ (gitignored)"
  git clone --depth 1 https://github.com/cloudflare/agents reference
fi

# --- Schema ----------------------------------------------------------------
echo "-- applying D1 schema locally (add --remote after the database_id is set)"
npx wrangler d1 execute arcadia-ops --file=src/schema/d1.sql || true

cat <<'EOF'

== Done with the automatable part. Human-only steps remaining (CLAUDE.md §9) ==
 1. (optional) Anthropic API key — only needed if you route a task to Claude
    in admin. Arcadia defaults to Workers AI and runs without it.
    -> wrangler secret put ANTHROPIC_API_KEY
 2. AI Gateway named `arcadia` in the Cloudflare dashboard
    -> set CF_ACCOUNT_ID + AI_GATEWAY_ID vars in wrangler.jsonc
    -> (if authenticated gateway) wrangler secret put AI_GATEWAY_TOKEN
 3. Cloudflare API token for wrangler (you presumably have this already)
 4. Entra ID app registration for Microsoft SSO (the staff sign-in). Platform
    "Web", redirect URI https://arcadia.s-fx.com/auth/callback (add
    http://localhost:8787/auth/callback for `wrangler dev`). Delegated
    permissions openid + profile + email; no admin consent needed.
    Same registration is reused for Graph in Phase 1b — hence the GRAPH_ names.
    -> set GRAPH_TENANT_ID + GRAPH_CLIENT_ID vars in wrangler.jsonc
    -> wrangler secret put GRAPH_CLIENT_SECRET
    -> wrangler secret put SSO_SESSION_SECRET   # openssl rand -base64 32

== Optional, per phase ==
 Phase 1b Stall Radar signals:
   wrangler secret put GITHUB_TOKEN          # git commit activity
   Graph (Planner / SharePoint / Teams velocity) needs §9.7 first — it adds
   application permissions to the app registration from step 5 above, so
   GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET are already set
 Escalation email (board-only until set):
   wrangler secret put EMAIL_API_KEY         # Resend-compatible
   set EMAIL_FROM + FOUNDER_EMAIL vars in wrangler.jsonc

Then: paste the D1/KV ids into wrangler.jsonc, run
  npm run db:apply:remote && npx wrangler deploy
and POST /init (or wait for the daily bootstrap cron) to wake the agents.

First run: sign in at /approval as shane@s-fx.com or alex@s-fx.com — the two
seeded superadmins — then add the rest of the team under Staff, and register
projects under the accountability board so Radar has something to watch.
EOF
