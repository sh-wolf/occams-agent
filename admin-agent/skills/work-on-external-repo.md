# Skill: work inside an external repo (worktree → PR flow)

Use when this profile has been granted access to an external repo via `permissions.json`'s `extra_repos:` field. The bridge tells you about these in the `[bridge context]` block at the top of every turn — look for an `External repos available` section listing what's mounted and where.

This skill is for `mode: "pr"` repos (the default). For `mode: "direct"` repos, ignore the PR/submit bits — your edits land in the live checkout immediately.

## The shape

You don't see the canonical clone of the repo. You see a **git worktree** the bridge created for this specific chat, at a path the bridge announces. It's a normal working tree — `cd` into it, run any git command you'd run as a human, edit files with your normal tools — but the branch it's on is yours alone, and you don't have permission to push.

Mechanically:
- Your worktree lives at `vault/users/<your-slug>/worktrees/<hash>-<repo-name>/`.
- It's on a branch like `agent/<your-slug>/<hash>`.
- The branch was just-created off the latest `origin/<default-branch>` when you first touched the repo this turn.
- Across multiple messages in the **same chat**, the same worktree + branch persist — pick up where you left off.
- A different chat editing the same repo gets a different worktree + different branch — no collision.

## How to do work

1. **Read first.** `cd` into the worktree path, then `ls` / `cat README.md` / `cat package.json` / `cat CLAUDE.md` (if present) to orient. Treat it like any other coding task — follow the repo's conventions, don't introduce new patterns unprompted.

2. **Make the smallest change that achieves the goal.** Don't refactor while you're in there. Don't add features the human didn't ask for. The reviewer of the eventual PR thanks you.

3. **Commit as you go, with clear messages.** Each logical chunk gets a commit. Don't do one giant commit at the end — it makes the PR harder to review. Commit messages should describe *why*, not just *what*:
   ```bash
   git add <files>
   git commit -m "fix: pricing table reads from /api/pricing instead of hardcoded list"
   ```

4. **Don't try to push.** `git push` will fail — your sandbox doesn't have SSH keys, that's by design. The bridge does the push for you when the human runs `/submit`. You can't bypass it; don't waste turns trying.

5. **Don't try to pull or fetch.** Your branch was branched off a fresh `origin/<default-branch>` when the bridge created the worktree. If you need to rebase on a newer base (rare in a single chat), tell the human and let them refresh the worktree.

6. **Use the repo's tooling locally.** Run tests, linters, type-checkers if they exist (`npm test`, `make lint`, etc.). The sandbox has network access so npm/pip/etc. can install. Catch failures yourself before the human sees them in the PR.

7. **Tell the human when you think you're done.** Something like: "Done. Two commits on the worktree for the pricing change. Run `/submit "Update pricing page"` when you're ready to open the PR." Don't run `/submit` yourself — that's a slash command for the human.

## What happens when the human runs `/submit`

The bridge (outside your sandbox, with SSH keys):
1. Auto-commits any uncommitted changes you left behind (with a generic message — try to avoid this by committing yourself).
2. Pushes your branch to `origin`.
3. Runs `gh pr create` against the repo's default branch.
4. Reports the PR URL back in chat.

You don't see any of this happen — the human does. When they paste the PR URL or thank you, treat that as the signal that this round of work is on its way to review.

## Multi-repo chats

If you have access to more than one repo this chat, you have one worktree per repo, all on the same branch name (e.g. `agent/marketing/abc123`). Edits in one don't bleed into another — they're separate working trees with separate `.git` pointers. `/submit` opens a PR per repo that has commits.

## Hygiene

- **Don't `rm -rf` the worktree.** If you want a "clean slate," ask the human to `/forget` the chat — that destroys the worktree cleanly and the next chat starts fresh.
- **Don't edit files outside the worktree path with the intent of changing the repo.** Files outside your worktree aren't part of the repo; edits there go to your scratch dir, not to any PR.
- **Don't edit `.git/`** inside the worktree. It's a pointer back to the source repo's metadata; corrupting it breaks the worktree.
- **Don't change git remotes.** The remote is set to the source repo's remote; the bridge's push depends on it being correct.

## When it goes wrong

- **Push fails / `gh pr create` fails.** Either gh isn't authenticated on the box or the SSH key doesn't have push rights for that remote. Tell the human; this needs setup on their end. The commits stay on the local branch in the worktree — nothing lost.
- **`git commit` says "Please tell me who you are."** The bridge should be binding `~/.gitconfig` into your sandbox. If it isn't, the host hasn't set `git config --global user.name` and `user.email` for the service user. Tell the human.
- **`git status` shows the wrong thing or things look weird.** Don't try to recover with reflog or hard resets. Tell the human; let them inspect the worktree from outside the sandbox.

## Don't

- Don't attempt `git push`. It will fail.
- Don't run `/submit` yourself. It's not your call to open a PR.
- Don't try to commit secret values (API keys, tokens) into the repo. If a file looks secret-bearing in the external repo, leave it alone.
- Don't force-push, rebase against rewritten upstream, or otherwise rewrite shared history. The branch is yours, but it lives on a shared origin once submitted.
