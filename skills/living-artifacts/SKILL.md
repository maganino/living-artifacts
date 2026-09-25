---
name: living-artifacts
description: Author a report or design document as an editable living artifact — the reader edits text in place, reorders and deletes blocks, tags sections with intents (expand, summarize, seed-next, for:sales), pins notes to specific blocks, and sets document-wide tone directives; every change lands in a structured journal Claude reads back as intent instead of guessing from prose comments. Use whenever a document will go through review rounds with a human, instead of publishing a plain static artifact and waiting for comments — and use it to READ BACK a living artifact the human has edited ("check my edits", "apply my feedback", "what did I change").
---

# Living artifacts

A plain artifact is read-only to its reader, so their only channel back is a
prose comment pinned to a passage — the narrowest possible signal, and half
its meaning lives in what it is pinned to. A living artifact gives the reader
the document itself: they edit the text, move the blocks, delete what is
noise, tag what should become the next thing, and say once how the whole page
should sound. Every one of those gestures is recorded as a typed operation, so
the next round starts from *what they meant*, not from a diff of the prose.

## Finding the tooling from any repo

This skill is normally used from *another* project, so its commands are never
relative. Resolve the tool repo once, from the skill's own symlink:

```sh
LA="$(dirname "$(dirname "$(readlink ~/.claude/skills/living-artifacts)")")"
node "$LA/runtime/build.mjs" build <doc>.json <out>.html
```

Every `runtime/...` path below means `$LA/runtime/...`. If `readlink` returns
nothing the skill was copied rather than symlinked — ask for the repo path
rather than guessing. If the tooling is genuinely absent, fall back to a plain
artifact and say so; the rules here are otherwise self-contained.

**The document's own files stay in the project you are working in**, not in the
tool repo: one folder per document, `<project>/docs/<name>/`, holding the seed
`<name>.doc.json` and a `shell/` folder with the built `index.html` and
`model.js`, rebuilt on every round so the reader can open it locally. Documents
from before 23 September 2026 also carry `<name>.editable.html` and the shared
copy `<name>.html`.
The artefact record lives in `<project>/tray/`. One folder per document is what
keeps the editable seed and the publishable copy visibly paired.
Only the runtime and the skill live in `$LA`.

## When to use

A document that will go through review rounds with a human reader: an analysis
component, a design proposal, a PRD, a findings report. Skip it for a
throwaway one-shot answer, and skip it for anything shared with people outside
the organization — see the sharing constraint below.

## Authoring

1. **Propose the sections and figures in chat first.** A living document does
   not exempt you from this — it makes it cheaper to act on, not unnecessary.
2. **Write the model, not the HTML.** A `*.doc.json` file per document: stable
   `docId`, a stable noun `title`, and `blocks[]` with stable ids. `docs/model.md`
   is the schema. Block ids are the addressing scheme for every later round —
   never renumber them, never reuse a dead one.
   **The exception is the `raw` block**, whose `html` is rendered verbatim, for a
   document that has to carry an artefact that *is* markup — an email's
   Outlook-safe table layout, a rendered mock. The reader cannot edit a raw
   block, only tag, note, move or delete it, so pair it with ordinary blocks
   holding the strings it was generated from: they edit those, you regenerate
   the markup. A document whose only block is `raw` is a static artifact with
   extra steps.
   **Diagrams are `mermaid` blocks and pictures are `figure` blocks** — never a
   `raw` block and never an image dropped into prose. See *Diagrams and
   pictures* below; the short version is that the model stores the source and
   the words, never the rendering.
3. **Build and publish.**
   ```sh
   node "$LA/runtime/build.mjs" build docs/<name>/<name>.doc.json /tmp/<name>.html
   ```
   Publish the built file with
   `capabilities: {artifact: {}, db: {}, downloads: {}}`.
   `artifact` lets the page save the reader's edits; `db` carries the journal;
   `downloads` is what the `⤓` full-copy button calls — leave it out and that
   button reports "Downloading is not available in this view", which is the
   no-lock-in escape hatch quietly not existing.
4. **Put the URL in your reply to the human**, on every publish and on every
   later republish. They cannot open what they cannot see, and a round that
   moves three surfaces needs three lines.
