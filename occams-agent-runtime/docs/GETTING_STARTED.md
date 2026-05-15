# Getting started

End-to-end deployment runbook. Targets a fresh Debian 13 VPS, but any Linux box with Node 20+ and outbound internet works.

For the conceptual model, read [HOW_IT_WORKS.md](HOW_IT_WORKS.md) first.

## Prerequisites

On your laptop:
- `git`, `gh` (or web access to GitHub)

On the VM:
- Debian 13 (Trixie) or compatible
- Root or sudo access
- Outbound internet (the bridge needs no inbound)

Accounts:
- A Claude.ai subscription (for `claude` CLI auth) **or** an `ANTHROPIC_API_KEY`.
- Optional: a ChatGPT/OpenAI account for `codex` CLI auth, **or** an `OPENAI_API_KEY`.
- Your real WhatsApp number on a phone (to pair via QR).
- Optional: a Slack workspace where you can create an app.

## Phase 1 — Push the code to GitHub (laptop)

```bash
cd /path/to/occams-agent

git init && git add -A && git commit -m "Initial commit"

# private repo via gh:
gh repo create occams-agent --private --source=. --remote=origin --push

# or manually: create empty private repo on github.com, then:
git remote add origin git@github.com:<you>/occams-agent.git
git push -u origin main
```

## Phase 2 — Bootstrap the VM (SSH as root)

```bash
ssh root@<vm-host>
apt update && apt install -y git

# pull just to get the install script
git clone https://github.com/<you>/occams-agent.git /tmp/oa

# run system installer
bash /tmp/oa/occams-agent-runtime/deploy/install.sh
```

The script:
- Installs Node 20 and build deps.
- Creates an `occams` service user (with `loginctl enable-linger`).
- Installs the `occams-agent.service` systemd unit (substituting user + path), **but doesn't start it yet**.
- Prints the per-user steps to do next.

The script is idempotent — safe to re-run.

## Phase 3 — Set up the app (SSH as `occams`)

```bash
# from the root shell:
su - occams

# clone the real repo into the canonical location
git clone https://github.com/<you>/occams-agent.git ~/occams-agent
cd ~/occams-agent/occams-agent-runtime
npm install
cd ..
```

### Install the agent CLIs

```bash
# Claude Code — native installer puts it in ~/.local/bin/claude
curl -fsSL https://claude.ai/install.sh | bash

# Codex (optional)
npm install -g @openai/codex

# add ~/.local/bin to PATH (claude goes there)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# sanity check
which claude && claude --version
```

### Authenticate (subscription login)

Both flows print a URL. Open it in your laptop's browser, log in, paste the callback code back into the SSH session.

```bash
claude setup-token       # long-lived token, suitable for non-interactive runs
codex login              # only if you're using codex
```

Verify each works on its own:
```bash
echo "say hi" | claude -p
echo "say hi" | codex exec -
```

### Configure `.env`

```bash
cp .env.example .env
nano .env
```

Defaults are usable. Tweak as needed:
- `DEFAULT_AGENT=claude` or `codex`.
- `DEFAULT_TIMEZONE=America/New_York` controls scheduled jobs when a job omits `timezone`.
- `ENABLE_SLACK=true` only if you've set up a Slack app (see [Optional: Slack setup](#optional-slack-setup)).
- `CLAUDE_PERMISSION_MODE=bypassPermissions` — required for unattended runs.

### Configure `users.json`

```bash
cp users.example.json users.json
nano users.json
```

Minimum viable (just you, with access to every profile):

```json
{
  "users": [
    {
      "slug": "operator",
      "name": "You",
      "whatsapp": ["15551234567"],
      "slack": [],
      "profiles": ["*"]
    }
  ]
}
```

Notes:
- **WhatsApp numbers**: digits only, no `+`, international format. E.g. US `15551234567`, UK `447123456789`.
- **Slack IDs**: `U01ABC123` format. In Slack: click your profile → **⋮ More** → **Copy member ID**.
- **`profiles`**: `["*"]` to allow any profile. Otherwise a list of profile slugs (`["notes", "echo"]`).

**Restrict admin access**: only put the `admin` profile in your *own* `profiles` list (or `["*"]`). For teammates, list specific profiles like `["notes", "echo"]` — they physically cannot bind a chat to `/admin` if it's not in their allowlist. The whole point of having admin is one entry point with full control; everyone else is sandboxed.

To add a teammate later, just append another entry and save — no restart needed.

### Configure `permissions.json`

```bash
cp permissions.example.json permissions.json
nano permissions.json
```

This is the authority config — what each profile can do (areas, sandbox mode, env keys, billing). The example file ships with sensible defaults:

