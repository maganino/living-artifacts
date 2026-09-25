# Direction

Decided 2026-09-09, at the start of the repo.

## The problem

`decompose-problem-artifacts` and `audience-views` were written against a
platform where the artifact is read-only to its reader. Both skills are
disciplines built *around* that limit — the read-back gate exists because a
comment is ambiguous, and the "assume you cannot close a thread" section exists
because threads accumulate unresolvable. Neither problem is inherent; both come
from the reader having only prose as a channel.

## The decision

Make the document editable, and make every gesture on it structured. The
document carries a JSON model; the reader's edits mutate the model; the model
publishes itself; Claude reads a typed journal instead of diffing prose.

Settled with Mina at the start:

| Question | Decision |
|---|---|
| Architecture | Per-document self-contained editor, **plus** a thin cross-document index later. Each doc keeps its own URL — shareable, commentable, independent. |
| Editing model | Structured blocks with stable ids, plus a freehand overlay in v2. Every edit stays machine-legible. |
| v1 scope | The model and the read-back loop first. Prove the channel closes before investing in editor surface. |

## Round 2 — the interaction model was wrong (2026-09-16)

First contact with a reader: five comments, all about the editor, none about the
content, and an **empty journal** — not one edit was ever saved. The structured
channel that was supposed to replace comments lost to comments, because using it
required discovering a select-then-act step first.

Replaced rather than patched. Hover a block and it lifts, with its controls on
it; click it to edit; drag its handle to reorder; highlight text and a `+ tag`
chip appears. The ↑/↓ buttons, the action bar and the selection step are gone.

Two things came out of it beyond the UI:

- **Passage-level tags.** Tagging a highlighted sentence means tags below block
  level, anchored by **quote** rather than character offset — an offset breaks
  as soon as anything above it is edited, a quote either still matches or is
  reportably gone.
- **"Style contract" was renamed** to "How this document should be written",
  with a line saying what it does. The reader's comment was "not sure what is
  this", which is a naming failure, not a discoverability one.

Reorder uses pointer events, not HTML5 drag-and-drop: HTML5 DnD never fires on
touch, and these documents get read on an iPad. Keyboard reorder (focus the
handle, ↑/↓) stays as the accessible path.

## Round 3 — autosave, and a rejection that was wrong (2026-09-16)

"Save by default, and add an undo redo mechanism."

Autosave was blocked by the thing that made saving a button: `publish(html)`
reloads every open view, so a debounced autosave would blink the page every few
seconds. The way out was the `publish(files)` form I had rejected in v1 — and
the rejection was wrong. The stated reason was that a data file the page adds
might not be readable back through the Artifact read path. That risk only exists
if the model moves *into* a data file. Publishing the whole `index.html` through
the files form keeps the model embedded exactly where it was, so reading back is
unchanged — and the publishing view is not reloaded, which is the whole point.

Falls back to `publish(html)` on `capability_disabled` / `read_only_path`.
Debounce is 2.5 s and doubles on `rate_limited`, capped at 20 s.

**Undo semantics.** An op undone before the round is saved is simply dropped —
no journal entry, so trial and error does not reach Claude as noise. An op undone
*after* it was saved records an `undo` op instead, leaving the original edit in
its own revision: the history stays true rather than being rewritten. Undo never
rewinds the revision counter, which would make the next save overwrite a version
that already exists.

## Round 4 — tagging, and what dropping "Apply" cost (2026-09-16)

Six requests in one comment: tag a block / a passage / several blocks at once;
drop the Apply step so clicking away keeps an edit; a highlighter tool in the
bottom bar; an optional tag at the end of a highlight; a colour per tag; and
filtering by tag.

The dependency is the interesting part. **Dropping Apply is what forces the
highlighter to exist.** Once a click on a block means "edit", dragging across its
text to select it is no longer reachable — the click opens the editor first. So
the highlighter is not a convenience; it is the mode that gives text selection
somewhere to live. Built in that order.

- **An untagged highlight is kept.** "Suggest a tag but optional" means the
  highlight itself is the artifact: it is created on mouse-up and the tag form
  opens after, with a way out. A bare `highlight` op still tells Claude the
  reader singled that passage out.
