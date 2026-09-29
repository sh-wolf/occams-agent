# Updating the VM after a push

Standard cycle: edit on your laptop, commit + push, pull + restart on the VM.

## Laptop side

```bash
git add -A
git commit -m "..."
git push
```

## VM side

The repo is owned by the `occams` system user (no sudo). The systemd service is managed by your sudo user. So updating is a two-user dance.

**One-shot (recommended):**

```bash
ssh <sudo-user>@<vm-host>
sudo -u occams bash -c 'cd /home/occams/occams-agent && git pull' \
  && sudo systemctl restart occams-agent \
  && sudo journalctl -u occams-agent -f
```

That runs `git pull` as occams (no interactive shell needed), restarts the systemd service, and tails the logs. Ctrl-C exits the tail.

**Step-by-step (when you need to do something extra mid-flow):**

```bash
ssh <sudo-user>@<vm-host>

# Pull as the repo owner
sudo su - occams
cd /home/occams/occams-agent
git pull
# If package.json deps changed:
#   cd occams-agent-runtime && npm install && cd ..
exit

# Back to your sudo user — restart the service
sudo systemctl restart occams-agent
sudo journalctl -u occams-agent -f
```

## When you don't need to restart

These are read fresh on every agent turn (or watched at runtime):

- `<slug>-agent/agent-role.md` — system prompt, re-read every message.
- `<slug>-agent/skills/*.md` — read on demand by the agent.
- `vault/CLAUDE.md` — read every turn.
- `vault/areas/**` — content the agents read.
- `vault/users/<slug>/jobs/*.json` — picked up by `fs.watch` within ~300ms.

So a `git pull` that only touches markdown or vault content takes effect immediately. No restart needed.

## When you do need to restart

- Any change under `occams-agent-runtime/src/` (JS code).
- `.env` (loaded once at startup).
- `users.json` (loaded once at startup).
- `permissions.json` (loaded once at startup — this is the per-profile authority config: areas, sandbox, env mappings, billing).
- The systemd unit itself (`occams-agent.service`) — also needs `sudo systemctl daemon-reload` first.

## One-time sandbox setup

Strict-sandbox profiles need bubblewrap. Do this once on the VM:

```bash
sudo apt install -y bubblewrap     # strict-mode agents need this for the sandbox
sudo systemctl restart occams-agent
sudo journalctl -u occams-agent -n 80
```

Things to look for in the startup banner:
- `profiles found: /admin /notes /echo` — every profile with a `permissions.json` entry loaded
- No `[permissions]` warnings about missing or invalid entries
- No `[sandbox] strict-sandbox profiles will run UNSANDBOXED` warning (means bwrap was found)

After it's running cleanly, verify the sandbox engages by sending a strict-sandbox profile a probe message from chat:

```
/echo run: bash -c "cat /etc/passwd | head -2; echo ---; cat ../../../.env 2>&1"
```

You should see `/etc/passwd` come back (system file is bound read-only) but `.env` should fail with "No such file or directory" — not its contents. If you see `.env` contents, the sandbox isn't engaging.

## Service control cheatsheet

```bash
sudo systemctl status   occams-agent     # current state, recent logs
sudo systemctl restart  occams-agent     # apply config / code changes
sudo systemctl stop     occams-agent     # take it offline
sudo systemctl start    occams-agent     # bring it back
sudo systemctl disable  occams-agent     # don't start on boot
sudo systemctl enable   occams-agent     # do start on boot

sudo journalctl -u occams-agent -f       # live tail
sudo journalctl -u occams-agent -n 200   # last 200 lines
sudo journalctl -u occams-agent --since "10 min ago"
```

## Editing systemd config

If you change the unit file (`occams-agent-runtime/deploy/occams-agent.service`), the live unit at `/etc/systemd/system/occams-agent.service` doesn't auto-update — install.sh copied it once. To apply changes:

```bash
sudo cp /home/occams/occams-agent/occams-agent-runtime/deploy/occams-agent.service \
        /etc/systemd/system/occams-agent.service
sudo sed -i "s|@USER@|occams|g; s|@APP_DIR@|/home/occams/occams-agent|g" \
        /etc/systemd/system/occams-agent.service
sudo systemctl daemon-reload
sudo systemctl restart occams-agent
```

For PATH or environment tweaks, use a drop-in override instead (cleaner — survives unit-file re-syncs):

```bash
sudo systemctl edit occams-agent
# Add a [Service] block with Environment=... lines, save.
sudo systemctl daemon-reload
sudo systemctl restart occams-agent
```

Overrides live at `/etc/systemd/system/occams-agent.service.d/override.conf`.

## Letting the admin agent self-restart

The admin agent (with `superuser: true`) has read/write access to the whole repo, including runtime code. For code changes to take effect it needs to be able to restart the service. Grant `occams` passwordless sudo for that **one specific command** — no broader sudo, no other root commands.

**As your sudo user on the VM:**

```bash
sudo tee /etc/sudoers.d/occams > /dev/null <<'EOF'
occams ALL=(root) NOPASSWD: /bin/systemctl restart occams-agent
EOF
sudo chmod 0440 /etc/sudoers.d/occams
sudo visudo -c        # sanity check — should say "/etc/sudoers.d/occams: parsed OK"
```

After this, the admin agent can run `sudo systemctl restart occams-agent` from its Bash tool with no password prompt, and no other sudo command will work. `visudo -c` verifies the file is syntactically valid before it's active — if it errors, **don't proceed**, fix the file. A broken sudoers file can lock everyone out of sudo.

To revoke later: `sudo rm /etc/sudoers.d/occams`.

## Diagnostics

**Service running but agent not responding in Slack:**

```bash
sudo journalctl -u occams-agent -n 50    # check for errors
sudo systemctl status occams-agent       # check uptime, restarts
```

Look for `[slack] connected (socket mode)` near startup. If it's missing or you see repeated reconnect attempts, check `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` in `.env`.

**Claude subprocess errors (`'claude' not found`)**: PATH override is wrong or missing. Verify:

```bash
sudo systemctl show occams-agent | grep -i path
```

Should print `Environment=PATH=/home/occams/.local/bin:...`. If missing, recreate the drop-in:

```bash
sudo mkdir -p /etc/systemd/system/occams-agent.service.d
sudo tee /etc/systemd/system/occams-agent.service.d/override.conf > /dev/null <<'EOF'
[Service]
Environment="PATH=/home/occams/.local/bin:/usr/local/bin:/usr/bin:/bin"
EOF
sudo systemctl daemon-reload
sudo systemctl restart occams-agent
```

**Session lock errors (`Session ID is already in use`)**: claude has a stuck session lock on disk. Reset:

```bash
sudo -u occams rm /home/occams/occams-agent/occams-agent-runtime/state.json
sudo systemctl restart occams-agent
```

Next message in each chat creates a fresh session UUID.
