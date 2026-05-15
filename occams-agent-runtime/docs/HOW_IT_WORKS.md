# How it works

occams-agent is a single Node process that sits between two messaging channels (WhatsApp, Slack) and two agent CLIs (`claude`, `codex`). It runs the agent as a subprocess per incoming message, gives it scoped filesystem access to a partitioned knowledge vault, and persists conversation continuity across messages.

## High-level shape

```
                                       VM (Debian)
                                       ┌──────────────────────────────────────────┐
your phone  ──► WhatsApp servers  ──►  │                                          │
                                       │   Baileys ─┐                             │
                                       │            ├──► router ──► agent ──► claude / codex CLI
                                       │   Bolt ────┘                  │                │
your laptop ──► Slack servers     ──►  │                               │                ▼
                                       │                               ▼          subprocess
                                       │            users.json    scheduler         (per message)
                                       │            state.json    (node-cron)        │
                                       │                               │              │
                                       │                               └──── vault/   │
                                       └──────────────────┬──────────────────────────┘
                                                          │
your laptop ──► markdown editor opens vault folder ◄──────┘   (via Syncthing, git pull, or NFS)
```

The bridge is **entirely outbound**. WhatsApp, Slack, Anthropic, and OpenAI are all spoken to from the VM. No inbound ports, DNS, or TLS are required.

## The two axes: users and profiles

Two things vary per message:

- **Who's sending**: matched from `users.json` by sender phone or Slack user ID. Yields a `user` record with a slug, a name, and an allowlist of profiles they can use.
- **Which agent persona**: each chat (Slack thread or WhatsApp conversation) is bound to a single `<slug>-agent/` profile. Bind with `/<slug>` once; subsequent messages stay with that profile until you switch.

The user record gates access; the profile defines the persona. A user can use many profiles; a profile can be talked to by many users.

## Components

### `src/index.js` — entry
Boots the channels (whichever are enabled in `.env`), waits for them to connect, then starts the scheduler. Each channel returns a small interface (notably `sendDM(target, text)`) the scheduler uses to deliver cron-job replies.

### `src/channels/whatsapp.js` — Baileys
Pairs your real WhatsApp account via QR code on first run. Auth lives in `auth/`. Inbound messages flow through `messages.upsert`, get matched against `users.json` by sender phone, and are forwarded to the router. Outbound chunked at 3.5KB to stay under WhatsApp's per-message limit. Re-connects automatically on disconnect. Voice notes are transcribed via Groq Whisper before being forwarded as text.

### `src/channels/slack.js` — Bolt Socket Mode
Outbound WebSocket to Slack, no public webhook needed. Listens for `app_mention` and DMs (`channel_type === 'im'`). Replies in thread with a live-edited message showing the agent's tool trace while it works, then replaces it with the final answer. `chatId = slack:<channel>:<thread_ts>` so each thread is an isolated conversation.

### `src/router.js` — slash commands & dispatch
Parses leading slash commands. The first slash on a message is checked against (a) profile slugs — `/admin`, `/notes`, `/<your-slug>` — and (b) runtime commands like `/help`, `/whoami`, `/profiles`, `/new`, `/forget`, `/jobs`, `/cron`, `/claude`, `/codex`, `/streaming`, `/stop`. A profile prefix binds the chat to that profile; subsequent messages stay there until you switch.

### `src/profiles.js` — profile discovery
Scans the repo root for `<slug>-agent/` directories with an `agent-role.md`. The role doc body is the system prompt. Its frontmatter is descriptive only:

```yaml
---
slug: notes
description: maintains the wiki — ingests sources, answers queries, lints
---
```

The **authority** that goes with each profile — which vault areas it sees, whether it's a superuser, what sandbox it runs in, what env vars get injected — lives in [permissions.json](../../permissions.example.json) at the repo root, not in the role doc. See `src/permissions.js`.

Profiles are re-read on every call to `listProfiles()` — adding a new profile dir is live, no restart. But a dir without a matching `permissions.json` entry will **not load**: authority cannot be self-asserted by writing your own frontmatter.

### `src/permissions.js` — authority source of truth
Loads `permissions.json` (or falls back to `permissions.example.json` with a loud warning). Each profile entry declares:

```json
{
  "areas": ["work", "personal"],
  "superuser": false,
  "sandbox": "strict",
  "billing": "subscription",
  "env": { "OPENAI_API_KEY": "NOTES_OPENAI_API_KEY" }
}
```