- `admin` — `sandbox: full`, full vault access, no env extras.
- `notes` — `sandbox: strict`, all vault areas, no env extras.
- `echo` — `sandbox: strict`, no vault access.

Add an `env:` map if you have a profile that needs a specific API key from `.env`:

```json
"notes": {
  "areas": ["*"],
  "superuser": false,
  "sandbox": "strict",
  "billing": "subscription",
  "env": {
    "OPENAI_API_KEY": "NOTES_OPENAI_API_KEY"
  }
}
```

Then add `NOTES_OPENAI_API_KEY=sk-...` to `.env`. The notes agent will see it as `OPENAI_API_KEY` and nothing else from `.env` will reach it.

This file is gitignored. Changes take effect on the next bridge restart.

## Phase 4 — Pair WhatsApp, then start the service

### One-time QR scan (still as `occams`)

```bash
cd ~/occams-agent/occams-agent-runtime
npm start
```

You'll see Baileys logging and then a QR code drawn in ASCII. On your phone:
**WhatsApp → Settings → Linked Devices → Link a Device** → camera on the terminal QR.

Wait for `[whatsapp] connected` in the log, then **Ctrl-C**. The session is saved in `auth/` and survives restarts.

### Start the service (back as root)

```bash
exit   # back to root shell

systemctl enable --now occams-agent
journalctl -u occams-agent -f
```

Expected output:
```
occams-agent starting
  vault:     /home/occams/occams-agent/vault
  profiles:  /home/occams/occams-agent
  default profile: /admin
  profiles found:  /admin /echo /notes
  whatsapp:  on
  slack:     off
[whatsapp] connected
[scheduler] active jobs: 0
```

Leave the `journalctl` running — it's your live log.

### Smoke test

From your phone, send a WhatsApp message to **yourself**. (Your VM is now a linked WhatsApp device, so every message your account sends or receives also goes through the bridge — including messages you send to yourself.)

```
/whoami
```

Expected reply:
```
You (slug: operator)
This chat is bound to: /admin
Areas for this profile: *
Other profiles: /echo /notes
```

Now switch to the echo agent:
```
/echo hello
```

Then to the notes agent:
```
/notes save this fact: my favorite color is blue. file under personal area.
```

The agent should:
1. Create `vault/areas/personal/` with `raw/`, `wiki/`, `index.md`, `log.md`.
2. Write a raw source file.
3. Update or create a wiki page.
4. Reply "Filed under personal. Updated: ..."

Then ask:
```
what's my favorite color?
```

You should get a contextual answer pulling from the wiki you just created.

### Verify the sandbox is active

Bind a chat to a strict-sandbox profile and ask it to probe the filesystem:

```
/echo run: bash -c "cat /etc/passwd | head -3; echo ---; cat ../../../.env 2>&1; echo ---; ls /home"
```

Expected output back in chat:

```
root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
bin:x:2:2:bin:/bin:/bin/sh
---
bash: ../../../.env: No such file or directory
---
occams                  (tmpfs, mostly empty)
```

`/etc/passwd` reads fine (system file, intentionally bound read-only). `.env` is not in the namespace — even though the agent is running with a `cwd` inside the repo, the parent directories above its bound paths don't exist in its filesystem view. If you instead see `.env`'s actual contents come back, the sandbox isn't active — check the bridge log for the `[sandbox] strict-sandbox profiles will run UNSANDBOXED` warning, and confirm `bubblewrap` is installed (`which bwrap` should print a path).

## Optional: Slack setup

If you want Slack alongside (or instead of) WhatsApp:

1. Go to <https://api.slack.com/apps> → **Create New App** → "From scratch".
2. **Socket Mode**: enable. Generate an App-Level Token with `connections:write`. Copy the `xapp-...` token.
3. **OAuth & Permissions**: add Bot Token Scopes:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `users:read` (optional, for richer user data).
4. **Event Subscriptions**: enable. Subscribe to bot events: `app_mention`, `message.im`.
5. **Install App** to your workspace. Copy the Bot User OAuth Token (`xoxb-...`).
6. Find your Slack User ID: profile → **⋮ More** → **Copy member ID**.

On the VM as `occams`:
```bash
cd ~/occams-agent
nano .env
# set:
#   ENABLE_SLACK=true
#   SLACK_BOT_TOKEN=xoxb-...
#   SLACK_APP_TOKEN=xapp-...
#   SLACK_SIGNING_SECRET=<from app's Basic Information>

nano users.json
# add your Slack User ID to your user's "slack": [...] array

sudo systemctl restart occams-agent
sudo journalctl -u occams-agent -f
# expect: [slack] connected (socket mode)
```

