# Skill: ingest a source

Use when the human drops something into chat that's worth saving: a URL, a fact, a quote, a meeting transcript, a journal entry, a decision. The schema in `vault/CLAUDE.md` covers the canonical flow; this skill is a concrete walkthrough.

## Decide the area

Pick the best topical area from `vault/areas/`. If the area doesn't exist yet, create it (`<area>/` with `raw/` and `wiki/` subdirs, plus an empty `index.md` and `log.md`). If a single source plausibly fits two areas, **ask** — don't silently file it under one and miss the other.

## Save the raw source

Path: `vault/areas/<area>/raw/<YYYY-MM-DD>-<slug>.md`

Frontmatter:

```yaml
---
date: 2026-05-13
source_url: https://example.com/article  # if any
ingested_by: <user-slug>
channel: whatsapp | slack | cron
---
```

Then the raw content below the frontmatter. For URLs, fetch the content with `WebFetch` (or the browser MCP if it's auth-walled) and store the extracted text — not just the URL. For pasted quotes, store them verbatim. **Never modify the raw content after writing it.** That's what the immutable `raw/` directory is for.

## Update the wiki

Identify what entities or topics the source touches (people, places, projects, concepts). For each one:

- If a wiki page exists under `vault/areas/<area>/wiki/`, update it: add new claims, link the new raw source in the `sources:` frontmatter list, append a brief note.
- If no wiki page exists, create one. Use the filename conventions from the schema (`wiki/people/<name>.md`, `wiki/topics/<topic>.md`, etc.).

Use Obsidian wikilinks for cross-references: `[[areas/<area>/wiki/topics/<topic>]]`.

**Preserve prior claims.** Don't blanket-rewrite a wiki page. If a new source contradicts an older claim, note the contradiction inline rather than silently overwriting.

## Update the area index

Append an entry to `vault/areas/<area>/index.md` if you created a new wiki page. The index is a flat catalog — readers use it to discover what's in the area.

## Append to the area log

`vault/areas/<area>/log.md`:

```
## [2026-05-13 14:32] ingest | <user-slug> | <short subject>
- raw: raw/2026-05-13-<slug>.md
- wiki: [[areas/<area>/wiki/topics/<topic>]], [[areas/<area>/wiki/people/<person>]]
```

The log is greppable history — every operation in the area gets one line.

## Reply in chat

One sentence: `Filed under <area>. Updated: <page>, <page>.`

Don't paste back the wiki content. The operator sees it in their wiki client.

## Don't

- Don't ingest into an area without checking that the area's existing pages are consistent with the new content. If you're adding to a topic that already has a wiki page, read it first.
- Don't ingest the same source twice. Before writing the raw file, check `ls vault/areas/<area>/raw/ | grep <slug>` for an existing entry.
- Don't truncate the raw content to "save space." Disk is cheap; future re-synthesis depends on the full text.
