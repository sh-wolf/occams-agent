# occams-agent

A minimal bridge that lets you talk to Claude (or Codex) from WhatsApp or Slack, with multiple agent personas selectable per chat, scoped filesystem access to a shared knowledge vault, and a built-in cron scheduler. One Node process, one phone number, many agents.

Named after Occam's razor — entities are not multiplied without necessity. The whole bridge is ~1500 lines of plain Node and the agent "framework" is a folder of markdown files.

## What it does

You send `hey, what's the deal with X?` to your phone number. The bridge:

1. Recognizes the sender from `users.json`.
2. Looks up which agent persona this chat is bound to (or uses the default).
3. Spawns `claude --print` (or `codex exec`) as a subprocess with that persona's role doc, scoped filesystem access, and a stable session UUID.
4. Streams the agent's tool calls back to your chat as a live trace.
5. Pipes the final answer back to you via WhatsApp/Slack.

Switch agents mid-conversation with `/<slug>`. Schedule recurring work with `/cron 0 9 * * 1 give me a weekly digest`. The agent itself can also write cron jobs as JSON files; the scheduler picks them up live.

## Architecture in one paragraph

A single Node process boots WhatsApp (Baileys, pairs your real phone account via QR) and/or Slack (Bolt Socket Mode, no public webhook needed). Inbound messages are matched against `users.json` for access control, dispatched through a slash-command router, and forwarded to a subprocess spawner that runs `claude` or `codex` with a scoped `--add-dir` set derived from the bound agent's frontmatter. Replies stream back over the same channel. A file-based scheduler (`node-cron` + `fs.watch`) reads JSON job files the agents write to their own scratch dirs.

The whole "agent framework" is a folder convention: each `<slug>-agent/` dir contains an `agent-role.md` (system prompt + frontmatter) and a `skills/` folder of markdown procedures. The runtime never compiles or imports them — they're handed to the CLI as plain text. Add a new agent by `mkdir new-agent/ && $EDITOR new-agent/agent-role.md`; it's live on the next message.

```
your phone  ──► WhatsApp servers  ──►  ┌──────────────────────────────────┐
                                       │  Baileys ─┐                      │
your laptop ──► Slack servers     ──►  │  Bolt ────┴► router ─► subprocess │ ──► claude / codex
                                       │              ▲          (per msg) │
                                       │              │                    │
                                       │   scheduler  │   vault/  ◄────────┘
                                       │   (node-cron + fs.watch)          │
                                       └──────────────────────────────────┘
```

No inbound ports. No public webhook. No queue. No database. Just files, a Node process, and a CLI subprocess per turn.

## What's in the box

```
occams-agent/
  README.md                  this file
  LICENSE                    MIT
  .env.example               runtime config template
  users.example.json         identity / access template
  permissions.example.json   per-profile authority (areas, sandbox, env, ...)
  .gitignore

  admin-agent/               example: superuser profile that can edit anything
  notes-agent/               example: a wiki-maintaining agent
  echo-agent/                example: minimal stub to copy from

  vault/
    CLAUDE.md                the wiki schema — read every turn
    AGENTS.md → CLAUDE.md    same file, named for codex
    areas/                   topical mini-wikis (created on demand)
    users/                   per-profile scratch + cron job files

  occams-agent-runtime/     the runtime (Node)
    src/                     ~1500 lines: channels, router, agent spawn, scheduler
    deploy/                  systemd unit + install.sh
    docs/                    HOW_IT_WORKS.md + GETTING_STARTED.md
    package.json
```

## Getting started

End-to-end runbook for a fresh Debian VPS lives at [occams-agent-runtime/docs/GETTING_STARTED.md](occams-agent-runtime/docs/GETTING_STARTED.md). The conceptual model is in [HOW_IT_WORKS.md](occams-agent-runtime/docs/HOW_IT_WORKS.md).

The short version:

