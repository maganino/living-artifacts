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
  "template": "desk-research",        // optional; read-mode layout, default is the house (PRD) layout
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
  "type": "para",          // heading | para | list | table | code | callout | divider | raw
  "tags": ["expand", "for:sales"],
  "author": "claude",      // "viewer" once the human has edited it
  "marks": [{ "tag": "verify", "quote": "94.2% of indexable URLs" },
             { "quote": "three bot-registry IDs" }],   // tag is OPTIONAL
  "note": "recheck this against the June cohort",  // pinned request, not content
  "noteDone": "Rechecked; the June figure stands.", // Claude's answer, set when it acts
  "cellNotes": { "r3c1": "weeks of what?" },        // TABLES only: a note on ONE cell
  "cellNotesDone": { "r3c1": "said calendar weeks" },
  "touched": { "rev": 7, "by": "viewer" }          // amber until Claude's next rebuild
  // or, when Claude answered a note:
  // "touched": { "rev": 8, "by": "claude", "spans": ["calendar weeks"] }
}
```

Per-type content fields:

| type | fields | how the reader edits it |
|---|---|---|
| `heading` | `text`, `level` (2, 3 or 4), `info`, `badge` | textarea — the text, blank line, the `info` |
| `para` | `text` | textarea — the text |
| `list` | `items[]`, `ordered` | textarea — one item per line |
| `table` | `head[]`, `rows[][]`, `cellNotes{}` | **a grid**: a heading input per column, a body cell that wraps and grows to its text; Enter moves down a row; a cell never holds a newline; `as text` falls back to TSV |
| `code` | `text`, `lang` | textarea — the text |
| `callout` | `title`, `text` | textarea — title, blank line, body |
| `mermaid` | `text` | textarea — the diagram source |
| `figure` | `src`, `alt`, `caption`, `labels{}` | **a form** — caption, alt and the words on the picture |
| `divider` | — | not editable |
| `raw` | `html`, `label` | not editable |

Every editor, whatever its shape, ends in **one source string and one `edit`
op** carrying `before` and `after`. A grid serialises back to exactly the TSV
the textarea produced; a figure form to `key: value` lines. That is deliberate:
a new way to edit must never become a new kind of operation, or undo and the
read-back have to learn about it.

### `heading` — sections, folding and guidance

Headings are the document's structure, and the runtime reads three things off
them.

**They delimit sections.** A heading owns every block after it until the next
heading of the same or higher level. The model stays flat — nesting the blocks
would break drag-to-reorder, which walks one list.

**Sections fold, and folding is a view.** It never reaches the model or the
journal, exactly like the filter. A document opens as an **outline**: a section
holding sub-sections is open (it has nothing of its own to hide), every leaf
section is closed. So the first screen is every section name with what it is
holding — `7 blocks · 3 changed · 1 tagged · 1 note`, or `empty`. A closed
section never hides a pinned note or a tag silently; the summary says they are
there. `Collapse ▾` closes the deepest open level, one level per click, until only
the top-level headings remain, and `Expand ▸` opens the shallowest closed level;
shift-click on either does everything at once, and applying a filter opens the document and leaves it open —
asking to see something must never hide what was found.

**`info` is what the section is FOR.** Optional, plain text, shown as an ⓘ
beside the heading: hover for the wording, click to open it inline. Put the
*template's own description* there when a document follows one — a PRD
following a Jira spec template carries that template's words, so the person
filling a section reads the brief for it rather than guessing. It is edited as
the heading's second paragraph, the same shape a `callout` already uses:

```
Adoption

