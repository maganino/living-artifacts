---
type: thread
status: todo
area: living-artifacts
topic: roadmap
created: 2026-09-16
title: v3 — cross-document index and export
---

# v3 — cross-document index and stakeholder export

## Decided 15 October 2026: documents stay independent, the index is a page I keep

Chosen: **C with A**. Documents keep their own artefact, their own URL and
their own store. The index is a separate artefact that Claude writes, not a
page that queries — no page can read another artefact's store, so a live
cross-document view was never on the table without merging the documents into
one artefact, and that was rejected.

The `tray/` records stay the underlying source: one `type: artefact` record per
document, written on every publish. The index artefact is rendered from them,
so it is a snapshot that is exactly as fresh as the last time Claude published
or finished a document.

Rejected: one workbench artefact holding every document. It buys a live index
and self-service creation, but one URL means one version history, sharing one
document means sharing all of them, and deleting it erases every journal at
once. The blast radius is the problem, not the ergonomics.

**Still to build, as of 16 October 2026.** Nothing. The decision is made and no
code exists for it.

Next steps, in order:

1. Decide what the index page shows per document. Candidates, all already in
   the `tray/` artefact records: title, URL, status, source seed, the date it
   was last published, and the *Shared versions* rows. Nothing else is
   available without opening each artefact, which the index must not do.
2. Write a `build.mjs index` that reads `tray/*.md` with `type: artefact` and
   produces a `.doc.json` — the index is itself a living document, which means
   it gets the same layouts and the same Publish button for free.
   `desk-research` is the likely layout: it is a long page with a table.
3. Publish it once, record its URL in a `tray/` record of its own, and
   republish it whenever a document is published or finished. That republish
   step belongs in the living-artifacts skill next to "Record the URL".

**The staleness is by design and must be stated on the page itself**: the index
is a snapshot taken when Claude last published something, not a query. A reader
who thinks it is live will trust a stale row.

## Correction (2026-09-16): the original plan cannot work

This file previously said "index artifact reading the `docs/*` registry
documents". **That is impossible.** `db` gives one store *per artifact*, and a
page can only read its own. `sso-discovery` and `sso-delivery` are two
artifacts, so two isolated databases — neither page can see the other's.

The `docs/<docId>/...` paths we write are namespacing inside a single
document's own store, not addressing across documents.

Three ways out, none free:

- **Claude builds the index.** I can `read_db` each artifact by URL and publish
  a static index. Works today, but the index is only as fresh as the last time
  I was asked.
- **One artifact holds many documents.** The store is then shared and an index
  page is trivial — but it contradicts the per-document-URL decision made at
  the start (own link, own comment threads, shareable on its own).
- **A `tray/`-style file per thread in the repo**, which Obsidian already
  queries. No live tag counts, but it costs nothing and fits the existing
  cross-repo dashboard.

Leaning toward the third for the index and the first on demand. Decide before
building.

## Static export — mostly done

`Build this version` (round 5) rebuilds the filtered document as a plain copy
with no editor, model or `db`. Stripping `db` is what makes it shareable at all,
since a `db` artifact is organization-internal.

Still to do: Claude publishing that copy as its own artifact from the export
spec the page records — today it only downloads.
