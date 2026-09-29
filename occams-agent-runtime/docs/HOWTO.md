# HOWTO — common operational tasks

Short recipes for the things you do often. For the full deploy/diagnostics
reference see [UPDATING.md](UPDATING.md).

## The one rule that explains everything

Two users on the VM, two jobs:

- **`occams`** (the service user) — owns the repo + files. Has **no password, no sudo**. Use it
  for: editing `.env`/`users.json`, `git pull`, WhatsApp QR pairing.
- **your sudo user** (or root) — the sudoer. Use it for: anything `systemctl`.

If `sudo` asks for a password and hangs/prompts, you're running it as
`occams`. Switch users — don't fight it.

```bash
ssh <sudo-user>@<vm-host>     # sudo-capable login
sudo -iu occams             # become the repo owner when you need to
exit                     # back to your sudo user for systemctl
```

---

## How to restart the agent

```bash
ssh <sudo-user>@<vm-host>
sudo systemctl restart occams-agent
sudo journalctl -u occams-agent -f      # watch it come up; Ctrl-C to stop watching
```

A restart is required after editing `.env`, `users.json`, `permissions.json`,
or any code under `occams-agent-runtime/src/`. (Markdown, vault content, and
agent skills take effect with no restart.)

---

## How to view or edit the VM's `.env`

The runtime config is `/home/occams/occams-agent/.env` (owned
by `occams`). **Not** a `.env` on your laptop — the VM's copy is the one the
service reads.

```bash
ssh <sudo-user>@<vm-host>
sudo -iu occams
nano ~/occams-agent/.env
exit
sudo systemctl restart occams-agent     # .env is read once at startup
```

Note: `ENABLE_WHATSAPP` defaults to **on** when the line is absent. WhatsApp
is only off if it's explicitly `ENABLE_WHATSAPP=false`. The startup banner
line `whatsapp: on|off` confirms which.

---

## How to pair WhatsApp (scan the QR)

Needed once, or again if the session is logged out. The QR only appears when
`occams-agent-runtime/auth/` has no valid session.

```bash
ssh <sudo-user>@<vm-host>
sudo systemctl stop occams-agent              # release the WhatsApp socket
sudo -iu occams
cd ~/occams-agent/occams-agent-runtime
npm start
#   → "[whatsapp] scan this QR" appears
#   → phone: WhatsApp ▸ Settings ▸ Linked Devices ▸ Link a Device ▸ scan it
#   → wait for "[whatsapp] connected", then Ctrl-C
exit
sudo systemctl start occams-agent
```


---

## How to let someone message the agent on WhatsApp

Edit `users.json` at the repo root and add their **phone number, with country
code, digits only** (no `+`, spaces, or dashes). US example: `+1 555 123 4567`
→ `15551234567`.

```bash
ssh <sudo-user>@<vm-host>
sudo -iu occams
nano ~/occams-agent/users.json
exit
sudo systemctl restart occams-agent     # users.json is read once at startup
```

Entry shape:

```json
{
  "slug": "newperson",
  "name": "New Person",
  "whatsapp": ["15551234567"],
  "slack": [],
  "profiles": ["*"]
}
```

- `slug` — lowercase id, becomes their private `vault/users/<slug>/` dir.
- `whatsapp` — one or more numbers (digits only, with country code).
- `profiles` — which agents they can use. `["*"]` = all; or a list like
  `["notes","echo"]`. Valid slugs are the `<slug>-agent/` dirs that have a
  `permissions.json` entry (`admin`, `notes`, `echo` out of the box).

Verify: have them send `/whoami` to the number — it replies with their
identity. Unknown senders are silently dropped (see next recipe).

---

## How to find out why a WhatsApp message was ignored

```bash
sudo journalctl -u occams-agent -f
```

Look for: `[whatsapp] dropped message from <X>: not in users.json (...)`.

- The number shown doesn't match `users.json` → fix the entry (usual cause:
  missing country code).
- The log shows `remoteJid=...@lid` and the number looks nothing like a real
  phone → that contact uses WhatsApp's LID privacy. The bridge resolves this
  via `senderPn`; if `senderPn=-` in the log, WhatsApp didn't send the real
  number — add the `@lid` number itself to that user's `whatsapp` array as a
  fallback.

---

## How to deploy a code change

Edit + commit + push on your laptop, then on the VM:

```bash
ssh <sudo-user>@<vm-host>
sudo -u occams bash -c 'cd /home/occams/occams-agent && git pull' \
  && sudo systemctl restart occams-agent \
  && sudo journalctl -u occams-agent -f
```

If `package.json` deps changed, add a `npm install` step — see
[UPDATING.md](UPDATING.md) for that and for the full diagnostics reference.
