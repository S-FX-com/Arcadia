#!/usr/bin/env bash
# Export the remote arcadia-ops D1 database and keep a copy in R2.
#
# Run this before applying any destructive migration (DROP, table rebuild).
# See migrations/README.md. Run: npm run db:export
#
# Writes backups/arcadia-ops-<UTC timestamp>.sql locally (gitignored) and
# uploads the same file to the arcadia-artifacts R2 bucket (the ARTIFACTS
# binding in wrangler.jsonc) at backups/arcadia-ops-<UTC timestamp>.sql.
#
# Needs wrangler to be logged in, or CLOUDFLARE_API_TOKEN set, with D1 and R2
# access to the S-FX account.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="arcadia-ops"
BUCKET="arcadia-artifacts"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${DB_NAME}-${STAMP}.sql"
LOCAL_PATH="backups/${FILE}"
R2_KEY="backups/${FILE}"

mkdir -p backups

echo "== Exporting remote D1 ${DB_NAME} to ${LOCAL_PATH}"
# wrangler asks for confirmation first: the database cannot serve queries
# while the export runs. Answering "no" exits 0 without writing a file, so
# the file check below is what catches it.
npx wrangler d1 export "${DB_NAME}" --remote --output "${LOCAL_PATH}"

if [ ! -s "${LOCAL_PATH}" ]; then
  echo "!! Export did not produce ${LOCAL_PATH} (or it is empty). Nothing uploaded." >&2
  exit 1
fi

echo "== Uploading to R2 ${BUCKET}/${R2_KEY}"
# --remote is required: without it, wrangler writes to local storage under
# .wrangler/ and the real bucket never sees the file.
npx wrangler r2 object put "${BUCKET}/${R2_KEY}" \
  --file "${LOCAL_PATH}" \
  --content-type "application/sql" \
  --remote

echo
echo "Export complete."
echo "  Local file: ${LOCAL_PATH}"
echo "  R2 object:  ${BUCKET}/${R2_KEY}"