- `areas` — vault areas this profile can read/write (`["*"]` for all). Mapped to `--add-dir` flags on the CLI and bind-mounts in the bwrap namespace.
- `superuser` — `true` grants the entire repo root as `--add-dir` and disables the sandbox. Should be exactly one profile (admin).
- `sandbox` — `strict` (default for everyone except admin) wraps the subprocess in bubblewrap; `full` runs it directly. Required to be `full` if `superuser: true`.
- `billing` — `subscription` (Claude OAuth) or `api` (uses `ANTHROPIC_API_KEY` from `.env`).
- `env` — map of agent-facing var name → host-side var name in `process.env`. Only these (plus a tiny base allowlist of `PATH`, `HOME`, etc.) reach the subprocess. The agent sees them under the agent-facing name.

`permissions.json` is gitignored (per-deploy) and lives at the repo root. Restricted profiles physically cannot see it; only admin and the human can edit it.

### `src/users.js` — identity & access
Loads `users.json` at startup. Sender phone or Slack user ID → user record. Each user has a `slug` (used as a directory name in `vault/users/`), a `profiles` allowlist (or `["*"]` for admin), and optional `name`. A user trying to talk to a profile not in their allowlist gets a polite refusal.

### `src/agent.js` — CLI spawner
For each message:

1. Resolves the bound profile and its authority from `permissions.json`.
2. Resolves the profile's cwd: `vault/users/<profile-slug>/` (auto-created — keyed on the **profile** slug, not the user, so all conversations with `/notes` share the same scratch space).
3. Computes the `--add-dir` set: the profile's granted area dirs, plus the profile's own dir, plus (if `superuser`) the entire repo root.
4. **Builds the subprocess env from scratch** (`buildSubprocessEnv`): a base allowlist of OS-required vars (`PATH`, `HOME`, ...) + optional `ANTHROPIC_API_KEY` per `billing` + the explicit `env:` map from `permissions.json`. Nothing else from `process.env` reaches the subprocess.
5. **Optionally wraps in bubblewrap** (`wrapForSandbox`): if `sandbox: strict`, the spawn is prefixed with a `bwrap` invocation that creates a new mount namespace. The namespace contains read-only `/usr` + `/etc` for system binaries, a tmpfs `/home` with select dotdirs bound in for the CLI's own state (`~/.claude`, `~/.local/bin`, ...), and read-write bind mounts for exactly the `--add-dir` paths from step 3. Paths outside that set don't exist in the namespace. Network stays unrestricted via `--share-net`. If `bwrap` isn't installed (or we're on macOS), the runtime logs a one-time warning and runs unsandboxed.
6. Spawns the wrapped command:
   - **Claude:** `claude --print --output-format stream-json --session-id <uuid> --permission-mode bypassPermissions --append-system-prompt "<bridge context>" --add-dir <areas...>`
   - **Codex:** `codex exec --json -o <tmpfile> --skip-git-repo-check --sandbox workspace-write --add-dir <areas...> -c approval_policy=never -`
   (When sandboxed, this becomes `bwrap [...bind-mounts...] -- claude ...` / `bwrap [...] -- codex ...`.)
7. Pipes the user's message to stdin.
8. Streams normalized tool-use events back to the channel layer for live-trace rendering.
9. Captures the final reply.