5. **Record the URL** in the doc JSON's `url` field, and open an artefact record
   in the project's `tray/` from `tray/artefact-record-template.md`
   (`type: artefact`, with `url`, `doc_id`, `source`, `status`). That record is
   what the cross-repo Obsidian dashboard reads — it is how the reader finds
   this document again from another repo next week. Every later round
   republishes to the recorded URL; a bare publish forks a second link.
6. **Watch it.** Publishing subscribes this session to the artifact. When the
   reader saves, the republish notification arrives here — that is the signal
   to read back, not a reason to act unasked.

## Where the document lives, and when

- **While it is being worked on, the published artifact is the only truth.**
  Every save mints an immutable version with a version picker, so an uncommitted
  document is not an unbacked one. Do not try to keep the repo in step round by
  round; it will drift and the drift is invisible.
- **The repo holds the `.doc.json` as the seed, plus one built copy** at
  `docs/<name>/<name>.editable.html`, rebuilt on every round so the pair is
  visible next to the seed. It is derivable, never edited by hand, and never the
  truth while the published page is under review. `dist/` stays gitignored.
- **When the reader says the document is done**: read the live artifact, pull
  its model down over the `.doc.json`
  (`node "$LA/runtime/build.mjs" extract <saved.html> <doc>.json`), export the final
  static copy, commit that, and set the artefact record to `done`.
- **The reader can always take a full copy themselves** — the `⤓` button saves
  the whole living document, editor and model included, to their disk. Say so
  if they ask about lock-in; it is the honest answer.

## Finishing: the shareable copy (superseded on 23 September 2026)

**Read this section as history.** In the fused form there is no separate shared
copy: the document's own read mode is the published page, and a reader with the
link gets it. What follows applies only to documents published before the
change, and to the two SSO artifacts kept for review. New documents follow
"Publishing a document: the fused form" at the end of this file.

A living document cannot be shared outside the organization, because declaring
`db` makes the artifact org-internal. The final hand-off is therefore always a
separate, plain copy.

**Two surfaces, one model.** The editable document and the shared copy are
rendered from the same blocks and deliberately do not look alike. The editable
one is a single column with no cards: a border between the reader and the text
is a border between them and the edit they came to make. The shared copy is
wider, tabbed, and laid out as cards, because it is read rather than driven.
Everything that is decoration rather than content belongs to the shared copy
only, and the rule for adding any of it is that it goes in `buildStatic`, never
in a document.

**The shared copy is tabbed, not folded.** One tab per top-level section, only
one open at a time, with its own switching script and no editor. The living
document folds because its reader is hunting for a section to edit; the reader
of a shared copy wants a short page per subject and then to stop. Links into a
closed tab open that tab, and printing reveals every panel. The cost to know
about: moving a section between tabs orphans any comment anchored to it, which
is tolerable on a copy that is replaced rather than edited.

```sh
node "$LA/runtime/build.mjs" export <doc>.json --tags dev,eng out.html  # those labels
node "$LA/runtime/build.mjs" export <doc>.json out.html                 # everything
```

It renders through the page's own renderer (booted headlessly), so the export
can never drift from what the reader saw. No editor, no model, no `db`.

Then **publish each shared version as its own artifact** — a new URL, not a
republish of the living one and not an overwrite of a previous share — declaring
no capabilities at all (`capabilities: {}`). Add a row to the artefact record's
*Shared versions* table: date, labels, URL, who it went to. The history of what
was shared with whom is worth more than a tidy URL list.

## Reading back — the whole point

On a republish notification, or on "check my edits" / "apply my feedback":

1. **Read the journal, not the page.** `read_db` on `docs/<docId>` gives the
   current `rev`, tag counts, open notes and active style directives.
   Then `db_op: "list"` the `docs/<docId>/journal` collection and take every
   entry with `rev` greater than the `lastReadRev` in `docs/<docId>/claude/state`.
   That document is yours — the page never writes it, so your bookmark
   survives the reader's saves. Write it back when you're done.
