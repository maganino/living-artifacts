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

- Declaring `db` makes an artifact **organization-internal** — it cannot be
  shared publicly. Stakeholder-facing output must be a separate static export
  without `db`, which `audience-views` already requires.
- `publish(html)` reloads every open view, so saving is an explicit button.
- A Claude republish during a review round rejects the reader's save with
  `conflict`. The runtime stashes their unsaved ops in `sessionStorage` and
  shows them back, but they must re-apply them — so don't republish mid-round.
- No `assets` capability on this account: v2 images get downscaled in-browser
  and stored in `db`, not embedded as data URIs, to stay under the 16 MB limit.

## What v1 deliberately does not have

Images, freehand drawing, typed sketches, the cross-document index, static
audience export, and drag-to-reorder (v1 uses ↑/↓, which is reliable in a
sandboxed frame). Each is a v2/v3 item, not an oversight.
