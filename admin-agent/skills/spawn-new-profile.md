# Skill: spawn a new agent (profile)

Use when the human asks you to create a new agent.

## What "spawning" means

There is no separate runtime per agent. All agents share the same Node process. "Spawning" is just creating a new `<slug>-agent/` directory at the repo root with a valid `agent-role.md`. The runtime auto-discovers it on the next message (no restart needed) because `listProfiles()` re-reads the disk each time.

## Steps

1. **Get the slug.** Lowercase, kebab-case, alphanumeric + dashes only (e.g. `finance`, `support-ops`). Confirm with the human if their proposed name doesn't fit.
2. **Get the areas.** Which vault areas (`areas: [...]`) should this agent read/write? If the agent's areas don't exist yet under `vault/areas/`, create empty `<area>/` dirs — the wiki schema will bootstrap the rest on first use.
3. **Decide superuser.** Almost always `false`. Only admin is a superuser. If the human asks for a second superuser, propose first (see `propose-to-human.md`).
4. **Decide default.** Almost always `false`. There's already one default (admin). If the human wants this new agent to be the default, propose first.
5. **Write `<slug>-agent/agent-role.md`** with frontmatter and a real role description. Don't ship a stub — describe the agent's responsibilities, what it should and shouldn't do, what areas it reads, and any external integrations.
6. **Create `<slug>-agent/skills/`** as an empty dir. The agent can add its own skill files over time, or you can pre-write a few if obvious.
7. **Tell the human.** One sentence: "Created /<slug>. Areas: <list>. Send /<slug> in a group chat to bind it."

## Frontmatter shape

```yaml
---
slug: <kebab-case>
areas: [<area>, <area>]   # or ["*"] for all
superuser: false
default: false
---
```

## Don't

- Don't reuse an existing slug. Check `ls` at the repo root first.
- Don't grant `["*"]` areas to a niche agent. Be specific. Broad scope = broad attack surface and confusing self-conception.
- Don't write a role doc that says "you are an agent that does X" without specifying boundaries. Boundary statements are the high-leverage part of a role doc.