2. **Translate ops into a read-back, and wait.** Same gate as any review round:
   one row per operation, the block it names, and the concrete edit you believe
   it asks for. Then stop. Specifically:
   - An `edit` op carries `before` and `after`. The reader rewrote that block
     themselves — it is now theirs. Do not restyle it back toward your own
     voice; treat their wording as the target the rest of the document should
     match.
   - A `delete` op carries the text that left. Say what was deleted; if it was
     a load-bearing caveat, say so and ask where it should go instead of
     letting it vanish.
   - An `undo` / `redo` op means they reversed an edit from an earlier
     revision. The original op stays in its own revision — read the pair, and
     do not act on the edit that was undone.
   - A `note` op is a request pinned to a block — the structured replacement
     for a comment. It is not document content; act on it, then clear it.
   - A `move` op is an argument about order. Ask what the new order is meant to
     foreground before rewriting around it.
   - A `highlight` op with no tag is still signal: they singled that passage out
     and chose not to name why. Ask what it is about rather than ignoring it.
   - A `tag` op carrying `withBlocks` was applied to several blocks in one
     gesture; read them as one instruction, not N.
   - A `tag` op carrying a `quote` scopes the intent to that passage, not the
     block. Act on the passage; quote it back in the read-back so they can see
     you attached it to the right sentence. If the quote no longer appears in
     the block, say so rather than guessing at what replaced it.
3. **Pull the live model down first, every round.** `read` the artifact, then
   `extract` its model over the `.doc.json`, and build from that. The repo seed
   goes stale the moment the reader saves, and rebuilding from it silently
   reverts their work. This also carries `rev` forward, which matters: publishing
   an older `rev` makes the reader's next save reuse a journal entry number that
   already exists.
4. **Then edit the model** — the `*.doc.json`, never the built HTML — rebuild,
   and republish to the recorded URL. Expect the first publish after a reader's
   save to be refused until the saved version has been read in full; that is the
   guard working. It is also expensive on a long document, so it is worth asking
   the reader to finish a batch of edits rather than interleaving them with
   rounds.

**Agree the edit boundary before each round, and hold it.** Prepare everything
first, then ask the reader how far they have edited, capture that, and apply
while they stop editing. The alternative — reading the whole saved page again
because a save landed mid-round — costs several full reads of a long document
and buys nothing. Two rules make it work: the answer is a revision or a section,
not "I'm done"; and the round is published before they resume, so the next
boundary starts from a version both sides have seen.

**Where an op and the document disagree about a fact, check the source before
editing.** Follow the instruction either way, but report the discrepancy: a
reader correcting a number is often right for a reason they haven't stated.

## Sections, folding, and what a section is for

Headings are structure, not decoration. A heading owns every block until the
next heading of the same or higher level, and the runtime uses that three ways.

**The document opens as an outline.** Sections holding sub-sections are open,
leaf sections are closed, and each closed one reports what it holds — block
count, how many changed since the last round, how many are tagged, how many
carry a note. A reader sees the shape of the whole document first and opens one
section at a time. Nothing is hidden silently: a pinned note is announced by the
section that holds it. Folding is a view, like the filter — it never reaches the
model or the journal, and a filter always wins over a fold.

**Give every heading an `info`.** It is what the section is *for*, shown as an ⓘ
beside the title. When the document follows a template — a Jira spec, a PRD
format, a report house style — **use that template's own description, verbatim**,
rather than writing your own gloss: the person filling the section should read
the brief they would have read in the template. Where the template leaves a
section undescribed, leave the ⓘ off and say so, rather than inventing guidance
that will be mistaken for the template's.

**Badge the sections a template requires.** `badge` on a heading is a short
provenance label beside the title — `jira template` — so a reader can see at a
glance which sections the format demands and which ones this document added.
Badge the template's, leave yours bare; the contrast is the information.

**Keep the empty sections.** When a document follows a template, carry every
section the template names, even the ones this document has nothing for. They
render as a `<>` the reader can click to start writing. A missing section is
invisible and gets forgotten; an empty one is a visible decision, and the reader
is the one who should make it.

## Diagrams and pictures

A document that cannot hold a picture quietly becomes a document that argues
without one. Two block types carry them, and both keep the same bargain as
every other block: the reader edits *text*, never a rendering.

