# Skill: edit the runtime safely

Use when you need to change code under `occams-agent-runtime/src/` — i.e., the JS that runs the bridge itself. This is higher-stakes than editing role docs or skills, because a syntax error or broken assumption takes the entire service down.

## Before you edit

**Propose first** unless the change is truly mechanical (typo, comment fix, import reorder). See your role doc's "Decide: edit directly, or propose first?" — runtime changes almost always belong in "propose first." Get a clear yes from the human before touching any file under `occams-agent-runtime/src/`.

## The safe edit-deploy cycle

1. **Read the existing file.** Don't write blind. Understand the current shape, the imports, the export contract.
2. **Make the smallest change.** Don't refactor "while you're in there." Don't add features the human didn't ask for. Don't change indentation or formatting that's not in your diff.
3. **Syntax check before deploy:**
   ```bash
   node --check occams-agent-runtime/src/<file>.js
   ```
   If that prints anything other than a clean exit, fix it before continuing.
4. **For non-trivial logic changes, smoke-test in isolation** by importing the changed module in a small Node one-liner if possible:
   ```bash
   node --input-type=module -e "import('./occams-agent-runtime/src/<module>.js').then(m => console.log(Object.keys(m)))"
   ```
   (Adjust to actually exercise the changed function with a fake input.)
5. **Stage + commit + push** so the change is on `origin/main` (and survives any VM mishap):
   ```bash
   git add occams-agent-runtime/src/<file>.js
   git commit -m "<short description of why>"
   git push
   ```
6. **Restart** to apply: see `restart-self.md`.
7. **Verify** clean startup by tailing `journalctl -u occams-agent -n 50`. If broken, revert (see `restart-self.md`'s "when a restart goes wrong" section).

## What to never touch without explicit human approval

- `occams-agent-runtime/src/channels/` — Slack and WhatsApp bridges. Subtle interactions with auth, presence, threading. Easy to break delivery.
- `occams-agent-runtime/src/agent.js`'s subprocess-spawn logic — getting `--add-dir`, `--session-id`, or `--resume` wrong corrupts sessions. Read existing logic before adjusting.
- `occams-agent-runtime/src/state.js` write semantics — the in-memory cache + serialized-write pattern is intentional; concurrent writes can lose data if you break it.
- `package.json` `dependencies` — adding a new npm package means the human needs to `npm install` on the VM. Always propose first.

## What's lower-risk

- `occams-agent-runtime/src/router.js` — add a new slash command, tweak help text, change a message body. Easier to revert.
- `occams-agent-runtime/src/profiles.js` — add new frontmatter fields, expose new helpers. Backward-compatible by default.
- `occams-agent-runtime/src/jobs.js` — small helpers. Test paths with `node --check`.

## Coordinate with the human

After a runtime change is live, **always confirm in chat** what shipped: one sentence summarizing what changed and what to look for if it misbehaves. The human is the one who notices "hey something's weird" first.

## Don't

- Don't refactor for style. The codebase has a voice; preserve it.
- Don't add CommonJS imports or remove `type: module`. The runtime is ESM-only.
- Don't write tests as a side effect. There's no test runner wired up.
- Don't add new top-level dependencies without explicit approval — `package.json` changes require human sign-off.
