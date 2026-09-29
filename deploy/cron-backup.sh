#!/usr/bin/env bash
# Daily git snapshot of the whole orchestration repo.
# Commits the VM's working tree, then reconciles with anything pushed from
# elsewhere (e.g. your laptop) before pushing. On a genuine same-line conflict
# it backs out cleanly and exits non-zero so the cron log shows it needs a human.
#
# Auth: reads GITHUB_BACKUP_TOKEN from the repo-root .env and feeds it to git
# through an inline credential helper. The token therefore never lives in
# .git/config (so `git remote -v` is clean) and never appears in a process's
# argv (so `ps` can't leak it). The origin URL is normalized to a token-free
# HTTPS form on every run, so an old token-in-URL remote heals automatically.
# If GITHUB_BACKUP_TOKEN is unset, the script falls back to whatever auth git
# already has (SSH deploy key, credential store) — set one or the other.
#
# Wire into the service user's crontab on the VM, e.g.:
#   30 3 * * *  /home/occams/occams-agent/deploy/cron-backup.sh >> /home/occams/cron-backup.log 2>&1

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

BRANCH="${BACKUP_BRANCH:-main}"
GIT_AUTH=()

# --- Auth: pull GITHUB_BACKUP_TOKEN out of .env (plain KEY=value lines). ---
# sed only strips the key prefix, so tokens with any character survive intact;
# the value is never echoed.
GITHUB_BACKUP_TOKEN="$(sed -n 's/^GITHUB_BACKUP_TOKEN=//p' .env 2>/dev/null | tail -n1)"
if [ -n "${GITHUB_BACKUP_TOKEN:-}" ]; then
  export GITHUB_BACKUP_TOKEN
  # Inline credential helper: git expands ${GITHUB_BACKUP_TOKEN} from the
  # environment when it runs the helper, so the literal string (not the value)
  # is what appears in this script's argv. Single-quoted on purpose.
  GIT_AUTH=(-c 'credential.helper=!f() { echo username=x-access-token; echo "password=${GITHUB_BACKUP_TOKEN}"; }; f')
  # Normalize the remote to a token-free HTTPS URL so git actually invokes the
  # helper above (an embedded user:pass@ in the URL would short-circuit it).
  ORIGIN="$(git remote get-url origin)"
  ORIGIN="$(printf '%s' "$ORIGIN" | sed -E 's#^https://[^@/]+@#https://#; s#^git@github\.com:#https://github.com/#')"
  git remote set-url origin "$ORIGIN"
fi
# Don't hang trying to prompt if the credential is bad — fail fast instead.
export GIT_TERMINAL_PROMPT=0

# Committer identity: git config if set, else a fixed bot identity so cron
# (which has no user-level gitconfig) never fails on "please tell me who you are".
COMMIT_NAME="$(git config user.name || echo 'occams-agent backup')"
COMMIT_EMAIL="$(git config user.email || echo 'occams-agent@localhost')"

# 1. Commit local changes first so the working tree is clean for the rebase.
#    --allow-empty so the log shows the cron ran even on quiet days.
git add -A
git -c "user.name=${COMMIT_NAME}" -c "user.email=${COMMIT_EMAIL}" \
  commit -m "auto: daily snapshot $(date -u +%Y-%m-%dT%H:%MZ)" --allow-empty

# 2. Pull in anything pushed elsewhere, replaying our snapshot on top.
#    Non-overlapping edits (incl. different lines of the same file) merge
#    automatically; only a literal same-line collision halts the rebase.
git "${GIT_AUTH[@]}" fetch origin
if ! git rebase "origin/${BRANCH}"; then
  # True conflict: back out to a clean state (snapshot commit preserved,
  # not pushed) and fail loud. Nothing is lost; retries next run until
  # a human reconciles.
  git rebase --abort
  echo "BACKUP FAILED $(date -u +%Y-%m-%dT%H:%MZ): rebase conflict with origin/${BRANCH}; manual reconcile needed" >&2
  exit 1
fi

# 3. Push the reconciled history.
git "${GIT_AUTH[@]}" push origin "${BRANCH}"
