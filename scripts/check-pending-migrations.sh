#!/usr/bin/env bash
# Refuse to deploy while the remote arcadia-ops D1 has pending migrations.
#
# Additive schema must be ahead of the code that queries it. When the v5.0
# client-workspace tables landed in code before they existed in production,
# the Worker threw on its first /clients request (Cloudflare error 1101).
#
# This script does NOT apply migrations. Destructive migrations (DROP, table
# rebuilds) are applied by Shane by hand after scripts/export-d1.sh (see
# migrations/README.md, which also covers DROPs and the deploy order).
#
# Used by the CI deploy job. Use it in any other deploy path too, for example
# a Workers Builds deploy command:
#   bash scripts/check-pending-migrations.sh && npx wrangler deploy
#
# Needs CLOUDFLARE_API_TOKEN (with D1 access) and CLOUDFLARE_ACCOUNT_ID.
#
# "No migrations to apply!" is the exact line wrangler 4.119 prints from
# `d1 migrations list` when nothing is pending. Anything else fails.
# `migrations list` runs CREATE TABLE IF NOT EXISTS d1_migrations on the
# remote DB before it reads it. That is its only write.
set -euo pipefail
cd "$(dirname "$0")/.."

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

if ! npx wrangler d1 migrations list arcadia-ops --remote 2>&1 | tee "$out"; then
  echo "::error::Could not list remote D1 migrations for arcadia-ops. Deploy stopped."
  exit 1
fi

if grep -q "Migrations to be applied:" "$out" || ! grep -q "No migrations to apply!" "$out"; then
  echo "::error::The remote arcadia-ops database has pending migrations, or wrangler did not confirm that none are pending (output above). Deploy stopped so code does not run ahead of schema."
  echo "::error::Shane applies them by hand: npm run db:export && npm run db:migrate:remote. Then re-run the deploy."
  exit 1
fi

echo "No pending D1 migrations. Deploy may proceed."
