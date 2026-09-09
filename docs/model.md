# The document model

The truth of a living artifact is the JSON in `<script id="la-model">`. The DOM
is a rendering of it and is **never read back** — no `innerHTML` scraping, no
contenteditable soup. This is what makes an edit legible as intent rather than
as a text diff.

## Document

```jsonc
{
  "v": 1,
  "docId": "traffic-completeness",   // stable; also a db path segment:
                                     // [A-Za-z0-9_-.~:@+], ≤200 bytes
  "title": "Data Completeness & Correctness",  // stable noun, not a step label
  "thread": "traffic-opportunities",  // optional grouping for the index
  "component": "Completeness",        // optional; decompose-problem-artifacts
  "url": "https://claude.ai/...",     // recorded on first publish, reused after
  "rev": 7,                           // increments on every save
  "updated": "3 edits by viewer · 2026-09-09",
  "style":   { "directives": [ /* see below */ ] },
  "blocks":  [ /* see below */ ],
  "journal": [ /* last 40 revisions, embedded as a db fallback */ ]
}
```

## Blocks

Ordered. Every block has a **stable id** — the addressing scheme for every
later round. Never renumber, never reuse a dead id.

```jsonc
{
  "id": "b-a1f3",
  "type": "para",          // heading | para | list | table | code | callout | divider
  "tags": ["expand", "for:sales"],
  "author": "claude",      // "viewer" once the human has edited it
  "note": "recheck this against the June cohort",  // pinned request, not content
  "touched": { "rev": 7, "by": "viewer" }          // only the latest revision
}
```

Per-type content fields:

| type | fields | textarea form |
|---|---|---|
| `heading` | `text`, `level` (2 or 3) | the text |
| `para` | `text` | the text |
| `list` | `items[]`, `ordered` | one item per line |
| `table` | `head[]`, `rows[][]` | TSV, first line is the header |
| `code` | `text`, `lang` | the text |
| `callout` | `title`, `text` | title, blank line, body |
| `divider` | — | not editable |

`text` and `items` hold **plain text** with a deliberately tiny inline subset —
`**bold**`, `*italic*`, `` `code` ``, `[label](url)`. Nothing else. Keeping the
model plain-text is what lets a textarea be the editor and a diff be readable.

## Style directives

Document-level and persistent — standing instructions, applied on every
regeneration, not just the round they were added.

```jsonc
{ "id": "s-2", "text": "lead with the number, not the caveat", "rev": 4, "active": true }
```

`active: false` is **muted, not deleted**: the reader kept it visible because
they may want it back.

## Journal

One entry per revision, holding every op in it.

```jsonc
{ "rev": 7, "at": "2026-09-09T14:02:11Z", "by": "viewer", "ops": [ … ] }
```

| op | fields | reads as |
|---|---|---|
| `edit` | `block`, `before`, `after` | they rewrote it — their wording is now the target |
| `insert` | `block`, `type`, `at` | they added something you didn't write |
| `delete` | `block`, `type`, `text` | text that left — report it, never lose it silently |
| `move` | `block`, `from`, `to` | an argument about order |
| `tag` / `untag` | `block`, `tag` | an intent for that block |
| `note` | `block`, `text` | a request pinned to a block |
| `style` | `action`, `text` | a standing instruction for the whole document |

## Storage layout

| Path | Written by | Holds |
|---|---|---|
| `<script id="la-model">` | page + build | the canonical model |
| `docs/<docId>` | page | registry: rev, tag counts, open notes, active directives |
| `docs/<docId>/journal/r<n>` | page | one document per revision, not per op |
| `docs/<docId>/claude/state` | **Claude only** | `lastReadRev` — the page never touches it |

One journal document per *revision* is deliberate: an artifact's database holds
at most 5,000 documents and the store warns against one-document-per-event
streams. The page also embeds the last 40 revisions in the model, so the
journal survives `db` being unavailable.

`docs/<docId>` is a full `set()` on every save, which is why Claude's bookmark
lives in a separate document it owns — a merge would be clobbered.
