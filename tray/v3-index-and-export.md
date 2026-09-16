---
type: thread
status: todo
area: living-artifacts
topic: roadmap
created: 2026-09-16
title: v3 — cross-document index and export
---

# v3 — cross-document index and stakeholder export

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