- **Tag colours are persisted** in `model.tagColors` rather than hashed from the
  name, so a tag looks identical every session and Claude reads the same map.
  Hue only — lightness and saturation differ per theme, so one stored number
  works in both.
- **Filtering never touches the model.** It is a view, like the toggle in
  `audience-views`, and the row says so on screen.
- **Multi-block tagging undoes as one gesture**, via a grouped undo entry, not
  four.

**A collision happened during this round**, and it is worth recording: the reader
saved a tag from inside the page while this rework was being built. The publish
was refused rather than allowed to overwrite it; the live version was read in
full and the tag merged in. The guard works, but it only works at publish
granularity — two people editing the same document at once is still not
something this design supports.

## Round 5 — a mode that should never have existed (2026-09-16)

Five more, and the important one is a correction. Round 4 claimed the highlighter
toggle was load-bearing: "once a click means edit, there is no way left to drag
across text." **That was wrong.** The block click handler has bailed on a click
that ended a selection since round 2, so dragging to select always worked. The
mode was redundant from the moment it shipped, and the reader spotted it by
using the thing. Removed.

The lesson is narrower than "test more": the claim was made about code that was
already written and already handled the case. Read the guard before asserting
what a change forces.

Also this round:

- **The `+ tag` chip moved to the end of the selection** rather than above the
  block, and clicking it opens a picker listing every tag the document already
  uses plus the standard intents, filtered as you type.
- **Filtering moved into the bottom bar** as tickboxes over the whole page.
- **"Build this version"** rebuilds the filtered document as a plain copy — no
  editor, no model, no `db`. Stripping `db` is not tidiness: a `db` artifact is
  organization-internal, so that is what makes the copy shareable at all. It
  downloads via the `downloads` capability and records a spec in `db` so Claude
  can publish it as its own artifact.
- **Highlights snap to word boundaries.** Not asked for — found in the reader's
  journal, where every single highlight had arrived mid-word (`"ng itself…"`,
  `"t witho"`). A dragged selection lands where the pointer did; storing that
  verbatim renders a broken mark and anchors on a fragment.

**Second collision in two rounds.** The reader saved fourteen revisions while
this round was being built; the publish was refused, their version read in full,
and their four tags and one highlight merged forward. The guard holds, but the
pattern is now clear enough to state as a rule: **do not build a round while the
reader is in the document.** The merge is only cheap because the model is
structured; it is not free.

## Alternatives evaluated and rejected

**Live docs (`artifact.sync`).** The platform has exactly this feature: on a
live doc the markup *is* the document, every keystroke, drag and reorder is
journaled to a watching Claude session automatically, and Claude answers with an
edit applied in place seconds later. It is a better mechanism than anything
here — no Save button, no reload, real-time collaboration.

It is not usable: live-doc mode is assigned by the platform when the artifact is
created, and neither the page nor its capability declaration can choose it.
There is no way to create one from Claude Code today. **If that changes, migrate
to it** — the block model here maps onto `data-id`-addressed elements almost
directly, and the journal becomes the platform's rather than ours.

**`publish(files)` instead of `publish(html)`.** The files form is the better
save path for an editor: the page stays fixed, only `data/doc.json` changes, and
the publishing view is *not* reloaded — it keeps running with its state intact.
Rejected for v1 for one reason: the Artifact tool publishes a single HTML file,
and it is unverified whether a data file added by the page can be read back
through `action: "read"`. Since the read-back is the entire point of v1, the
model stays inside the page where reading it is certain. Revisit once the
multi-file read path is confirmed — the reload-on-save is the main UX cost of
the current design.

**Serializing the DOM on save.** Explicitly wrong: `documentElement.outerHTML`
carries viewer-session state and injected runtime scripts. The page renders the
replacement from its own model instead, which is also what makes edits legible
as intent.

**One db document per operation.** Rejected — an artifact's database caps at
5,000 documents and the store warns against one-doc-per-event streams. One
document per *revision*, holding that revision's ops.

