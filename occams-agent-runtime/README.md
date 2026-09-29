# Occam's Agent Runtime

The Node bridge that powers the orchestration layer in the parent repo. One process, one phone number, multiple agent personas selected per chat. You message the bridge → it loads the right agent profile → it spawns `claude` or `codex` with that profile's scope → it answers → it can also schedule recurring tasks against any profile.

This package sits inside `occams-agent/` and reads its sibling `<slug>-agent/` directories as profile definitions. See [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) and [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for the details.

## At a glance

- **Channels:** WhatsApp (via Baileys; uses your phone account) and Slack (via Bolt Socket Mode; no public webhook needed). One number serves all profiles.
- **Profiles:** each `<slug>-agent/` dir at the repo root defines an agent persona via its `agent-role.md` (frontmatter + role doc + `skills/`). Auto-discovered at runtime.
- **Routing:** prefix a message with `/<slug>` to bind a chat to that profile. Binding is sticky — subsequent messages stay with that profile until you switch. `/new` clears the conversation but keeps the profile; `/forget` wipes both.
- **CLI selection:** `/claude` and `/codex` are one-shot overrides for which CLI runs the agent turn. Default is `claude`.
- **Memory:** one shared `../vault/` (Karpathy LLM-Wiki pattern). Each profile has its own scratch under `vault/users/<slug>/` and reads from the vault areas its `agent-role.md` grants.
- **Sessions:** continuous per `(chatId, profile, cli-agent)`. Switching profiles starts a fresh session for that pair; switching back recovers the previous one.
- **Scheduler:** the agent writes JSON files to `vault/users/<profile-slug>/jobs/` to schedule recurring or one-shot prompts. The bridge fires them under the matching profile and delivers via `whatsapp:<user-slug>`, `slack:<user-slug>`, `file`, or a list of those. Per-job `model` override and `prefix: false` supported.
- **Attachments:** inbound images and documents are saved to the profile's `inbox-media/` and handed to the agent as file pointers; voice notes are transcribed. Outbound, `[[attach:/path]]` in a reply sends a file over WhatsApp.
- **Agent API (optional):** a token-gated localhost HTTP API for a personal dashboard or Obsidian plugin — projects, kanban tasks, chats, scheduled jobs, vault metadata, stop/message controls. Off by default.
- **Dashboard threads:** dashboard-created chats use stable `chat-*` IDs and can be resumed from Slack/WhatsApp with `/resume <chat-id>` or attached to a kanban task with `/task <task-id>`.

## Quick commands

```
/<slug> [msg]                          bind this chat to a profile (sticky); optional first message
/profiles                              list available profiles
/whoami                                your identity + the chat's bound profile
/new                                   clear conversation history, keep profile binding
/forget                                wipe this chat (profile + history)
/jobs                                  list scheduled jobs for the current profile
/jobs rm <id>                          delete a job
/cron <m h dom mo dow> <prompt>        schedule recurring
/cron once <YYYY-MM-DDTHH:MM> <prompt> schedule one-shot
/resume <chat-id>                      bind this Slack/WhatsApp thread to a dashboard chat
/task <task-id>                        bind this thread to a task's chat, creating one if needed
/claude <msg>                          one-shot Claude override
/codex <msg>                           one-shot Codex override
/streaming [on|off]                    show or hide the live tool-call trace
/stop                                  stop the agent turn that's running for this chat
/help                                  list commands
```

Plain messages route to the chat's bound profile.

## Where things live

```
occams-agent/                        <-- git repo root
  vault/                             <-- shared knowledge base
    CLAUDE.md                          authoritative schema; read by every agent turn
    AGENTS.md                          symlink to CLAUDE.md (for codex)
    areas/                             topical wiki + synopsis streams
    users/<slug>/                      per-profile scratch + jobs/
  admin-agent/                       <-- example profile dirs (siblings of this package)
    agent-role.md                      frontmatter + system prompt
    skills/                            skill markdown files
  notes-agent/   echo-agent/
  occams-agent-runtime/             <-- Occam's Agent Runtime
    src/
      index.js                         entry, boots channels + scheduler
      channels/whatsapp.js  slack.js   inbound message handling
      router.js                        slash-command parsing + dispatch
      profiles.js                      profile discovery & loading
      agent.js                         claude/codex subprocess spawner + bwrap sandbox
      permissions.js                   loads permissions.json (authority per profile)
      scheduler.js                     node-cron + fs.watch on jobs/
      state.js                         per-chat profile binding + session UUIDs
      users.js                         identity (phone/Slack id → user slug)
      jobs.js                          jobs file helpers
      worktrees.js                     external-repo worktrees for the PR workflow
      api.js                           optional agent API (dashboard / Obsidian)
      registry.js                      projects/tasks/chats/runs control-plane store
      transcript.js                    reads CLI session files for chat history
      webhook.js                       optional HMAC-gated inbound webhook
    auth/   state.json   runtime-data/ per-instance, gitignored
```

## Configuration

The live config files (`.env`, `users.json`) sit at the **repo root**, not in this package. The runtime computes their paths relative to the repo root by default (overridable via `VAULT_DIR`, `USERS_FILE`, `PROFILES_DIR`).

See `../.env.example` and `../users.example.json` for the shapes.

## Agent API

Enable the API with:

```
ENABLE_AGENT_API=true
AGENT_API_HOST=127.0.0.1
AGENT_API_PORT=8787
AGENT_API_TOKEN=<long random token>
AGENT_API_USER_SLUG=operator
```

Keep the listener private: bind to localhost and reach it over an SSH tunnel or VPN (e.g. Tailscale), or bind to the VPN interface with ACLs/firewall rules. Every request must include `Authorization: Bearer <token>` or `X-Agent-API-Token: <token>`. `AGENT_API_USER_SLUG` is the `users.json` user that dashboard-originated messages run as (its `profiles` allowlist applies).

Core endpoints:

```
GET    /health
GET    /profiles
GET    /snapshot

GET    /projects
POST   /projects
PATCH  /projects/:id
DELETE /projects/:id

GET    /tasks?projectId=&status=
POST   /tasks
PATCH  /tasks/:id
DELETE /tasks/:id
POST   /tasks/:id/chats        create or link a chat for a kanban task

GET    /chats?taskId=&status=&profile=
POST   /chats
GET    /chats/:id
PATCH  /chats/:id
POST   /chats/:id/messages     send a message; returns reply + events
POST   /chats/:id/stop
POST   /chats/:id/aliases      bind Slack/WhatsApp channel chat IDs to this chat
GET    /chats/:id/runs
GET    /chats/:id/events       full transcript (from the CLI's session file)

GET    /jobs
POST   /jobs
PATCH  /jobs/:profile/:id
DELETE /jobs/:profile/:id

GET    /vault/tree?path=&depth=
GET    /vault/recent?limit=
GET    /vault/file?path=       md/json/txt only, 512 KB cap
```

The control-plane store lives in `occams-agent-runtime/runtime-data/control-plane.json` by default (gitignored; `RUNTIME_DATA_DIR` overrides). Scheduled jobs remain the JSON files under `vault/users/<profile>/jobs/`.
