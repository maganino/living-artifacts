---
status: open
repo: living-artifacts
---

# v3 — cross-document index and stakeholder export

- Index artifact reading the `docs/*` registry documents: title, rev, tag
  counts, open notes, per thread. This is where cross-document extraction
  ("give me every `seed-next` block in this thread") lives.
- Static single-audience export: a separate artifact published WITHOUT `db`
  and without the editor. Required, not optional — a `db` artifact is
  organization-internal and cannot be shared publicly.
- Open question from the direction doc: does the index live as an artifact, or
  as a `tray/`-style file the Obsidian Bases view already queries?
