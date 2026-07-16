# Skill: send a file as a WhatsApp attachment

Use when the user is on WhatsApp and your reply is better as a file than as inline text — a chart you rendered, a PDF, a CSV export, a screenshot, an audio clip. WhatsApp only; Slack does not support this yet.

## How

Embed `[[attach:/absolute/path]]` anywhere in your chat reply. The runtime:

1. Strips every `[[attach:...]]` marker out of the text.
2. Sends the cleaned text first (chunked normally).
3. Dispatches each referenced file as a follow-up media message, in the order the markers appeared.

You can include multiple markers in one reply. If the reply is *nothing but* markers, the runtime skips the text post entirely and the user just gets the files.

## Path rules

- **Absolute paths only.** Relative paths will fail because the runtime resolves from the bridge's cwd, not yours.
- The file must be readable by the `careco` user (the bridge process). Anything under `vault/`, your scratch dir, or `/tmp/` works.
- Don't attach `.env`, `users.json`, `state.json`, or anything else secret-bearing. Same rule as quoting them in chat — the file goes straight to the human's phone, but it'll also live in their WhatsApp media cache.

## Type inference

The runtime picks the WhatsApp media kind from the file extension:

- `.jpg .jpeg .png .webp .gif` → image
- `.ogg .opus .mp3 .m4a .wav` → audio (voice-note-style playback for ogg/opus)
- `.mp4 .mov .webm .mkv` → video
- anything else → generic document (filename preserved)

If you need a specific rendering, name the file with the matching extension before attaching.

## Examples

Text + one image:
```
Here's the funnel chart for last week. The drop-off at step 3 is the thing we talked about.

[[attach:/home/careco/careco-agentic-orchestration/vault/users/marketing/exports/2026-W20-funnel.png]]
```

Just files, no text:
```
[[attach:/tmp/synopsis-2026-W20.pdf]]
[[attach:/tmp/synopsis-2026-W20.csv]]
```

## In cron jobs

`deliver_to: whatsapp:<slug>` runs through the same `sendDM` path, so markers work in cron-fired replies too. Generate the file as part of the job's work, then include the marker in your final output.

## When it fails

If a path doesn't exist or isn't readable, the user gets a `⚠️ Couldn't attach <path>: <reason>` message after the main reply. The rest of the reply still goes through. Check the journal (`journalctl -u careco-agent`) for the underlying error.

## Don't

- Don't paste the marker into the wiki or any persistent file. It's a runtime directive, not content — Obsidian will render it as a broken wikilink.
- Don't use it on Slack. The marker will just appear as literal text in the message.
- Don't attach huge files casually. WhatsApp caps individual media around 100 MB; large files also slow down the send.