DM the bot or @mention it in a channel. It replies in thread.

## Operations cheatsheet

```bash
# tail logs
sudo journalctl -u occams-agent -f

# restart after a config change
sudo systemctl restart occams-agent

# update code
sudo -u occams git -C /home/occams/occams-agent pull
sudo -u occams bash -c 'cd /home/occams/occams-agent/occams-agent-runtime && npm install'
sudo systemctl restart occams-agent

# WhatsApp re-pair (only if the session is dead)
sudo systemctl stop occams-agent
sudo -u occams rm -rf /home/occams/occams-agent/occams-agent-runtime/auth
sudo -u occams bash -c 'cd /home/occams/occams-agent/occams-agent-runtime && npm start'
# scan QR, Ctrl-C after "[whatsapp] connected"
sudo systemctl start occams-agent

# reset all sessions (forces fresh conversations)
sudo systemctl stop occams-agent
sudo -u occams rm /home/occams/occams-agent/occams-agent-runtime/state.json
sudo systemctl start occams-agent

# check vault disk usage as it grows
sudo du -sh /home/occams/occams-agent/vault
```

## Letting the admin agent self-restart

The `admin` profile (with `superuser: true`) has read/write access to the whole repo, including runtime code. For code changes to take effect it needs to be able to restart the service. Grant `occams` passwordless sudo for that **one specific command** — no broader sudo, no other root commands.

As your sudo user on the VM:

```bash
sudo tee /etc/sudoers.d/occams > /dev/null <<'EOF'
occams ALL=(root) NOPASSWD: /bin/systemctl restart occams-agent
EOF
sudo chmod 0440 /etc/sudoers.d/occams
sudo visudo -c        # sanity check — should say "/etc/sudoers.d/occams: parsed OK"
```

After this, the admin agent can run `sudo systemctl restart occams-agent` from its Bash tool with no password prompt, and no other sudo command will work. **If `visudo -c` errors, don't proceed** — fix the file. A broken sudoers can lock everyone out of sudo.

To revoke later: `sudo rm /etc/sudoers.d/occams`.

## Adding new users and profiles

### A new user

Edit `users.json` (no restart needed; reloaded on next message):

```json
{
  "slug": "bob",
  "name": "Bob",
  "whatsapp": ["15551111111"],
  "slack": ["U02XYZ789"],
  "profiles": ["notes", "echo"]
}
```

### A new profile (agent persona)

Either ask the `admin` agent to spawn one (it has a `skills/spawn-new-profile.md` for this), or do it by hand:

```bash
cp -r echo-agent my-new-agent
$EDITOR my-new-agent/agent-role.md
# update the `slug:` in frontmatter to `my-new`, set `areas:`, write the role
```

On the next message the bridge sees, `/my-new` is live.

## Troubleshooting

**`claude` or `codex` not found** — the service runs as `occams` with a minimal PATH. Either:
1. The default install drops a PATH override into the unit. Check `sudo systemctl show occams-agent | grep -i path`.
2. Or symlink into a system location: `sudo ln -s /home/occams/.local/bin/claude /usr/local/bin/claude`.

**WhatsApp says "you've been logged out"** — re-run the QR pair flow (see Operations cheatsheet).

**Agent replies are empty** — check `journalctl` for the actual `claude` / `codex` invocation. Likely auth expired; run `claude setup-token` or `codex login` as `occams` again.

**Cron jobs aren't firing** — check `journalctl` for `[scheduler] registered <path>` lines on startup. If absent, the JSON is invalid; the scheduler logs parse errors. Validate cron expressions with [crontab.guru](https://crontab.guru).

**Permissions issue on `auth/`** — happens if you ran `npm start` once as root. `sudo chown -R occams:occams /home/occams/occams-agent`.

**"Session ID is already in use"** — claude has a stuck session lock on disk. Stop the service, delete `state.json`, restart. Next message in each chat creates a fresh session UUID.

## Backups

The vault is the irreplaceable part. For a simple backup, set up the included daily git snapshot:

```bash
# on the VM as `occams`:
chmod +x ~/occams-agent/deploy/cron-backup.sh
crontab -e
# add:
30 3 * * *  /home/occams/occams-agent/deploy/cron-backup.sh >> /home/occams/cron-backup.log 2>&1
```

For 'git push' to work non-interactively, set up an SSH key (`ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519`) and add it as a deploy key (with write access) to the GitHub repo.

Other options: `restic` to S3, or just `tar` to an external disk weekly. Syncthing also works for live two-way sync to a laptop.
