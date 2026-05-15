# Skill: add an API key for another agent

Use when the human gives you an API key (or a service token) that a specific agent needs — "here's an OpenAI key for the notes agent," "give support a Linear token." Two files change in lockstep: `.env` holds the secret, `permissions.json` declares which profile sees it.

## The secrecy rule

**Never echo the key value back into chat.** Not in confirmation, not in an error message, not behind a "redacted last 4 chars" mask. Once it's in `.env`, the value is a sealed bit — you reference the key by *name* from then on. If the human pastes a key in chat, acknowledge by stating what you've received ("Got an OpenAI key for /notes — adding it now"), not by echoing the value.

If you misread or didn't capture the key, ask the human to verify it's set on the box yourself (`grep <NAME> .env`) rather than asking them to retype it in chat.

## Recipe

### 1. Pick the host-side env var name

Follow the `<SLUG>_<KEY>` convention so keys are namespaced by which agent owns them. Examples:

- Notes' OpenAI → `NOTES_OPENAI_API_KEY`
- Support's Linear → `SUPPORT_LINEAR_API_KEY`
- Research's Anthropic → `RESEARCH_ANTHROPIC_API_KEY`

The slug prefix matters: it's how a future-you reading `.env` can tell which agent the key belongs to. It also makes the env filter's job unambiguous.

### 2. Pick the agent-facing name

This is what the agent will see in its own environment (the prefix is stripped by the bridge):

- `NOTES_OPENAI_API_KEY` → agent sees `OPENAI_API_KEY`
- `SUPPORT_LINEAR_API_KEY` → agent sees `LINEAR_API_KEY`

Use whatever name an SDK or CLI you'll be running expects. If the agent uses `curl` against a raw API, pick the conventional name from that vendor's docs.

### 3. Append the value to `.env`

```bash
# At the bottom of .env, add (don't quote unless the value has spaces):
NOTES_OPENAI_API_KEY=<value-the-human-gave-you>
```

Edit `.env` in place, append-only — don't reorder, don't rewrite, don't paste it back into chat to "show" the diff. Read the file first to confirm the key isn't already there.

### 4. Add the mapping to `permissions.json`

Under the target profile's `env` map (agent-facing name → host-side name):

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

**`permissions.json` never holds the secret itself** — it holds the *name* of the env var that holds the secret. If you ever find yourself pasting a literal API key into `permissions.json`, stop: that's wrong, the file might be committed and the key would be in git history.

### 5. Restart the bridge

```bash
sudo systemctl restart occams-agent
sudo journalctl -u occams-agent -n 50
```

Look for the absence of this warning:

```
[agent] profile /<slug> declares env <AGENT_NAME> ← <HOST_NAME> but <HOST_NAME> is not set in process env
```

If you see it, the `.env` line didn't make it (typo in the var name, file not saved, the bridge can't read `.env` for some reason). Fix and restart again.

### 6. Confirm in chat

Describe what changed, don't echo:

> Added an OpenAI API key for /notes. Restarted the bridge — it picked up the new env mapping. Try `/notes` and have it run a quick API call to verify.

## Rotating a key (value changed, mapping unchanged)

1. Edit `.env` in place — change the value next to the existing variable name.
2. Restart the bridge.
3. Confirm in chat by name, not value: "Rotated `NOTES_OPENAI_API_KEY`. Restarted."

No `permissions.json` change needed.

## Removing a key

1. Remove the mapping from the profile's `env` map in `permissions.json`.
2. Remove the variable from `.env` (or leave the line and add `# unused` if you might bring it back).
3. Restart.
4. Confirm: "Revoked `LINEAR_API_KEY` for /support. Restarted — it no longer sees that key."

## Don't

- **Don't paste the key value into chat**, even in a confirmation, even truncated. The whole point of `.env` is that the value lives there and nowhere else.
- **Don't put the key value directly in `permissions.json`** — that file may be committed; values would be in git history. `permissions.json` has *names* only.
- **Don't grant a key to a profile that doesn't have an entry in `permissions.json`** — the bridge ignores env mappings on undeclared profiles, so the key would silently not be exposed. Add the profile entry first if it's new.
- **Don't add keys to admin's `env` map.** Admin is `superuser: true` and runs with `sandbox: full`, so it already has the entire repo as `--add-dir` — it can read `.env` directly when it actually needs to. Cluttering admin's env mapping just makes the host-side namespace messier.
- **Don't skip the restart.** `permissions.json` is cached at boot; new env mappings don't take effect until the bridge reloads.
- **Don't share a single env var across multiple agents** unless that's truly what the human asked for. The whole `<SLUG>_<KEY>` convention exists so each agent's blast radius is scoped. If notes and support both need OpenAI, prefer two separate keys (`NOTES_OPENAI_API_KEY`, `SUPPORT_OPENAI_API_KEY`) so they can be rotated or revoked independently.