How can we facilitate adoption?
```

**`badge` is provenance.** A short label shown beside the heading — `jira
template`, `from the RFC`, `carried over`. It says where the section came from,
so a reader can tell the sections a template requires from the ones this
document invented. It is set when the document is generated and the reader's
edits to the title or the guidance never touch it.

**An empty section keeps its heading.** A section with no blocks renders a `<>`
placeholder; clicking it starts a block there, ready to type. That is the point:
when a document follows a template, every section the template names stays
visible whether or not it has been written, so leaving one empty stays a
decision rather than an oversight.

### `mermaid`

`text` is the diagram source and the only thing stored — never the drawn SVG.
The page loads mermaid from cdnjs on demand, and only when a document actually
holds a diagram. It is the runtime's single external dependency, so it
**degrades to the source text rather than to a blank**: no network, or a syntax
error mid-edit, and the reader still sees what the diagram says, with a line
explaining why. Clicking the diagram opens that source like any other block.

A static export carries no runtime, so it emits `<pre class="mermaid">`. Some
artifact surfaces draw such a block themselves and some leave it as text, and a
shared copy is read in whichever one the reader opens, so the export's own
script loads mermaid a beat after the page and draws only the blocks still
sitting there as source. Where the surface already drew them it finds nothing,
and where the script cannot load the source stays readable. Mina found this on
21 September 2026: a sequence diagram in the published PRD was a wall of source.

### `figure`

The picture is authored outside the page and is **not editable by the reader**.
What the reader owns is every word printed on it:

```jsonc
{
  "id": "b-providers", "type": "figure",
  "src": "https://…/asset.png",        // or a data: URI for something small
  "alt": "Identity providers by number of identities",
  "caption": "What the customers run",  // rendered under the picture
  "labels": {                            // rendered nowhere — they live IN the picture
    "title": "Identity providers in the customer base",
    "y axis": "Identities",
    "x axis": "Provider"
  }
}
```

A label's **name** says where on the picture it sits; its **value** is what it
reads. Editing either records an ordinary `edit` op and marks the block
`touched` — which is the reader asking for a redraw, not a change to the image.
Redrawing is Claude's job on the next round: regenerate the picture from the new
labels and replace `src`.

For a real plot, upload the image as an artifact asset and put the returned URL
in `src`; a data URI is fine for something small, but the model is embedded in
the page and republished on every save, so a 300 KB PNG is paid for on every
keystroke-debounced write.

A figure with a caption and **no `src`** is legitimate: it is how the reader
asks for a chart that does not exist yet.

`text` and `items` hold **plain text** with a deliberately tiny inline subset —
`**bold**`, `*italic*`, `` `code` ``, `[label](url)`. Nothing else. Keeping the
model plain-text is what lets a textarea be the editor and a diff be readable.

## `raw` — the one block the runtime does not own

Every other type holds plain text and the runtime decides the markup. `raw`
inverts that: `html` is rendered verbatim. It exists so a document can carry an
artefact that **is** markup — an email's Outlook-safe table layout, a rendered
mock — rather than a description of one, which is all a plain-text block could
ever be.

What follows from that, and none of it is negotiable:

- **Claude authors it; the reader does not.** No textarea, and `raw` is absent
  from the add row. Parsing arbitrary markup back into a model is not something
  this runtime does, so an edit could not be read back as intent — which is the
  whole premise.
- **`marks` do not apply inside it.** Highlighting anchors by quote against
  plain text; there is no plain text here. Tags, notes, moves and deletes all
  still work, and they are the channel for a change to a raw block: the reader
  says what should change, Claude regenerates the markup.
- **`label` names it** for the drag handle and screen readers, because the
  alternative is reading out a wall of markup.
- **The document's own CSS is reset inside it** (`.la-raw` in the stylesheet)
  and it renders in a light colour-scheme. A raw block's content brings its own
  colours; `--ink` leaking in from dark mode would recolour half of it.
- **It reaches the static export whole**, because the export renders through
  the page's own `renderBody`.

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

## `touched` — who moved this, and which words

`touched` is how a block says it is not what the reader last saw. `by` decides
how it renders and how long it lives:

| `by` | Renders as | Cleared by |
|---|---|---|
| `viewer` | the purple gutter bar | the reader's next save |
| `claude` with `spans[]` | a purple mark around each span, word level | Claude's next round |
| `claude` with no `spans` | the whole block washed purple | Claude's next round |

A `span` is a quote, anchored the same way a `mark` is: it either still matches
the text or it silently stops highlighting. Claude sets these when it acts on a
note, and setting them REPLACES the reader's own `touched` on that block — that
replacement is the signal that the request was handled, so the reader is not
left hunting for what moved.

In a table, a span may instead be written `{ "cell": "r2c1", "quote": "…" }` and
then marks that one cell only. Two rows often end up saying the same short thing
(`Excluded on purpose`, `Dev`), and a plain quote would mark every one of them
when a single cell was rewritten. Plain-string spans still apply everywhere, so
the two forms mix freely in one `spans` array.

Claude's marks survive the reader's saves on purpose. A reader working through
a 200-block document edits one paragraph and must not lose the highlighting on
the twenty blocks they were about to review.

Neither the marks nor the notes reach the shared copy. They are working state.

## `cellNotes` — a note pinned to one cell

On a wide table "this is wrong" is not something anyone can act on, so a table
block carries notes keyed by cell:

```jsonc
"cellNotes":     { "h2": "rename this column", "r3c1": "weeks of what?" },
"cellNotesDone": { "r3c1": "said calendar weeks, and named who owns it" }
```

`h<col>` is a heading cell, `r<row>c<col>` a body cell, both zero-based. The note
renders inside its own cell, and every cell shows a pin on hover to add one. The
gesture lives in the read view; the grid editor only displays them, because that
editor is for values.

Positions move, so the grid editor moves the notes with them: deleting a row or
a column drops the notes on it and shifts the rest. An edit made through
`as text` can still strand one, and a stranded note keeps rendering against
whatever now sits in that cell — check them after restructuring a table.

## Role chips — an owner column is a function, not a person

A table cell that is nothing but role names renders as coloured chips, one fixed
hue per role across every document, so an owner column is read by colour before
it is read by word. The roles are `PM`, `Dev`, `IT`, `Sec`, `Legal`, `Sales`,
`CS`, `Design`, `Customer`.

Two gates, both deliberately strict, because a false chip paints a word in the
middle of a sentence:

- **The column decides.** Only a header reading `Owner`, `Owners`, `Agreed with`,
  `Answered by`, `Raised by`, `Decided by`, `Accountable` or `Responsible` gets
  chips. A `Who` column in a flow table names the actor in a step and stays
  words.
- **The whole cell, or nothing.** Every part of the cell, split on commas,
  slashes, `and`, `with` and the like, has to be a role. One short status word
  may sit in front (`Not yet. PM, CS`), because that is how an Agreed-with
  column is written.

Nothing in the model records this: it is a rendering rule over ordinary cell
text, so the same cells chip in the shared copy, which carries its own copy of
the rule in `export_prd_artifact.py`.

Names are not banned. A role says who has to answer; a name and a date next to a
claim is provenance, and that belongs in the prose cell, not the owner column.

## `methods` — how a figure was obtained

A figure that supports a decision is written inline as `[949 identities](=m-base)`
and resolves against a `methods` map on the document:

```jsonc
"methods": {
  "m-base": {
    "title": "949 identities across 234 domains",
    "source": "The backoffice replica",
    "steps": ["Join UsersWebsites to User…", "Count distinct User.Id per domain."],
    "fields": "UsersWebsites.UserId, User.Login, User.Active",
    "excluded": "verbolia.com, consumer mailboxes, agencies, test-only domains",
    "date": "2026-09-04",
    "confidence": "Measured. An identity holds any grant, on or off."
  }
}
```

The figure renders marked in place, so a reader sees which numbers are sourced,
and opens its method on click. One is open at a time. An id with no entry
renders as plain text: an unresolved citation should read as an ordinary number,
never as a broken marker.

The popover is built from **spans only**. A citation sits inside a paragraph,
and the HTML parser closes that paragraph the moment it meets a `<dl>` or an
`<ol>`, which tears the sentence in half and spills the panel into the page.
`display: grid` on a span does the same job and stays phrasing content.

Both surfaces carry it: the runtime renders `la-cite`, and the PRD exporter
renders the same thing as `cite` in the house template.

## The fused form: one artifact, two modes, a shared runtime

Since 23 September 2026 a living document is one artifact that is both the
editor and the published page.

**Edit in the page.** A writer opens the published layout and edits there:
hover a block for its handle and actions, click it to open its editor where it
stands, drag it to move it, add a block at the end of any section. Notes, tags,
change marks and the internal sections are shown to the writer in that layout.
Two other ways to look at the same model sit in the bar. `Edit | Preview` is
one toggle, two buttons of the same style: `Preview` is the reader's page with
nothing on it, and the bar shrinks to the toggle so the writer can flip back.
`Outline` is the flat block list with folding, for moving blocks across the
whole document. Switching keeps the scroll position, so the effect of an edit
is visible where the writer is looking. The choice is remembered per document
in `localStorage`.
Anyone without write rights only ever gets the reader's page, with no bar and no
pill: it is rendered from the model with `inline()` alone, so nothing that is
working state can reach it.

In the page every editable block is wrapped in `.la-blk[data-block-id]`; a
reader's page has no wrappers at all. Composite components stay editable at the
block that drives them: a flow is its `Step | Who | What happens` table, a
scope card row is its table, a context card is its heading with its own blocks
inside. The footer repeats annex blocks and is never wrapped, so no id appears
twice.

**Read mode is the exporter, ported.** The same house class names the PRD
exporter used, so `house.css` (the template's stylesheet, scoped under
`.house`) is the one stylesheet for the published look. The same conventions:
a level-2 heading is a tab, a level-3 heading a section with its eyebrow, a
`Step | Who | What happens` table a flow, a level-4 heading under Purpose a
context card, a bold-titled paragraph a scenario card, an `internal` tag a
section that is left out.

**Layout and look from the design system.** `layout.w` on a block is `full`,
`half`, `third` or `two-thirds`: read mode packs consecutive narrow blocks on a
12-column grid. `variant` on a callout is `note`, `warning`, `decision`,
`design`, `excluded` or `deferred`; on a table `plain` or `striped`; on a list
`bullets` or `checks`. Since 23 September 2026 neither is on the block's
chrome: Mina tried the cycling buttons and found the effect unclear, so the
chrome is `tag`, `note` and delete only. The values stay in the model and in
read mode, and Claude sets them on request (a note saying "make this half
width" is enough); the `layout` and `variant` ops remain for that. There is no
colour picker, and there will not be one.

**Notes are granular.** A note can sit on a block (`note`), on one table cell
(`cellNotes`), on one step of a flow, one scope item or one metric (the same
`cellNotes` keyed `r{i}c2` for a step and `r{i}c0` for an item, since each is a
row of the block that drives it), or on a passage: select words inside a block,
choose `+ note`, and the runtime records a mark with `note` set
(`marks: [{ quote, note, noteDone }]`, journal op `note` with a `quote`).
A passage note renders as `✎` on the highlighted words and `✓` once answered,
and `renderMeta` lists it under the block with its text. Answer it with
`noteDone` on the mark, as for the other two kinds.

**Moves are section-aware.** Moving a level-3 or level-4 heading, by the arrows
or by drag, takes every block it owns until the next heading of the same or a
higher level (`rangeOf`). A level-2 heading is a tab and moves alone, or the
first tab would drag the whole document. A drop has a zone: on an ordinary
block, past its middle (right of it when it shares a row) means after it,
otherwise before; on a card, the left and right quarters mean beside it and
the middle means inside it, last; on a section heading, its lower half means
first in the section. Dropping always before the target made a one-step move
down look like nothing had happened. One limit of the flat model: every plain
block after a card heading belongs to that card, so a paragraph dropped on a
card's right edge joins that card, last, and only a card can stand beside a
card. Cards inside a card group are blocks like any other, so they move the
same way.

**A move is previewed live, from the model.** While the handle is held, a
translucent copy of the block follows the pointer and the block itself (with
the blocks a heading owns) sits faded at the place it would land, so the
effect on everything around it is visible before the drop. The place is
derived from the model index of the drop (`destIndexFor`, then
`previewAtIndex`: after the wrapper of the block that will precede it, or
first inside the card or section whose heading precedes it), not from where
the pointer is, so the preview never shows a layout the drop would not
produce. The place the block came from stays empty meanwhile, a dashed hole
of the same size, and the block keeps its own width class wherever it is
shown. This is DOM only: the model moves on the drop, and `render()` puts the
page back if the drag is cancelled.

**A card lands between cards.** A heading dragged (a card, a section) owns
everything up to the next heading of its rank, so dropped between two
paragraphs it would swallow the ones after it. `destIndexFor` snaps a heading
to the next boundary instead: before the next card or section heading, or the
end of the document. Dropped on the intro paragraphs of a section, a card
therefore becomes the first card of that section's strip, which is what the
preview shows. In a section that renders level-4 headings as sub-heads rather
than cards, a moved card renders as a sub-head with its blocks.

**The card's edges are read on the card.** Inside a card the blocks fill it
edge to edge, so a pointer on the card's left or right quarter is over an
inner block; `dropTargetAt` still reads those quarters as the card's own
"beside" zones. Without this the beside zones were a 22px padding strip.

**Beside a card means as a card.** A plain block dropped or placed on the left
or right quarter of a card gets a heading of the neighbours' level in front of
it (`newCardAround`, titled from a table's first column head or "New card"),
recorded with the move as one undo, so a table can leave the section grid and
stand in the strip as a card of its own. Dropped in the middle it joins that
card, last.

**Adding is placing.** `+ Add` in the bar lists the block types; picking one
puts a dashed placeholder under the pointer, previewed at the same drop
positions as a move (between blocks, inside a card, at the end of a section),
and a click inserts the block there and opens its editor. Escape cancels. The
per-section add rows are gone: they could only add at the end of a section,
which is not where a writer standing before a divider wanted the block.

**Width comes from the right edge.** A block in a section grid, and a card in
a card group (`.context-strip`, `.grid-2`, both 12-column grids now, cards
spanning 4 and 6 by default), carries a resize edge on its right; dragging it
snaps to `quarter`, `third`, `half`, `two-thirds` or `full` and records a
`layout` op. A card set to `full` keeps `layout.w: "full"`, since its natural
width is narrower. Scope cards, flow steps and metrics are rows of one table,
not blocks, and have no edge. A
narrower block grows downward: text wraps, a picture or diagram scales with
it (`max-width: 100%; height: auto`), a table scrolls inside its frame. There
is no refusal any more: the overflow check that refused a width was tripped
by the resize edge itself, which overflows the block by design, so every
narrowing was refused and read as a snap-back. Left and right arrows on the
focused edge do the same one step at a time.

**Escape on a fresh block discards it.** A block added from the add row and
never written into goes away with its insert op, as one undo, when the writer
presses Escape. Once anything was typed, Escape discards the typing only, as
in every other editor.

**The measure survives the wrapper.** `.blocks > p` caps a paragraph at 82
characters; in the page the paragraph sits inside `.la-blk`, so the same cap
is repeated for `.blocks > .la-blk > p` (and lists). Without it every
paragraph ran the full width in edit mode and the page looked to have lost its
margins.

**Cell pins in the page.** A house table cell is positioned and keeps 36px at
its right for the pin, so the `+` shows on hover in the page as it does in the
outline grid.

**Two colours, both word level.** A block Claude changed carries a purple
gutter and purple word marks; a block the reader changed since carries an
amber gutter and amber word marks (`data-touched="claude" | "viewer"`,
`mark.la-chg.mine`). The reader's spans are computed in the page on commit,
with the same LCS as `mark-changes.mjs` (`wordRuns`), per cell for a table; a
move, a tag or a width change gives the gutter alone. Marks survive saves. A
rebuild clears both: `mark-changes.mjs` drops the reader's marks, since the
round that rebuilt read their journal, and replaces Claude's with the new
diff. `--keep-viewer` keeps theirs.

**A row of cards keeps to the page width.** Dropping or placing a card into a
card grid (`.context-strip`, `.grid-2`) whose spans already fill 12 columns
narrows every card in it, the newcomer included, to the width for that count
(2 half, 3 third, 4 quarter), previewed while the pointer is down and recorded
as `layout` ops in the same undo as the move. The fit is measured on the real
widths after the preview classes are taken off, and the hole a drag leaves
never counts (it hides while the card is previewed in its own row), so a move
within a row leaves every other card's width alone. Narrowing a card by its edge
never widens its neighbours: the space stays empty, which is the point of
narrowing. The section grid does not fit rows: there a half-width block leaves
the rest of its row empty and the next block starts a new row.

**Marks are word level, by diff.** After each round `mark-changes.mjs` compares
the model the reader last saw with the one about to be published and writes
`touched.spans` from an LCS word diff, per surface: a table cell becomes
`{ cell, quote }`, a list item, a callout title or text, a figure caption and a
heading each their own quote. A new block, or a changed diagram, is marked
whole. Stale claude marks are cleared in the same pass.

**The shared runtime.** A document is `index.html`, a twelve-line shell, plus
`model.js`, which sets `window.__laModel`. `runtime.js` and `style.css` are the
design system's files, copied server side into the document at publish, so
they ship once and are never read back. The page's own save rewrites only
`model.js`; the files form of the artifact capability carries every other file
over unchanged. `build.mjs shell` writes the four files locally so the folder
opens from disk exactly as it publishes; `build.mjs ds` writes the design
system's files; `build.mjs extract` reads a model back from either a page or a
`model.js`.

**Never write the hash during the opening render.** A fragment written while
the page is still loading makes the browser scroll to it as part of load, and
every document opened a screen down with the hero out of sight. The hash is
written on a click only.

**A citation is a span.** A `<button>` is a box and cannot wrap across lines
with the sentence it sits in, so a long cited figure centred itself in its own
block. `role="button"` and `tabindex` keep it a control; Enter and Space open
it.
