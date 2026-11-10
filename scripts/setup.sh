#!/usr/bin/env bash
# Arcadia provisioning. Everything here is repeatable from a clean clone. The
# steps in the Human-only steps section of CLAUDE.md are NOT automated and are
# printed at the end. It provisions only what v6 uses; resources v5 left
# behind are listed in docs/teardown-v5.md. Run: npm run setup
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Arcadia setup: Cloudflare resources =="
command -v npx >/dev/null || { echo "npx not found — install Node 22+"; exit 1; }

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

# --- Queues and Vectorize ---------------------------------------------------
# Both serve the MemoryProfile retrieval engine (src/memory/). Phase 9 adopts
# or deletes it; until then the bindings in wrangler.jsonc need these to exist.
npx wrangler queues create arcadia-vectorize 2>/dev/null || echo "-- queue arcadia-vectorize exists"
npx wrangler queues create arcadia-vectorize-dlq 2>/dev/null || echo "-- queue arcadia-vectorize-dlq exists"

# Vectorize: 768-dim cosine (@cf/baai/bge-base-en-v1.5). Not covered by
# wrangler auto-provisioning, so create explicitly.
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
# Schema is numbered files in migrations/ (see migrations/README.md). This
# applies them to the local DB only; the remote apply is the closing step.
echo "-- applying D1 migrations locally"
npm run db:migrate:local || true

cat <<'EOF'

== Done with the automatable part. Human-only steps remaining (CLAUDE.md, Human-only steps) ==
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
    The same registration serves the app-only Graph client (roster sync,
    Shifts) — hence the GRAPH_ names. Graph application consent is a
    separate step (CLAUDE.md, Human-only steps).
    -> set GRAPH_TENANT_ID + GRAPH_CLIENT_ID vars in wrangler.jsonc
    -> wrangler secret put GRAPH_CLIENT_SECRET
    -> wrangler secret put SSO_SESSION_SECRET   # openssl rand -base64 32

Then: paste the D1/KV ids into wrangler.jsonc, run
  npm run db:export && npm run db:migrate:remote && npx wrangler deploy
(On a brand-new database the export has nothing to save. Run it anyway:
every remote migration is preceded by an export. See migrations/README.md.)
The daily cron wakes the Arcadia scheduler; opening the Directory for the
first time also starts the roster sync.

First run: sign in at / (it lands on /agency/directory) as shane@s-fx.com or
alex@s-fx.com — the two seeded superadmins — then set roles and model
routing at /approval/admin.
EOF
