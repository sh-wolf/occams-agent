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
- **Scheduler:** the agent writes JSON files to `vault/users/<profile-slug>/jobs/` to schedule recurring or one-shot prompts. The bridge fires them under the matching profile and delivers via `whatsapp:<user-slug>`, `slack:<user-slug>`, or `file`.

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
      agent.js                         claude/codex subprocess spawner
      scheduler.js                     node-cron + fs.watch on jobs/
      state.js                         per-chat profile binding + session UUIDs
      users.js                         identity (phone/Slack id → user slug)
      jobs.js                          jobs file helpers
    .env.example                       (the live .env lives at the repo root)
    auth/   state.json                 per-instance, gitignored
```

## Configuration

The live config files (`.env`, `users.json`) sit at the **repo root**, not in this package. The runtime computes their paths relative to the repo root by default (overridable via `VAULT_DIR`, `USERS_FILE`, `PROFILES_DIR`).

See `../.env.example` and `../users.example.json` for the shapes.