1. Clone this repo onto a Linux box (Debian 13 tested; anything with Node 20+ should work).
2. `sudo bash occams-agent-runtime/deploy/install.sh` — installs Node, creates a service user, installs the systemd unit.
3. As that user: `cd occams-agent && cd occams-agent-runtime && npm install`.
4. Install the `claude` CLI: `curl -fsSL https://claude.ai/install.sh | bash`, then `claude /login`.
5. Copy `.env.example` → `.env`, `users.example.json` → `users.json`, `permissions.example.json` → `permissions.json`, edit each.
6. `npm start` once to pair WhatsApp via QR scan.
7. Back to root: `systemctl enable --now occams-agent`.

Now message the paired number from any device. Your first message picks up the `admin` profile by default. Send `/profiles` to see what else exists, `/echo hi` to talk to the minimal demo agent, `/help` for everything.

## Customizing

The point of the `admin` profile is that you shouldn't have to do this by hand. Admin has `superuser: true` — its `--add-dir` is the entire repo root, so it can read and write every profile dir, every skill file, the runtime, the systemd unit, `.env`, `users.json`, all of it. With the sudoers rule from `GETTING_STARTED.md` in place, it can also restart itself to apply runtime changes. The intended workflow is: tell admin what you want over chat, admin does it, admin tells you what shipped.

Examples that should work in a single message to `/admin`:

- *"Spawn a `support-ops` agent. Give it access to the `support` and `infra` areas. Skills: handling an outage runbook."*
- *"Add a skill to the notes agent that knows how to ingest a Fireflies transcript URL."*
- *"Wire the runtime to also accept Discord messages. Plan it first, then do it."*
- *"Add a teammate to `users.json` — phone +1-555-9876-543, allowed profiles: notes, echo."*

Admin's own role doc and `skills/` (under [admin-agent/](admin-agent/)) describe its self-imposed safety rails — proposes risky changes before acting, refuses to grant `superuser: true` to other profiles, never pastes `.env`/`users.json` contents back into chat. Read them once so you know what it will and won't do unprompted.

**Who gets to use admin.** Restrict it. In `users.json`, only list the `admin` profile under operators you'd trust with `sudo` on the box. Everyone else gets a narrower allowlist like `["notes", "echo"]` and physically cannot bind a chat to `/admin`.

**If you'd rather do it by hand:** the manual primitives still work. To add a new agent, copy `echo-agent/` to `<your-slug>-agent/` and edit its `agent-role.md`. To add a skill, drop a markdown file into its `skills/` folder. To change the runtime, edit files under `occams-agent-runtime/src/` and `sudo systemctl restart occams-agent`.

## Persisting the vault

The vault is the irreplaceable part — it accumulates everything the agents have ingested and synthesized. The simplest way to back it up is to make this repo private on GitHub and run a nightly git push from the VM. [deploy/cron-backup.sh](deploy/cron-backup.sh) is the script; one line in the service user's crontab installs it:

```
30 3 * * *  /home/occams/occams-agent/deploy/cron-backup.sh >> /home/occams/cron-backup.log 2>&1
```

