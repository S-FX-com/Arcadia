#!/usr/bin/env bash
# Arcadia v4 provisioning (§3, §9). Everything here is repeatable from a clean
# clone; the six human-only steps in CLAUDE.md §9 are NOT automated and are
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
for idx in arcadia-doctrine-canonical arcadia-doctrine-staging arcadia-episodic arcadia-published-log; do
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
 1. WordPress Application Password for user `sfxdotcom` (WP admin UI)
    -> wrangler secret put WP_APP_PASSWORD
 2. Anthropic API key (console)
    -> wrangler secret put ANTHROPIC_API_KEY
 3. AI Gateway named `arcadia` in the Cloudflare dashboard
    -> set CF_ACCOUNT_ID + AI_GATEWAY_ID vars in wrangler.jsonc
    -> (if authenticated gateway) wrangler secret put AI_GATEWAY_TOKEN
 4. Cloudflare API token for wrangler (you presumably have this already)
 5. Cloudflare Access policy for the approval dashboard route
    -> set ACCESS_TEAM_DOMAIN + ACCESS_AUD vars in wrangler.jsonc
 6. Read the SureRank meta keys off a live tutorial post — DO NOT GUESS:
    curl "https://www.s-fx.com/wp-json/wp/v2/tutorials/<id>?_fields=meta"
    -> set SURERANK_META_KEYS='{"title":"<real key>","description":"<real key>"}'

Then: paste the D1/KV ids into wrangler.jsonc, run
  npm run db:apply:remote && npx wrangler deploy
and POST /init (or wait for the daily bootstrap cron) to wake the agents.
EOF
