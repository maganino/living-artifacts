# Living Artifacts

A tool for communicating thoughts and designs to Claude without going through
prose comments.

A published artifact today is read-only to its reader. The only channel back is
a comment pinned to a passage — the shortest thing anyone writes, and half its
meaning lives in what it is attached to. Claude then re-reads the whole document
and guesses which part the comment governs.

This repo makes the document itself editable, and makes every gesture on it
**structured**: edit the text, reorder or delete blocks, tag a section with an
intent (`expand`, `seed-next`, `for:sales`), pin a note to a specific block, or
set a standing instruction for the whole page's tone. Each one is recorded as a
typed operation in a journal. Claude reads the journal, not a diff — so a round
starts from *what you meant*.

**Status:** v1 — the model and the read-back loop. Editing, reordering,
tagging, notes and the style contract work end to end. Images and typed
sketches are v2; the cross-document index is v3.

## How it works

```
  <name>.doc.json ──build──▶ artifact ──you edit──▶ page republishes ITSELF
       ▲                                                    │
       │                                                    ▼
   Claude edits the model ◀──reads the journal──── docs/<id>/journal/r<n>
```

The document's truth is a JSON model embedded in the page. The DOM is a
rendering of it and is never read back. The page declares the `artifact`
capability so it can publish a new version of itself, and `db` so the journal
lands somewhere Claude can read cheaply.

## Layout

```
runtime/
├── la-runtime.js   the editor, the model, self-republish (inlined into every doc)
├── la-style.css    self-contained — a doc must look the same however it was published
├── build.mjs       build <doc.json> → publishable html; extract <page.html> → model
└── smoke.mjs       headless drive of every handler + two generations of self-republish
docs/
├── model.md        the document model — the canonical schema
└── direction.md    why it is built this way, and what was rejected
skills/
└── living-artifacts/  how Claude authors a document and reads a round back
examples/          documents, with their published URLs recorded
```

## Use

```bash
npm install                                   # jsdom, for the smoke test only
npm test                                      # drive the runtime headlessly
node runtime/build.mjs build examples/x.doc.json     # → dist/x.html, then publish it
node runtime/build.mjs extract dist/x.html            # pull an edited model back down
```

Publish the built file with `capabilities: {artifact: {}, db: {}}` and record
the URL in the doc JSON. Every later round republishes to that same URL.

## Constraints

- **A `db` artifact cannot be shared publicly** — it is organization-internal,
  every reader a signed-in member of the org. Anything for a customer is a
  separate static export, published without `db` and without the editor.
- **Saving reloads the page**, so it is an explicit button, never autosave.
- **The 16 MB rendered limit** is why images are v2 and will be downscaled
  in-browser into `db` rather than embedded as data URIs.

## Relationship to PMOS

`decompose-problem-artifacts` and `audience-views` in
[PMOS](https://github.com/maganino/product-management-os) supply the discipline
— one artifact per component, corrected in place; tag by audience, export
statically. This repo supplies the mechanism they were missing: a document that
can actually be edited by its reader, and a channel that carries the edit back
as intent. The skill here composes with both rather than replacing either.
