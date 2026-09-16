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
  "marks": [{ "tag": "verify", "quote": "94.2% of indexable URLs" },
             { "quote": "three bot-registry IDs" }],   // tag is OPTIONAL
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

`tags` scope the whole block. `marks` scope a **passage inside** it — added by
highlighting text on the page. A mark is anchored by its `quote`, never by a
character offset: an offset breaks the moment anything above it is edited,
whereas a quote either still matches or is reported as no longer present.
Rendering wraps the first match in `<mark>`; a mark whose quote no longer
appears is kept in the model and simply stops highlighting, so Claude can see
that the passage it referred to has been rewritten.

**Quotes snap to word boundaries before they are stored.** A dragged selection
lands wherever the pointer did, so real highlights arrive mid-word — the first
reader's were `"ng itself…"` and `"t witho"`. Nobody means that, it renders as a
broken mark, and it anchors on a fragment. The quote grows outward to whole
words first.

## Style directives

Document-level and persistent — standing instructions, applied on every
regeneration, not just the round they were added.

```jsonc
{ "id": "s-2", "text": "lead with the number, not the caveat", "rev": 4, "active": true }
```

`active: false` is **muted, not deleted**: the reader kept it visible because
they may want it back.

Tag colours live at document level in `tagColors: {tag: hue}` — assigned on first
use and then fixed, so a tag looks the same every time the reader sees it, and
Claude reads the same mapping. An untagged highlight renders neutral.

Filter state is deliberately **not** in the model. Filtering is a view: it hides
blocks on one screen and must never reach the document or the journal.

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
| `highlight` / `unhighlight` | `block`, `quote`, `tag?` | they singled out a passage — signal even with no tag on it |
| `tag` / `untag` | `block`, `tag`, `quote?`, `withBlocks?` | an intent — for the block, for a passage (`quote`), or for each of several blocks at once (`withBlocks`) |
| `note` | `block`, `text` | a request pinned to a block |
| `style` | `action`, `text` | a standing instruction for the whole document |
| `undo` / `redo` | `undid` | they reversed an op from an EARLIER revision — the original edit stays in its own revision, so the history stays true |

## Storage layout

| Path | Written by | Holds |
|---|---|---|
| `<script id="la-model">` | page + build | the canonical model |
| `docs/<docId>` | page | registry: rev, tag counts, open notes, active directives |
| `docs/<docId>/journal/r<n>` | page | one document per revision, not per op |
| `docs/<docId>/claude/state` | **Claude only** | `lastReadRev` — the page never touches it |

Undo only reaches the journal when it reverses something already saved. An op
undone inside the same unsaved round is simply dropped, so a round of trial and
error does not arrive as noise.

One journal document per *revision* is deliberate: an artifact's database holds
at most 5,000 documents and the store warns against one-document-per-event
streams. The page also embeds the last 40 revisions in the model, so the
journal survives `db` being unavailable.

`docs/<docId>` is a full `set()` on every save, which is why Claude's bookmark
lives in a separate document it owns — a merge would be clobbered.
