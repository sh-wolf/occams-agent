#!/usr/bin/env bash
# Append or replace a single KEY=value line in the repo-root .env file.
# Reads the value from stdin with echo off, so it never appears in `ps`,
# shell history, or chat. Idempotent: an existing line for KEY is replaced.
#
# Usage (as the service user, or as root with sudo):
#   bash deploy/set-env-var.sh KEY_NAME
#   → paste the value when prompted (input hidden), press Enter.
#
# Then restart the bridge so the new value is loaded:
#   sudo systemctl restart occams-agent

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 ENV_VAR_NAME" >&2
  exit 1
fi

NAME="$1"
if ! printf '%s' "$NAME" | grep -qE '^[A-Z_][A-Z0-9_]*$'; then
  echo "Invalid env var name: $NAME. Use uppercase letters, digits, and underscores only." >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE not found." >&2
  exit 1
fi

printf 'Paste value for %s (input hidden), then press Enter: ' "$NAME"
read -rs VALUE
echo
if [ -z "$VALUE" ]; then
  echo "No value entered. Aborting." >&2
  exit 1
fi

# Strip any existing line for this key, then append the new one.
# Use a temp file + mv so ownership/permissions of .env are preserved.
TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
grep -v "^${NAME}=" "$ENV_FILE" > "$TMP" || true
printf '%s=%s\n' "$NAME" "$VALUE" >> "$TMP"
chmod --reference="$ENV_FILE" "$TMP" 2>/dev/null || chmod 600 "$TMP"
chown --reference="$ENV_FILE" "$TMP" 2>/dev/null || true
mv "$TMP" "$ENV_FILE"

echo "$NAME written to $ENV_FILE."
echo "Apply with: sudo systemctl restart occams-agent"