Three layers say the same thing: `--add-dir` (Claude's own tool layer), bubblewrap (kernel namespace), env allowlist (`process.env` filtering). The agent can't reach outside its scope even if one layer is misconfigured.

**Session continuity** is per `(chatId, profile, cli)` triple:
- **Claude:** we generate a stable UUID per first call and pass it as `--session-id`; subsequent calls use `--resume <uuid>`. Switching profile mid-chat starts a fresh session for the new profile (keyed on `(chatId, profile)`); switching back recovers the old one.
- **Codex:** the first call captures `session_id` from the JSONL output. Subsequent calls use `codex exec resume <id>`.

State lives in `state.json` (gitignored).

The **bridge context** is a short system message ("You are the X agent. The human is Y. Accessible areas: ...") injected on every Claude call via `--append-system-prompt`, and prepended to the first message for Codex.

### `src/scheduler.js` — cron jobs
On startup, scans `vault/users/*/jobs/*.json` and registers each with `node-cron`. Also runs `fs.watch` on each scratch dir's `jobs/` subfolder (debounced 300ms), so if the agent writes a new job mid-conversation, it's registered within ~300ms without a restart.

When a job fires:
- Synthesizes a fake "message" using the job's `prompt` field.
- Calls `runAgent` with `chatId = cron:<profile-slug>:<job-id>` (a synthetic chat that gets its own session, separate from any interactive conversation).
- Delivers the response via `channels.<deliver_to>.sendDM(target, text)`, falling back to `vault/users/<slug>/jobs-output/<id>.md` if delivery fails or `deliver_to: "file"`.
- If `runOnce: true`, deletes the job file (which the watcher notices and unregisters).

### `src/jobs.js` — slash-command path
Helpers for `/cron` and `/jobs`. Reads/writes the same JSON job files the scheduler watches, so power users can bypass the agent for quick schedules.

### `src/state.js` — session storage
Single JSON file at `state.json` (gitignored). Keyed by `chatId`, each entry stores per-profile, per-CLI session IDs and the chat's profile binding. Survives bridge restarts so conversations resume seamlessly.

## Message flow (the full path)

```
1. user sends "what's the deal with X?" to the bridge's WhatsApp number
2. WhatsApp servers push to Baileys (long-poll WebSocket)
3. messages.upsert handler fires
4. senderPhone() → "15551234567"
5. findUserByWhatsapp("15551234567") → { slug: "operator", profiles: ["*"], ... }
6. router.handleMessage({ text, chatId: "whatsapp:...@s.whatsapp.net", channel, user })
7. parseMessage → { kind: "agent", message: "what's the deal with X?" }
8. resolveProfile → state.json has chatId bound to "/notes" — load notes-agent
9. userCanUseProfile(user, "notes") → true ("*" allowlist)
10. agent.runClaude:
    a. cwd=/vault/users/notes/, areaDirs=[vault/areas/work, vault/areas/personal]
    b. ensureClaudeSession(chatId, "notes") → UUID (created or fetched)
    c. spawn claude --print --session-id <uuid> --add-dir <areas> --append-system-prompt "..."
    d. pipe "what's the deal with X?" to stdin
    e. claude reads vault/CLAUDE.md (parent-walked discovery), reads vault/areas/*/wiki/, answers
11. stdout: "Last we filed under work, X was about... [[areas/work/wiki/topics/x]]."
12. router returns reply → channel sends chunked back to WhatsApp
```

If the next message switches profile (`/admin restart the service`), the same `chatId` resolves a fresh session for `admin`, with the admin profile's expanded `--add-dir` (the whole repo). Switching back to `/notes` recovers its original session.

## The vault: Karpathy's LLM Wiki pattern

The vault follows [the pattern described by Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — a persistent, LLM-maintained knowledge artifact rather than ad-hoc RAG retrieval.

```
vault/
  CLAUDE.md              — schema (Claude Code reads via parent-walk discovery)
  AGENTS.md              — symlink to CLAUDE.md (Codex's discovery name)
  areas/
    <area>/
      raw/               — immutable sources (clippings, transcripts, quotes)
      wiki/              — agent's synthesis: people/, topics/, projects/, answers/
      index.md           — content catalog for this area
      log.md             — chronological log of operations in this area
  users/
    <profile-slug>/      — per-profile scratch (cwd when this profile is bound)
      jobs/              — per-profile scheduled jobs (JSON, watched by scheduler)
      jobs-output/       — fallback delivery for cron replies
      checkpoints/       — per-day notes the agent writes itself
```

`CLAUDE.md` tells the agent the three operations (ingest, query, lint), the filename conventions, the cron-job schema, and the inter-agent flow. The agent decides which operation applies from message intent — there are no `/ingest` slash commands. The schema is the contract.

## Access control

Three reinforcing layers, configured per profile in `permissions.json`.

### Layer 1: tool-level scope (`--add-dir`)

Per message, the agent process gets:
- `cwd = vault/users/<profile-slug>/` — always trusted
- `--add-dir vault/areas/<area>` for each area the profile is granted
- `--add-dir <profile-dir>` so the profile can read its own role doc and skills
- `--add-dir <repo-root>` if `superuser: true`

Claude's Read/Edit/Write tools and Codex's sandbox refuse paths outside this set. So the `notes` profile (granted `work` + `personal`) cannot Read/Write `vault/areas/finance/` through the file tools. **This layer is soft** — the agent's *shell* could still `cat` arbitrary files. The next two layers close that gap.

### Layer 2: kernel mount namespace (bubblewrap)

For profiles with `sandbox: strict`, the subprocess runs inside a fresh mount namespace built by `bwrap`. The namespace contains:

- Read-only `/usr` + `/etc` (so system binaries + DNS + TLS certs work)
- A fresh `/tmp` tmpfs (no host-side temp file leakage)
- A tmpfs `/home/<service-user>` with select dotdirs bound in (`~/.claude`, `~/.local/bin`, ...) so the CLI's auth and binary are reachable
- Read-write bind mounts for exactly the `--add-dir` paths from Layer 1

Everything else doesn't exist in the namespace. `cat /etc/passwd` works (`/etc` is bound), `cat ~/.ssh/id_ed25519` fails with `No such file or directory` even from Bash, even from a child process the agent spawns (the namespace is inherited). Network stays unrestricted via `--share-net`.

`admin` runs with `sandbox: full` (no bwrap wrapper) because it needs to edit the runtime + repo files that live outside any other profile's scope. That's why admin should only be in operators' `users.json` allowlists.

### Layer 3: env allowlist

Subprocesses don't inherit `process.env` wholesale. The runtime builds a fresh env containing:

- A short list of OS-required vars (`PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`)
- `ANTHROPIC_API_KEY` if `billing: api`
- Each key in the profile's `env:` map from `permissions.json`, with values pulled from the host `process.env`

Nothing else reaches the subprocess — no other profile's API keys, no Slack/WhatsApp tokens (the bridge uses those directly), no `*_PRIVATE_KEY` you happened to have in your shell. Combined with Layer 2 (where `.env` itself isn't visible), a misbehaving agent gets nothing from `printenv` and nothing from `cat .env`.

### Authority is not self-asserted

A profile's `agent-role.md` is the system prompt — the agent has write access to it (it's inside the profile's `--add-dir` and bind set). Authority bits **don't live there**; they live in `permissions.json` at the repo root, which is outside every restricted profile's namespace. An agent rewriting `agent-role.md` frontmatter to add `areas: ["*"]` or `superuser: true` gets a system prompt change with no behavior change — the runtime ignores it.

### Adding / changing access

- **A teammate** → edit `users.json`. List which profiles they can bind to. Reloaded per message, no restart.
- **A profile's areas/env/sandbox** → edit `permissions.json`. Cached at boot; changes take effect on next bridge restart. (Future: hot reload via fs.watch.)
- **Spawning a new profile** → admin can do this conversationally — create the `<slug>-agent/` dir, write the role doc, add the slug to `permissions.json`. The first time the new slug appears in `permissions.json`, it's live on the next message.

## Scheduling (cron jobs)

A "job" is a JSON file under `vault/users/<profile-slug>/jobs/`:

```json
{
  "schedule": "0 9 * * 1",
  "agent_cli": "claude",
  "prompt": "Summarize last week's ingests in the work area. Highlight any open questions.",
  "deliver_to": "whatsapp:operator",
  "runOnce": false,
  "timezone": "America/Los_Angeles"
}
```

If `timezone` is omitted, the scheduler uses the runtime's configured default timezone (`DEFAULT_TIMEZONE`, default `America/New_York`).

Two ways to create jobs:
- **Via the agent** (preferred): "remind me every Monday at 9am". The agent writes the file via its Write tool.
- **Via slash command** (power-user): `/cron 0 9 * * 1 remind me on monday`.

The scheduler's `fs.watch` picks up new/modified/deleted files within ~300ms and updates `node-cron` registrations live. No bridge restart.

When a job fires:
- It runs in a **fresh session** (`chatId = cron:<profile-slug>:<job-id>`). The prompt must be self-contained — there's no chat history to reference.
- Reply DM'd back via the configured `deliver_to`.
- `runOnce: true` → job file is deleted after firing.

## Configuration files

| File | Purpose | Gitignored? |
|---|---|---|
| `.env` | Runtime config (channels enabled, agent defaults, permission modes) | yes |
| `users.json` | Identity + access (phone → slug → allowed profiles) | yes |
| `state.json` | Session IDs and profile bindings per chatId | yes |
| `auth/` | Baileys WhatsApp session (persisted across restarts) | yes |
| `vault/` | Knowledge base | tracked (so the schema + structure ship in the repo) |

Example templates: `.env.example`, `users.example.json`. The schema lives at `vault/CLAUDE.md` (versioned).

## Why these choices

- **Subprocess per message, not in-process API calls**: lets Claude/Codex use their own session storage, MCP, plugins, skills, and permission systems unchanged. We get session continuity for free via `--session-id` / `codex resume`.
- **File-based jobs, not a DB**: portable, debuggable with `ls`, agent-friendly (the agent already has Write).
- **Karpathy wiki pattern**: ad-hoc RAG works for one-off questions; this works for accumulating knowledge over months.
- **Socket Mode for Slack**: avoids needing a public IP, domain, or TLS. Critical for a personal/small-team deploy.
- **Baileys for WhatsApp**: bypasses Twilio fees and Business API hoops. Pairs with a real phone number you own.
- **Per-profile cwd + `--add-dir`**: lightweight access control without containerization. Enforced by the agents' own file tools.
- **Markdown role docs and skills, not code**: agent behavior is text the agent can read and edit. The framework is a folder convention, not a class hierarchy.
