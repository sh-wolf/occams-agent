# Skill: spawn a new agent (profile)

Use when the human asks you to create a new agent.

## What "spawning" means

There is no separate runtime per agent. All agents share the same Node process. "Spawning" is a two-step thing:

1. **Create the profile directory** — `<slug>-agent/agent-role.md` (the system prompt) plus an empty `skills/` dir.
2. **Add a `permissions.json` entry** — the authority bits (areas, sandbox, billing, env). The runtime reads authority from `permissions.json` at the repo root, NOT from the role doc's frontmatter. A profile dir without a permissions entry will not load.

Authority changes take effect on the next bridge restart. Profile dir changes (role doc, skills) take effect on the next message.

## Steps

1. **Get the slug.** Lowercase, kebab-case, alphanumeric + dashes only (e.g. `finance`, `support-ops`). Confirm with the human if their proposed name doesn't fit.
2. **Get the areas.** Which vault areas (`areas: [...]`) should this agent read/write? If the agent's areas don't exist yet under `vault/areas/`, create empty `<area>/` dirs — the wiki schema will bootstrap the rest on first use.
3. **Decide sandbox.** Almost always `strict` (the bubblewrap-confined default). Only set `full` if the agent genuinely needs to reach outside its scope — and if it does, that's usually a sign the work belongs to admin instead.
4. **Decide superuser.** Almost always `false`. Only admin is a superuser. If the human asks for a second superuser, propose first (see `propose-to-human.md`). Superuser implies `sandbox: full`.
5. **Decide billing.** `subscription` (Claude OAuth — most agents) or `api` (uses `ANTHROPIC_API_KEY` from `.env`, e.g. for a high-volume polling agent whose usage shouldn't count against the subscription).
6. **Decide env.** Map agent-facing var names → `.env` keys following the `<SLUG>_<KEY>` convention. Example: `{ "OPENAI_API_KEY": "FINANCE_OPENAI_API_KEY" }`. The agent sees `OPENAI_API_KEY` in its env; the host-side `.env` has `FINANCE_OPENAI_API_KEY=...`.
7. **Write `<slug>-agent/agent-role.md`** with frontmatter (`slug:` + `description:` — descriptive only, no authority) and a real role description. Don't ship a stub — describe the agent's responsibilities, what it should and shouldn't do, what areas it reads, and any external integrations.
8. **Create `<slug>-agent/skills/`** as an empty dir. The agent can add its own skill files over time, or you can pre-write a few if obvious.
9. **Add the entry to `permissions.json`** at the repo root. The file is gitignored and per-deploy (`permissions.example.json` is the template). The runtime is the only thing that reads it, so write directly — no proposals needed for new entries (you're not changing existing authority).
10. **Restart the bridge** so the new permissions entry loads (`sudo systemctl restart occams-agent`). Profile dirs auto-discover live, but `permissions.json` is cached at boot.
11. **Tell the human.** One sentence: "Created /<slug>. Areas: <list>. Sandbox: <strict|full>. Send /<slug> in a group chat to bind it."

## Frontmatter shape (descriptive only)

```yaml
---
slug: <kebab-case>
description: <one-line summary of what this agent does>
---
```

## permissions.json entry shape

```json
"<slug>": {
  "areas": ["<area>", "<area>"],
  "superuser": false,
  "sandbox": "strict",
  "billing": "subscription",
  "env": {}
}
```

Optional keys: `model` (pin a CLI model), `effort`, `streaming: false` (no live tool trace by default), `deny_tools` (tool names to block), `extra_repos` (external git repos — see `work-on-external-repo.md`). `permissions.example.json` documents each.

## Don't

- Don't reuse an existing slug. Check `ls` at the repo root first.
- Don't grant `["*"]` areas to a niche agent. Be specific. Broad scope = broad attack surface and confusing self-conception.
- Don't write a role doc that says "you are an agent that does X" without specifying boundaries. Boundary statements are the high-leverage part of a role doc.
- Don't skip the permissions.json entry. A dir without one will not load — the runtime will warn `[profiles] X-agent/ exists on disk but has no permissions.json entry — not loaded` at boot.
- Don't put authority fields (`areas:`, `superuser:`, `sandbox:`) in role-doc frontmatter. They're ignored at runtime, so it just creates a misleading source of truth.
