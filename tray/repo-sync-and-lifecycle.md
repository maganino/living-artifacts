---
type: thread
status: todo
area: living-artifacts
topic: lifecycle
created: 2026-09-16
title: Document lifecycle and repo sync
---

# Document lifecycle: what lives where, and when it syncs

Decided in principle 2026-09-16, not yet implemented.

## The rule

- **While a document is being worked on, the published artifact is the only
  truth.** It is versioned on claude.ai — every save is an immutable version
  with a version picker — so an uncommitted document is not unbacked.
- **The repo gets the final static HTML when the document is done.** That is the
  shareable, editor-free copy, and the thing worth having in git.
- **`dist/` should not be committed at all.** It is build output: model +
  inlined CSS/JS, fully derivable. Committing it is committing `node_modules`.

## What is still missing

- A `pull` step: read the live artifact, `build.mjs extract` its model, write it
  back over the `.doc.json`, commit. Today this needs a Claude session because
  fetching the artifact does. Wire it into the skill as "when the user says a
  document is done, pull and commit" — and look at whether a hook can do it on
  session end.
- A **Download this document** button in the bar: the full living HTML, editor
  and model intact, straight to disk. Distinct from `Build this version`, which
  strips the editor for sharing. This is the answer to "what if I lose access" —
  it makes a complete local copy available at any moment with no session in the
  path.
- `.gitignore` `dist/`, and stop committing it.

## The risk this does NOT remove

If an artifact is deleted, its `db` is erased with it and the journal goes too.
The HTML content survives in any pulled copy; the edit history does not. Pull
before deleting anything.
