# Skill: restart the bridge service

Use this after any change to `occams-agent-runtime/src/` (JS code) or to systemd-relevant config. Markdown-only edits (role docs, skills, vault content) **do not** need a restart — they're re-read fresh on the next message.

## How

You have a narrowly-scoped passwordless sudo rule for exactly one command:

```bash
sudo systemctl restart occams-agent
```

That's it. You cannot run any other sudo command — the sudoers drop-in at `/etc/sudoers.d/occams` whitelists only this restart.

## After restarting, verify

The restart command itself returns quickly, but the service takes ~3-5 seconds to fully reinitialize (Slack reconnection, scheduler scan). Check that it came up cleanly:

```bash
sudo systemctl status occams-agent
```

Or, more informative, tail the recent logs:

```bash
sudo journalctl -u occams-agent -n 50
```

Look for:
- `occams-agent starting`
- `profiles found: /admin /notes /echo` (or whatever profiles you expect)
- `[slack] connected (socket mode)` if Slack is enabled
- `[whatsapp] connected` if WhatsApp is enabled
- `[scheduler] active jobs: N`

If you see any line starting with `Error:` or repeated `[slack] disconnected` reconnect attempts, the restart didn't go cleanly.

## When a restart goes wrong

If the service fails to start (status `failed` or `activating (auto-restart)` looping), the JS change you just made is probably broken. **Don't iterate fixes on a broken service.** Revert:

```bash
git -C <repo-dir> log --oneline -5      # find the commit you just made
git -C <repo-dir> revert HEAD --no-edit
git -C <repo-dir> push
sudo systemctl restart occams-agent
```

Then tell the human in chat: "Reverted my last change (commit X). The change broke startup — error was: <quote the error line from journalctl>. I'll wait for guidance before retrying."

## Hazards

- **In-flight messages get interrupted.** If a claude subprocess is mid-run when you restart, it gets SIGTERM'd. The user's reply is lost; they'll see "claude exited with signal SIGTERM" or similar. Schedule restarts for quiet moments when possible.
- **Slack/WhatsApp reconnect time.** During the ~3-5 sec restart window, messages from the channels are dropped (the bridge isn't connected). Slack will retry, but the user may notice a delay.
- **Scheduler re-registers all cron jobs.** Brief — usually <100ms. Harmless.
- **state.json is preserved.** Sessions resume cleanly across restart.

## Don't

- Don't restart "just in case" — it's not free (see hazards above). Restart only when a real change requires it.
- Don't try `sudo systemctl stop` or `sudo systemctl daemon-reload` — those aren't in your sudoers whitelist and will prompt for a password (you don't have one). Only `restart` works.
- Don't restart in the middle of a conversation with another user without warning them. Tell them in chat: "Restarting briefly to apply a change — back in 5 seconds."