**`mermaid` — a diagram that is a view of its own source.** `text` holds the
mermaid; clicking the drawn diagram opens that text; editing it redraws. The
model never stores the SVG. Use it for anything a flowchart or a sequence
actually explains — a decision path, a handshake, a state machine — and write
the source as if it will be read, because on a page with no network it is what
shows. It degrades to the source rather than to a blank, with a line saying
why. A static export emits `<pre class="mermaid">` and lets the artifact viewer
draw it; do not load a library into an export.

The reader's route for a structural change is to mark up the diagram by hand
and send the photo back — redrawing from a sketch is your job. A wording change
they will simply make in the source, which is faster than describing it.

**`figure` — a picture whose words stay editable.** `src` is a picture you drew
outside the page and the reader cannot edit. `caption` sits under it. `labels`
is a map of *where on the picture* to *what it reads* — title, axes, legend,
an annotation. Those are what the reader owns: editing one is an ordinary
`edit` op and marks the block `touched`, which is a redraw request. Act on it
by regenerating the image and replacing `src`, never by arguing that the label
was fine.

Upload a real plot as an artifact asset and put the returned URL in `src`. A
data URI is fine for something small, but the model rides inside the page on
every save, so a heavy image is paid for on every write. A figure with a
caption and no `src` is a legitimate thing for either of you to add: it is how
a chart gets asked for.

**Neither is a `code` block.** A mermaid fence inside `code` renders as source
text, which is the failure this replaced.

## Answering a note, and marking what you changed

A note is a request, and the round is only legible if the answer is visible next
to it. When you act on one:

1. **Make the change.**
2. **Mark the words you changed**, not the block:
   `"touched": { "rev": <next>, "by": "claude", "spans": ["the new words"] }`.
   Let `runtime/mark-changes.mjs` write these from a diff against the copy the
   reader last reviewed (step 4 of the fused publishing procedure); set them by
   hand only for a single block. Omit `spans` only where you wrote or rewrote
   the whole block. This replaces
   the reader's own `touched` on that block, which is the point: their highlight
   giving way to yours is how they see the request was handled.
3. **Answer the note in place**: `"noteDone": "<one line on what you did>"`. The
   note keeps its text and renders as handled. Never delete the reader's note.
4. **Where you did not do what was asked**, say so in `noteDone` and put the
   reason on the page — a contradiction goes in the open decisions, not in a
   silent choice.
5. **The reply is the conversation. The document is not.** `noteDone` is the only
   place that addresses the reader: *you are right*, *I did not do this because*,
   *pick one and I will write it in*. The block itself is published, so it never
   argues with the reader, never says "the question you are asking", and never
   narrates the round. A caption is a caption. Where the round turned up a real
   contradiction, the document gets a neutral sentence and a pointer to the open
   decision that holds the options — the case for each option lives in that
   decision row, and the recommendation lives in the reply.

Cell notes work the same way: `cellNotesDone` keyed by the same cell. So do
passage notes, `noteDone` on the mark in `marks[]` that carries the `note`; the
mark keeps its quote and renders as handled.

**In a table, scope the span to the cell**: `{ "cell": "r2c1", "quote": "…" }`
instead of a bare quote. Two rows often end up saying the same short thing, and
a bare quote marks all of them when one was rewritten.

## Clearing marks: what the reader has already read

Your marks survive the reader's saves, so they accumulate until you clear them.
Clear them the way the reader actually reads.

When the reader asks a question or reports finishing a part of the document,
take everything from the start of the document up to that point as read, and
drop your marks there on the next round. A note they inserted **before** that
point is the exception: it is the thing they stopped at, so it and its marks
stay until it is answered. Keep every mark after that point untouched.

An answered note in a stretch they have read comes off with the marks, note and
answer together. The record of what changed lives in the changelog, not in a
growing pile of handled notes.

Clear your own marks from the previous round before setting new ones, or the
document accumulates purple until nothing reads as new. The reader's saves do
not clear them; only you do.

## Tags are intents, not labels

A tag says what to *do* with a block, or who it is *for*:

