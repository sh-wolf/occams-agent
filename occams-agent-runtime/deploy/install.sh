#!/usr/bin/env bash
# occams-agent — Debian 13 (Trixie) installer.
#
# Run AS ROOT from any clone of the repo:
#   sudo bash occams-agent-runtime/deploy/install.sh
#
# This script does system-level setup only. Per-user steps (claude/codex login,
# npm install, configuration, WhatsApp QR pair) happen afterward as the service user.
# The repo itself is cloned/moved into place by you, not by this script.

set -euo pipefail

USER_NAME="${OCCAMS_USER:-occams}"
APP_DIR="${APP_DIR:-/home/${USER_NAME}/occams-agent}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "Run as root: sudo bash $0" >&2
    exit 1
  fi
}

install_apt_base() {
  apt update
  apt install -y curl git build-essential ca-certificates gnupg bubblewrap
  # bubblewrap is what the bridge uses to sandbox strict-mode agent
  # subprocesses (filesystem namespacing). Without it, strict profiles run
  # unsandboxed and the runtime logs a loud warning at every boot.
}

install_node() {
  if command -v node >/dev/null && node -v | grep -qE 'v(2[0-9]|[3-9][0-9])'; then
    echo "[node] already installed: $(node -v)"
    return
  fi
  echo "[node] installing Node.js 20 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
}

ensure_user() {
  if id -u "$USER_NAME" >/dev/null 2>&1; then
    echo "[user] $USER_NAME exists"
  else
    echo "[user] creating $USER_NAME"
    adduser --disabled-password --gecos "" "$USER_NAME"
  fi
  loginctl enable-linger "$USER_NAME"
}

install_systemd_unit() {
  local src="${REPO_ROOT}/occams-agent-runtime/deploy/occams-agent.service"
  local dst=/etc/systemd/system/occams-agent.service
  [[ -f "$src" ]] || { echo "missing $src" >&2; exit 1; }
  install -m 0644 "$src" "$dst"
  sed -i "s|@USER@|${USER_NAME}|g; s|@APP_DIR@|${APP_DIR}|g" "$dst"
  systemctl daemon-reload
  echo "[systemd] installed unit at $dst (not started yet)"
}

print_next_steps() {
  cat <<EOF

============================================================
System setup complete. Manual steps remaining (as $USER_NAME):

  1. Switch user:
       su - $USER_NAME

  2. Clone the repo into place:
       git clone https://github.com/<you>/occams-agent.git $APP_DIR
       cd $APP_DIR

  3. Install dependencies (Node deps live in the runtime subdir):
       cd occams-agent-runtime
       npm install
       cd ..

  4. Install the agent CLIs:
       curl -fsSL https://claude.ai/install.sh | bash    # claude
       npm install -g @openai/codex                      # codex (optional)
       export PATH="\$HOME/.local/bin:\$PATH"             # add to ~/.bashrc

  5. Authenticate (interactive, one-time each):
       claude /login
       codex login    # only if you're using codex

  6. Configure (files at the REPO ROOT, not inside occams-agent-runtime/):
       cp .env.example .env                            && \$EDITOR .env
       cp users.example.json users.json                && \$EDITOR users.json
       cp permissions.example.json permissions.json    && \$EDITOR permissions.json

  7. First run — scan WhatsApp QR from your phone:
       cd occams-agent-runtime
       npm start
       (scan QR, wait for "[whatsapp] connected", then Ctrl-C)

  8. (Optional) Wire up a daily git backup cron for vault snapshots:
       chmod +x deploy/cron-backup.sh
       crontab -e   # add the line:
       30 3 * * *  $APP_DIR/deploy/cron-backup.sh >> $APP_DIR/cron-backup.log 2>&1
     For 'git push' to work non-interactively, set up an SSH key for github
     (ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub)
     and add it as a deploy key (with write access) to the GitHub repo.

  9. Back to root, start the service:
       exit
       systemctl enable --now occams-agent
       journalctl -u occams-agent -f

============================================================
EOF
}

main() {
  require_root
  install_apt_base
  install_node
  ensure_user
  install_systemd_unit
  print_next_steps
}

main "$@"
