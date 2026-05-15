# Skill: change another agent's profile

Use when the human asks you to modify how another agent behaves: its role, its skills, its areas, its frontmatter.

## What you can edit

For any agent `X`:

- `X-agent/agent-role.md` — its system prompt + frontmatter (slug, areas, superuser, default).
- `X-agent/skills/*.md` — its skill files (add, remove, rewrite).
- `X-agent/` — any other files the agent uses.

(You can also edit the runtime, deploy scripts, and root config files as admin — but that's a different skill. See `edit-runtime.md` for code changes.)

## Decide first: direct or propose?

Re-read your own role doc's "Decide: edit directly, or propose first?" section. If in doubt, propose. The cost of a one-message confirmation round-trip is low; the cost of silently mis-tuning another agent is high.

## Direct-edit procedure

1. Read the target file first (don't write blind).
2. Make the smallest change that achieves the human's intent. Don't rewrite-for-style on the way through.
3. If you changed the frontmatter (`areas`, `superuser`, `default`, `slug`), the next message that uses the affected profile will see the new values — no restart needed.
4. Reply to the human in one sentence: "Updated /<slug>: <what changed>."

## Propose-first procedure

See `propose-to-human.md`.

## Renaming an agent

Slugs are sticky — `vault/users/<slug>/jobs/`, session UUIDs, chat bindings all key off the slug. Renaming is invasive:

1. Propose first. Don't rename unilaterally.
2. If approved: rename the dir (`<old>-agent` → `<new>-agent`), update `slug:` in frontmatter, migrate `vault/users/<old>/` → `vault/users/<new>/`, clear any chat bindings to the old slug in `state.json` (this is the runtime's job — you can't edit state.json safely while the process runs; ask the human to /forget the affected chats).

## Deleting an agent

Equally invasive. Propose first. If approved: `rm -rf <slug>-agent/`. Leave `vault/users/<slug>/` intact unless the human asks to delete it — the scratch may have history worth keeping.

## Don't

- Don't edit your own profile dir (`admin-agent/`). Your role evolves through human decisions, not self-edits. If you think your role should change, propose it.
- Don't grant `superuser: true` to any other agent without an explicit human approval. There should be exactly one admin.