| Tag | Means |
|---|---|
| `expand` | this is too thin — go deeper here next round |
| `summarize` | compress this; it is more detail than the argument needs |
| `seed-next` | this becomes the starting point of the next document |
| `rewrite` | the content is right, the wording is not |
| `cut` | drop this, but ask before deleting |
| `verify` | re-derive this against the source; it looks wrong |
| `for:<audience>` | audience scoping — hand off to `audience-views` |

The list is open: a tag the reader invents just works. A tag applies to a whole
block, or — when the reader highlighted text first — to that passage alone,
carried as an anchored quote. Read tag counts from the registry document to find
what has accumulated across a document, and `seed-next` blocks and passages to
build the next one.

## The reader drives it directly

Hovering a block reveals its affordances; clicking it edits it and clicking away
keeps the edit; dragging its handle reorders. A **table** opens as a grid of
cells rather than as tab-separated text — enter walks down a column and makes a
new row at the bottom, `×` drops a row or a column, and `as text` still hands
back the TSV for pasting a table in from elsewhere. A **figure** opens as a
form over its caption and the words printed on the picture. Both make the same
bargain as the textarea: a click outside keeps the work, escape discards it.
A row left entirely empty is not kept. There is no select-then-act step
and no Apply step — v1 had both, and the first reader never saved a single edit,
filing five comments about the UI instead. If you extend the editor, keep that
bar: an affordance that must be discovered before it can be used will not be used.

Selecting text needs no mode: a click that ended a selection never opens the
editor, so a drag marks text and a `+ tag` chip appears at the end of it. (v1.3
shipped a highlighter toggle for this and it was redundant — the guard already
existed. Removed.) Naming a highlight is optional by design. Tags carry
per-document colours; the tag picker offers what the document already uses; the
bottom-bar filter is a view and never reaches the model; and **Build this
version** turns a filtered view into a plain shareable copy with no editor and
no `db` — which is the only form that can leave the organization.

## The style contract is standing instruction

`style.directives` — shown to the reader as **"How this document should be
written"**, because "style contract" meant nothing to the first one — is
document-level and *persistent*: "less hedging", "lead
with the number", "no summary paragraph at the end". Apply every active
directive on every regeneration, not just the round it was added. A muted
directive stays visible but stops applying — the reader muted it rather than
deleting it because they may want it back. When a directive conflicts with
something you would otherwise write, the directive wins; say so once rather
than quietly ignoring it.

## Marking what changed

The runtime handles this: an edited block carries `touched`, rendered as an
amber gutter that stays until your next rebuild (`mark-changes.mjs` clears it;
saves do not). Set `touched`
yourself on blocks *you* change in a regeneration, so the reader can find your
edits the same way you find theirs. Never accumulate marks across rounds — the
question is always "what changed since I last looked."

## This runtime is the template

There is no per-document HTML template to copy, and that is deliberate. A
template is forked every time a document is written, so an improvement never
reaches the documents already out there, and two documents written a month apart
stop looking alike. Here the look and the components live in the runtime, so a
change lands in every document on its next build.

The consequence for you: **when a document needs something the runtime does not
have, add it to the runtime.** A block type, a heading field, a component. Never
style a page. If you find yourself writing CSS into a document, the runtime is
missing something and the next document will need it too.

## Sections carry a label over a claim

`eyebrow` on a heading is the label, and `text` is what the section actually
argues: `PROBLEM DESCRIPTION` over "A customer switching a person off changes
nothing at Verbolia". The label says where the reader is, the heading says
something they could disagree with, and a reader who scans only the headings
gets the case rather than the filing system.

Use it where the section carries an argument. Leave the plain name on a
reference section: forcing a claim onto "Validation" or "Roles" produces noise,
and the mixed document reads better than the uniform one.

It edits as three lines in one box: the label, the heading, then a blank line
and the guidance.

The label earns its keep twice. In the shared copy each tab opens with a row of
jump links, one per section, and the label is what names them: a claim is a
sentence and makes a poor pill. So a section with a label gets a short, scannable
link and a heading that argues something, from one field each.

## The look is Verbolia's

