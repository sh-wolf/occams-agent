#!/usr/bin/env bash
# Daily git snapshot of the whole orchestration repo.
# Wire into the service user's crontab on the VM, e.g.:
#   30 3 * * *  /home/occams/occams-agent/deploy/cron-backup.sh >> /home/occams/cron-backup.log 2>&1

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

git add -A
# --allow-empty so the log shows the cron ran even on quiet days
git commit -m "auto: daily snapshot $(date -u +%Y-%m-%dT%H:%MZ)" --allow-empty
git push
