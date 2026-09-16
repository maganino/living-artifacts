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

Tooling lives in the repo this skill ships from (`runtime/`, `docs/model.md`).
The rules below are self-contained; don't go looking for those files if they
aren't there — fall back to a plain artifact and say so.

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
3. **Build and publish.**
   ```
   node runtime/build.mjs build examples/<name>.doc.json
   ```
   Publish the built file with `capabilities: {artifact: {}, db: {}}`.
   `artifact` lets the page save the reader's edits; `db` carries the journal.
4. **Record the URL** in the doc JSON's `url` field, and open an artefact record
   in the project's `tray/` from `tray/artefact-record-template.md`
   (`type: artefact`, with `url`, `doc_id`, `source`, `status`). That record is
   what the cross-repo Obsidian dashboard reads — it is how the reader finds
   this document again from another repo next week. Every later round
   republishes to the recorded URL; a bare publish forks a second link.
5. **Watch it.** Publishing subscribes this session to the artifact. When the
   reader saves, the republish notification arrives here — that is the signal
   to read back, not a reason to act unasked.

## Where the document lives, and when

- **While it is being worked on, the published artifact is the only truth.**
  Every save mints an immutable version with a version picker, so an uncommitted
  document is not an unbacked one. Do not try to keep the repo in step round by
  round; it will drift and the drift is invisible.
- **The repo holds the `.doc.json` as the seed, and nothing built.** `dist/` is
  gitignored: it is the model plus inlined CSS and JS, fully derivable.
- **When the reader says the document is done**: read the live artifact, pull
  its model down over the `.doc.json`
  (`node runtime/build.mjs extract <saved.html> <doc>.json`), export the final
  static copy, commit that, and set the artefact record to `done`.
- **The reader can always take a full copy themselves** — the `⤓` button saves
  the whole living document, editor and model included, to their disk. Say so
  if they ask about lock-in; it is the honest answer.

## Finishing: the shareable copy

A living document cannot be shared outside the organization, because declaring
`db` makes the artifact org-internal. The final hand-off is therefore always a
separate, plain copy:

```
node runtime/build.mjs export <doc>.json --tags dev,eng   # only those labels
node runtime/build.mjs export <doc>.json                  # everything
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
3. **Then edit the model** — the `*.doc.json`, never the built HTML — rebuild,
   and republish to the recorded URL.

**Where an op and the document disagree about a fact, check the source before
editing.** Follow the instruction either way, but report the discrepancy: a
reader correcting a number is often right for a reason they haven't stated.

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
keeps the edit; dragging its handle reorders. There is no select-then-act step
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
amber gutter, and each save clears the previous round's marks. Set `touched`
yourself on blocks *you* change in a regeneration, so the reader can find your
edits the same way you find theirs. Never accumulate marks across rounds — the
question is always "what changed since I last looked."

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
- **Drive it headlessly before publishing.** `node runtime/preflight.mjs
  dist/<name>.html` drives the document you are about to publish;
  `node runtime/smoke.mjs` runs the full suite after any runtime change. A
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