The runtime ships the Verbolia design system as its default theme: Lexend,
black and white dominant, orange for what changed, red for danger, fully round
controls. Nothing to opt into — publish and it is on brand, in light and dark.
Four greys and two tints are interpolated because the brand palette has no step
there; everything else is a brand hex. If a document needs a different look,
change the tokens at the top of `runtime/la-style.css` rather than styling a
page: one theme, every document.

Charts drawn into a `figure` should use the brand accents on the marks and
`currentColor` for every word, so they follow the page's theme instead of being
a picture of one. Run the `dataviz` validator on any categorical palette first —
no pair of Verbolia accents passes colourblind separation as a two-series
palette, so single-series charts with direct labels are usually the honest
answer.

## Constraints worth knowing once

- **A `db` artifact cannot be shared publicly.** Declaring `db` makes the
  artifact organization-internal — every reader must be a signed-in member of
  the org. Anything going to a customer must be a **separate static export**
  published without `db` and without the editor, which is what `audience-views`
  already requires for a different reason.
- **Saving is automatic, through the files form.** The page publishes the whole
  `index.html` via `publish({'index.html': …})`, which does NOT reload the
  publishing view — that is what makes a debounced autosave usable. The model
  stays embedded in the page, so reading the document back is unaffected. Where
  the files form is not served the page falls back to `publish(html)`, which
  does reload every view.
- **A conflict is routine, and autosave makes it likelier.** If you republish
  while the reader has unsaved edits, their save rejects with `conflict` and
  their view reloads to yours.
  The runtime stashes their work in `sessionStorage` and shows it back to them,
  but the work is theirs to re-apply — so don't republish mid-review round
  without saying so.
- **Modal dialogs are dead** in a sandboxed artifact frame — `prompt()`,
  `alert()` and `confirm()` silently do nothing. Every input in the runtime is
  inline for this reason; keep it that way.
- **Drive it headlessly before publishing.** `node "$LA/runtime/preflight.mjs"
  <built>.html` drives the document you are about to publish;
  `node "$LA/runtime/smoke.mjs"` runs the full suite after any runtime change. A
  published page cannot be debugged after the fact.
- **Do not build a round while the reader is in the document.** Their save is
  refused rather than clobbered, which is the guard working — but then the
  live version has to be read in full and merged by hand. It has happened
  twice. Ask before starting a rework if they may be reading.
- **One store per artifact.** `db` is scoped to a single artifact and erased
  when it is deleted; no page can read another artifact's store. A view across
  documents therefore cannot be a page that queries them — it is the `tray/`
  records, or something Claude assembles.

## Composing with other skills

- `decompose-problem-artifacts` supplies the decomposition and the read-back
  gate; this skill supplies the mechanism the read-back reads from. One living
  artifact per component, corrected in place, exactly as that skill requires.
- `audience-views` owns `for:<audience>` tags and the static export. Tag as you
  write; export when sharing.
- Reading back a round is Reflection work in the `four-modes-of-ai-collaboration`
  sense; regenerating from the ops is Execution. Don't collapse them into one
  step — the read-back gate is where the round is won or lost.

## The desk-research template

A second read-mode layout, for research and analysis pages rather than
specifications: one long page, no tabs, a sticky nav with a scroll-spy
underline, the Verbolia wordmark in the header, stat tiles, charts and a
grouped inventory table. Select it with `"template": "desk-research"` on the
model. The house (PRD) layout stays the default. Added 24 September 2026 from
the vpage-triage desk-research pages; lives in `runtime/desk.css` and the
`dk*` functions in `runtime/la-runtime.js`.

How the model maps onto it:

- **Hero:** the first `para` is the lede; a table headed `Owner` is the meta
  row; a callout titled "The needs …" is the open-items box.
- **Level-2 headings** are groups: a labelled rule on the page and one nav
  entry. **Level-3 headings** are sections, `eyebrow` over the claim, `info`
  as the section note. A run of two or more **level-4 headings** in a section
  becomes a card grid.
- **Table variants** (still edited as a grid): `stats` → tiles from
  `[value, label, tone]`; `bars` → bar rows from `[label, value, note, tone]`;
  `tiers` → a numbered ladder from `[n, title, text, cost, note, tone, bar%]`;
  `donut` → a donut from `[label, value, tone]`. Tone is `ok`, `part`, `no`,
  `hot` or `mute`. A plain table gets a frozen header; a row with text only in
  its first cell is a group row; pills are read off the column name
  (`Detectable`, `Actually`, `Reversibility`, `Tier`, `Surface`, `Answers`,
  `Effort`, `In skill / code`).
