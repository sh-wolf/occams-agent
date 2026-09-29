# Skill: change another agent's profile

Use when the human asks you to modify how another agent behaves: its role, its skills, its authority (areas, sandbox, env, billing).

## What you can edit, and where

For any agent `X`, two places matter:

- **`X-agent/agent-role.md`** — its system prompt body and descriptive frontmatter (`slug:`, `description:`). Read on every message. Changes take effect on next message, no restart needed.
- **`X-agent/skills/*.md`** — its skill files (add, remove, rewrite). Read on demand by the agent.
- **`permissions.json`** (at the repo root) — its authority: `areas`, `superuser`, `sandbox`, `billing`, `env`. Cached at bridge boot; changes need `sudo systemctl restart occams-agent` to take effect.

You can also edit the runtime, deploy scripts, and root config files as admin — see `edit-runtime.md`.

## Decide first: direct or propose?

Re-read your own role doc's "Decide: edit directly, or propose first?" section. If in doubt, propose. The cost of a one-message confirmation round-trip is low; the cost of silently mis-tuning another agent is high.

In particular, **changes to `permissions.json` are authority changes** — they grant/revoke access to vault areas, swap sandbox modes, expose env vars. Propose first unless the change is purely additive and the human already asked for it.

## Direct-edit procedure (role doc / skills)

1. Read the target file first (don't write blind).
2. Make the smallest change that achieves the human's intent. Don't rewrite-for-style on the way through.
3. Reply to the human in one sentence: "Updated /<slug>: <what changed>."

No restart needed. Role docs and skills are read fresh on each message / on demand.

## Direct-edit procedure (permissions.json)

1. Read `permissions.json` first.
2. Apply the smallest change that achieves the intent — touch only the affected slug's entry.
3. `sudo systemctl restart occams-agent` to load the new authority. See `restart-self.md`.
4. Verify the change took effect by checking `journalctl -u occams-agent -n 50` for the startup banner (`profiles found: ...`) and any `[permissions]` warnings.
5. Reply with one sentence + what to look for: "Updated /<slug>'s areas to include `<new-area>`. Restarted. Tell me if it can read it now."

## Propose-first procedure

See `propose-to-human.md`.

## Renaming an agent

Slugs are sticky — `vault/users/<slug>/jobs/`, session UUIDs, chat bindings, the `permissions.json` key all reference the slug. Renaming is invasive:

1. Propose first. Don't rename unilaterally.
2. If approved: rename the dir (`<old>-agent` → `<new>-agent`), update `slug:` in frontmatter, update the key in `permissions.json`, migrate `vault/users/<old>/` → `vault/users/<new>/`. Clear any chat bindings to the old slug (state.json is owned by the running process — ask the human to /forget the affected chats).

## Deleting an agent

Equally invasive. Propose first. If approved: `rm -rf <slug>-agent/`, remove the slug from `permissions.json`, restart. Leave `vault/users/<slug>/` intact unless the human asks to delete it — the scratch may have history worth keeping.

## Don't

- Don't edit your own profile dir (`admin-agent/`) or your own `permissions.json` entry. Your role evolves through human decisions, not self-edits. If you think your role should change, propose it.
- Don't grant `superuser: true` to any other agent without an explicit human approval. There should be exactly one admin. (`superuser: true` also implies `sandbox: full` — the runtime rejects a sandboxed superuser as incoherent.)
- Don't put authority fields (`areas:`, `superuser:`, `sandbox:`) in role-doc frontmatter expecting them to take effect. The runtime ignores them; authority comes from `permissions.json`.