**Comments as the channel.** Kept as a complement, not the mechanism. Comments
still work on these artifacts and are the right tool for a question that isn't
an edit. But they are no longer the only way in, and the "you cannot resolve a
thread you did not activate" tax no longer applies to ordinary review.

## Known constraints

- The reader's own journal is the best bug report available — round 5's
  word-snapping came from reading it, not from a comment.
- Declaring `db` makes an artifact **organization-internal** — it cannot be
  shared publicly. Stakeholder-facing output must be a separate static export
  without `db`, which `audience-views` already requires.
- Every save mints a version, so autosave is debounced and backs off on
  `rate_limited` rather than retrying.
- A Claude republish during a review round rejects the reader's save with
  `conflict`. The runtime stashes their unsaved ops in `sessionStorage` and
  shows them back, but they must re-apply them — so don't republish mid-round.
- ~~No `assets` capability on this account~~ — **wrong as of 2026-09-16.**
  `assets` is available and is the right home for a real plot: upload it, put
  the returned URL in a `figure` block's `src`. The model rides inside the page
  on every save, so a data URI is paid for on every write; keep those small.

## What v1 deliberately does not have

Freehand drawing, typed sketches and the cross-document index. Each is a v2/v3
item, not an oversight. Drag-to-reorder, static audience export and images have
since landed.

## 2026-09-16 — tables, diagrams and figures

Three changes, one rule holding them together: **a new way to edit is never a
new kind of operation.** Every editor, whatever its shape, produces one source
string and records one `edit` op carrying `before` and `after`, so undo, the
journal and the read-back learned nothing new.

- **Tables are edited as a grid**, one input per cell, enter walking down a
  column, `×` dropping a row or column. The old tab-separated textarea is still
  there behind `as text`, because pasting a table in from elsewhere is a real
  thing and a grid is bad at it. The grid serialises back to exactly that TSV.
- **`mermaid` blocks** draw a diagram from source the reader can open and edit
  by clicking it. The model stores the source, never the SVG. Mermaid 11.15.0
  loads from cdnjs on demand and only when a document holds a diagram — the
  runtime's one external dependency, and it degrades to the source text rather
  than to a blank. A static export emits `<pre class="mermaid">` and lets the
  artifact viewer draw it, so a shared copy needs no runtime and no library.
- **`figure` blocks** carry a picture Claude drew and the reader cannot edit,
  plus the words printed on it — caption, alt, and a `labels` map of *where on
  the picture* to *what it reads*. Editing a label is an ordinary `edit` op and
  a redraw request; acting on it means regenerating the image and replacing
  `src`. A figure with a caption and no `src` is how a chart gets asked for.

Rejected: a visual diagram editor, where the reader drags boxes around the
chart itself. It is the complete answer and it is also a second application.
The workflow that wins instead is cheaper and already works — mark the diagram
up by hand, send the photo, Claude rewrites the source; or, for wording, edit
the source directly, which is faster than describing the change.

## 2026-09-16 — sections fold, and carry the template's own brief

Asked for on the SSO PRD and taken as a general rule, because every document
that follows a template has the same two problems: the reader cannot see its
shape, and the reader does not know what a section is supposed to contain.

- **Folding.** Headings delimit sections; the document opens as an outline,
  leaf sections closed, container sections open. Four collapsed lines was the
  first attempt and it was a table of contents for a table of contents — the
  useful default shows every section NAME with what it is holding. A closed
  section reports its block count, what changed, what is tagged and what
  carries a note, so folding never hides signal. It is a view: it never
  reaches the model or the journal, and a filter beats a fold.
- **`info` on a heading** — an ⓘ carrying what the section is for, taken
  **verbatim from the template the document follows** rather than paraphrased.
  Edited as the heading's second paragraph, the shape `callout` already uses.
  Where the template describes nothing, the ⓘ is absent rather than invented.
- **Empty sections keep their heading** and render `<>`, which starts a block
  when clicked. Carrying the template's unused sections is the point: a
  missing section is forgotten, an empty one is a decision the reader owns.