This is also how you read the vault from your laptop: clone the private repo, `git pull` periodically, point Obsidian (or any markdown editor) at the `vault/` folder. The cron runs `git add -A && git commit --allow-empty && git push` once a day, so every morning your local clone catches up with whatever the agents wrote overnight. Setup details — including the GitHub deploy key — are in [GETTING_STARTED.md](occams-agent-runtime/docs/GETTING_STARTED.md#backups).

For live two-way sync (rare — agents are the primary writer, so a daily pull is usually enough), Syncthing on top of the same `vault/` folder also works.

## Design choices

- **Subprocess per message, not in-process API calls.** Lets Claude/Codex use their own session storage, MCP servers, permissions, and skills unchanged. We get session continuity for free via `--session-id` / `codex resume`.
- **File-based jobs, not a DB.** Portable, debuggable with `ls`, and the agent already has Write — so it can self-schedule without a special API.
- **Karpathy LLM-Wiki pattern.** Ad-hoc RAG works for one-off questions; a persistent, agent-maintained wiki compounds across months. See [Karpathy's gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
- **Slack Socket Mode + WhatsApp via Baileys.** Avoids needing a public IP, domain, TLS, Twilio fees, or Business API hoops. Pairs with the real WhatsApp account you already have on your phone.
- **Markdown role docs, not code.** Agent behavior is text the agent itself can read and edit. Lower the friction between "I should remember this" and "it's part of how I work."

## Security model

Three layers, defense-in-depth, configurable per profile:

1. **Bubblewrap filesystem sandbox.** Strict-sandbox profiles (everything except `admin` by default) run inside a fresh kernel mount namespace. Only the dirs listed in [permissions.json](permissions.example.json) for that profile are bind-mounted in; the rest of the filesystem literally doesn't exist in the namespace. `cat /etc/passwd` works (it's in `/etc`), `cat ~/.ssh/id_ed25519` fails with "no such file or directory" — not a permission error, the path isn't there. Sub-spawned processes (Bash, MCP servers, the Agent tool) inherit the same view, so there's no "break out by going one level deeper." Network stays unrestricted so API calls work.

2. **Env filtering.** Subprocesses don't inherit `process.env` wholesale. Each spawn gets a minimal allowlist (`PATH`, `HOME`, etc.) plus exactly the variables the profile's `env:` map in `permissions.json` declares. The naming convention `<SLUG>_<KEY>` in `.env` (e.g. `NOTES_OPENAI_API_KEY`) keeps host-side keys partitioned; the agent sees them under the unprefixed name. A misconfigured agent that tries `printenv` then `cat .env` gets nothing twice — the var isn't in its env *and* the file isn't in its namespace.

3. **Authority out of agent-writable scope.** Each profile has read/write access to its own `<slug>-agent/` dir, so it could in principle edit its own `agent-role.md`. To prevent self-escalation, the runtime treats role-doc frontmatter as **descriptive only** and reads all authority (areas, superuser, sandbox, env, billing) from [permissions.json](permissions.example.json) at the repo root. That file is gitignored, lives outside any restricted profile's namespace, and can only be edited by `admin` or the human operator. An agent trying to grant itself `superuser: true` by editing its own frontmatter will see no behavior change.

The `admin` profile is exempt from all three by design (`sandbox: full`, full repo as `--add-dir`, full env). It's meant to be limited by `users.json` — only list `admin` in the `profiles` allowlist for operators you'd trust with `sudo` on the box. Everyone else gets a narrower allowlist and physically cannot bind a chat to `/admin`.

### Verifying the sandbox

After install, smoke-test the sandbox by binding a chat to a strict profile (e.g. `/notes`) and asking it to run:

```
bash -c "cat /etc/passwd; echo ---; ls /home; echo ---; cat ../../../.env 2>&1"
```

Expected: `/etc/passwd` reads fine (system file), `/home` is empty or shows only the agent's tmpfs, `../../../.env` errors with "No such file or directory". If you see contents of `.env` come back, the sandbox isn't active — check `journalctl -u occams-agent` for the `[sandbox] strict-sandbox profiles will run UNSANDBOXED` warning at startup.

## Known limitations

- **Localhost network is reachable.** Bubblewrap leaves the host's network namespace intact so the agent can call out to APIs. A restricted agent could still `curl 127.0.0.1:<port>` and reach anything bound to localhost on the VM. Close this by adding `--unshare-net` to the bwrap args + proxying outbound through a single allowed port, or by not binding sensitive services to localhost without auth.
- **macOS dev runs unsandboxed.** Bubblewrap is Linux-only. On macOS the runtime logs a one-time warning and runs strict profiles without the namespace. Fine for local development; deploy to Linux for the real isolation.
- **One service OS user.** All agents (sandboxed or not) run as the same OS user. The bwrap namespace separates them at the filesystem layer; for per-agent UIDs you'd need separate service users + sudoers rules + chown'd vault dirs. Not done by default — the namespace is usually enough.
- **Costs scale per-token.** Every message spawns a real CLI call. Long agent loops add up; the live trace helps you notice runaway tool use.

## Contributing / forking

This is a personal pattern I extracted from a working internal deployment. I'll merge bug fixes and small improvements that don't add complexity. Major features — auth, web UI, multi-tenant, web hosting — belong in a fork.

## License

MIT. See [LICENSE](LICENSE).