- **Callouts:** `decision` parses `"D-1 · question. Open|Decided."` as its
  title, an `**Options:** (a) … (b) …` paragraph into chips and a
  `**Recommendation:** (a) …` paragraph into the filled chip; `warning` is the
  red-edged card; a title starting `Round` or containing `not part of` is the
  dashed round note.
- An ordered list in a section whose eyebrow starts `Recommendation` is the
  recommendation box; a list under an eyebrow starting `Source` is the footer.

Everything degrades to plain text when the reader edits a block into another
shape, so nothing here is a constraint on editing.

## Publishing a document: the fused form

One artifact is both the editor and the published page. There is no separate
shared copy any more and no exporter to run.

1. Build the shell: `node runtime/build.mjs shell <doc.json> <outdir>` writes
   `index.html`, `model.js`, and local copies of `runtime.js` and `style.css`
   so the folder opens from disk exactly as it will publish.
2. Publish with the Artifact tool: `file_path` the shell's `index.html`, `files`
   mapping `model.js` to the local file and `runtime.js` and `style.css` to
   `{artifact: <design-system url>, path: ...}`, so they are copied server side
   and never uploaded or read back. Declare `capabilities: {artifact: {},
   db: {}, downloads: true}` on the first publish.
   The design system is https://claude.ai/code/artifact/1e1428f7-4fab-494a-98f5-58eaec6b2a6d.
   After a runtime change: `node runtime/build.mjs ds <outdir>`, republish the
   design system from that folder, then republish each document's two shared
   files from it.
3. Read back: `Artifact read` on the document, then `build.mjs extract` on the
   saved `model.js` (the tool lists a multi-file artifact's files with
   `scope: "files"` and saves one with `path`). The model file is the only file
   that changes between the reader's saves, and the only one to read. Keep a
   copy of it: it is the "what the reader saw" side of the next diff.
4. Edit the model, then mark what changed by diff, never by hand:
   `node runtime/mark-changes.mjs <last-seen.doc.json> <doc.json> --rev <next>`
   writes word-level `touched.spans` per surface (a table cell as
   `{cell, quote}`), clears stale claude marks and the reader's own amber
   marks (their edits were read in this round). The `last-seen` file is the
   copy the reader last *reviewed*, not necessarily the one they last saved
   from: a save that only records control trials leaves the unread marks due.
5. Republish: rebuild the shell, publish `index.html` with
   `files: {"model.js": ...}` only. The two shared files are carried over. A
   refusal means the reader saved in between: read the live `model.js`, merge
   their ops (`layout`, `variant`, edits, notes, journal entries past your rev)
   into the model, set `rev` above theirs, and publish again.

The writer edits in the published layout itself: hover a block for its chrome
(`tag`, `note`, delete), click to edit in place, drag to move, add at the end
of a section. `Edit | Preview` in the bar is one toggle; switching keeps the
scroll position. `Outline` is the flat block list for restructuring. A reader
with the link gets the page and nothing else. Give the reader the same URL as
the writer: there is one.

Notes are granular: a block, a table cell, a flow step, a scope item, a metric
card, or a selected passage (`+ note` on the selection, stored as
`marks[].note`). Moving a level-3 or level-4 heading takes its blocks with it;
a level-2 heading, a tab, moves alone; a drop lands before or after the target
by the side the pointer is on, previewed live with a translucent copy under
the pointer, the origin left as a hole until the drop; a card's middle means
inside it, its edges beside it, where a plain block becomes a new card with a
heading of its own. Width (`layout.w`) is set by dragging a block's or a
card's right edge, snapped to quarter, third, half, two thirds or full, the
block growing downward to keep its content;
look (`variant`) is not on the chrome, the reader asks in a note and Claude
sets it in the model. `+ Add` in the bar names a type, then a click places it
anywhere; Escape on a block just added and left empty removes it again.