Also fixed: the changed-since-last-round gutter was an inset shadow, which
followed the block's 8px corners and drew a bracket. At outline density, with
most rows changed, it read as damage. It is now its own bar.

## 2026-09-16 — the Verbolia design system, and section provenance

- **The palette is Verbolia's, in the runtime, for every document.** `--teal`
  becomes black (links, focus, the solid-black CTA), `--amber` becomes Verbolia
  orange and carries "changed", `--rose` becomes Verbolia red. Lexend loads by
  `@import` inside `#la-style`, which is the only place that survives the page
  republishing itself — a `<link>` in the head would be dropped by
  `buildDocument()`. Controls are fully round, headings are Extra Light.
  `--on-accent` is new: the primary button had `color: #fff` hardcoded, which
  breaks the moment the accent is white in dark mode.
- **`badge` on a heading** — provenance, shown beside the title. Written for
  "which of these sections does the Jira template require?", and the answer is
  legible because the badged ones carry it and the invented ones do not.
- **Section separation** — depth-based indentation from the fold chain, a rule
  above every top-level section, and a tint on an open section's heading. The
  model stays flat; only the rendering nests.

## 2026-09-16 — the shared copy is tabbed

The living page folds, the export tabs. Two readers, two jobs: the first is
looking for one section to change, the second wants to read a subject and stop.
Tabs cost nothing on a copy that has no editor, and they were the one thing
worth taking from the other PRD skill in the team, which is tabbed throughout.

Also fixed: `export` reported "45 of 137 blocks" because it counted blocks
visible in the DOM and folding had hidden the rest. The count now comes from the
model. The file was always complete, only the number was wrong.

## 2026-09-17 — labels over claims, and a violet for state

Both came from reading the other PRD skill in the team
(`bpfsteam/product-team-processes`) against a document built here.

- **`eyebrow` on a heading.** Their pages put a small label over a heading that
  states a claim, and it is the single biggest readability difference between
  the two. Ported as a heading field rather than as a convention, so it is
  editable and survives a round.
- **The surface is theirs now**: grey page, white cards, anthracite text. Two
  PRDs from the same team should not look like two products.
- **Changed blocks are violet**, `#6E56CF` light and `#A392F9` dark,
  deliberately outside the brand palette. Orange was doing double duty as both
  "highlight" and "changed since you looked", and the brand's four accents are
  spoken for by meaning. State is not meaning, so it gets its own hue.
- **What we did not take**: their multi-column card layout. It suits a page that
  is read; a page that is edited wants one column and an obvious click target.

The lesson worth keeping: the drift happened because the look was rebuilt from
a rendered example instead of from their template, which already carried every
component as a reusable piece. Read the template, not the screenshot.

## 2026-09-17 — the export gets the design, the editor keeps the column

Asked for directly: cards, multi-column and the brand treatment belong to the
published copy, not to the page being written. That is the right line and it is
now the rule. The export renders sub-sections as cards on the grey page, pairs
short ones two to a row, keeps anything holding a table, a figure or a diagram
full width, and opens with a hero. The editable page is untouched.

Two bugs found while doing it, both in the export:

- A deep link never opened its tab. The handler built the id as
  `"t" + location.hash`, which is `t#h-problem` rather than `t-h-problem`, so
  every link into a closed tab silently did nothing.
- The hero kicker printed the model's `updated` field, which is a working note
  about which round produced the document. A shared copy now says what it is and
  the date it was cut.

Also worth recording, because it cost a round: eyebrows looked missing in the
published copy. They were there. The first tab is the summary, which holds the
thesis and the meta table and no sections at all, so nothing on the opening
screen carries one.

## 2026-09-17 — jump links inside a tab

Missing from the first pass at the shared copy and asked for directly: a tab is
a long page, and the tabs alone do not get a reader to a section. Each tab now
opens with a sticky row of jump links, named by each section's label. This is
the second job the label does, and the reason a claim cannot replace it: a
sentence makes a poor pill.

It also surfaced a naming collision the document could not show on its own. Two
sections both carried the label "Unknowns", one open and one answered, which
read fine as headings and read as a duplicate in a nav. The nav is a second
proof-reader for section names.
