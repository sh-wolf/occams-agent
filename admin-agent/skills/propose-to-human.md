# Skill: propose a change to the human

Use when you've decided a change is risky / ambiguous / scope-broadening enough that the human should approve it before you act. See your role doc's "Decide: edit directly, or propose first?" section for the heuristic.

## How proposals work

Proposals are just chat messages. There's no special workflow file other than a local tracker so you remember pending proposals across sessions (the cron-fired send and the human's reply land in different sessions).

1. **Append the proposal to `pending-proposals.md`** in your scratch dir (`vault/users/admin/pending-proposals.md`). Create the file if it doesn't exist.
2. **Reply to the human via the current chat** (or, if you're in a cron-fired session, deliver via WhatsApp/Slack DM by ending your output with the proposal text — the cron deliver pipes your output to the configured channel).
3. **On the next interactive turn**, read `pending-proposals.md` first thing. Match the human's reply to a pending entry by topic, then update its `status` and act on the answer.

## Tracker format

`vault/users/admin/pending-proposals.md`:

```
## 2026-05-11 14:32 — grant-notes-finance-area
- channel: whatsapp:operator
- summary: Notes agent wants read access to the finance area for Q2 spend modeling.
- detail: She asked while ingesting the May meeting. No write access proposed.
- status: pending
```

Each entry uses an `##` heading with the timestamp + short slug. The slug is just for your own matching — keep it descriptive enough that a future reply like "yes, do that" can be matched unambiguously.

Statuses: `pending`, `approved`, `rejected`, `cancelled`. Move processed entries to a `## Resolved` section at the bottom of the file once they're done so the active list stays short.

## Phrasing the proposal in chat

Be brief. Lead with the action, then the rationale, then ask for a yes/no:

> Proposal: grant notes read access to the `finance` area for Q2 spend modeling. She mentioned this in today's ingest and there's no write — read only. OK to apply?

Don't bury the ask in a paragraph. The human is on their phone.

## When the human replies ambiguously

If the reply doesn't clearly match a single pending entry, ask one short clarifying question naming the proposal. Don't guess.

## When to skip the tracker

If you're proposing and acting in the same interactive turn (the human is on the other end right now, you ask, they answer immediately), you don't strictly need the tracker. But write it anyway — it's a cheap audit trail and the human may want to review proposals later.

## Don't

- Don't bundle multiple proposals into one message unless they're tightly related. The human's "yes" is ambiguous when there are three asks in one reply.
- Don't act on a proposal until you have a clear approval. "Maybe" or silence is not approval.
- Don't delete `pending-proposals.md` entries — move them to the Resolved section so the history persists.
