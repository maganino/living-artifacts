# living-artifacts

The artefact factory. Every document Mina publishes should be built here, by
this runtime, unless he says otherwise.

## What to do when Mina asks for an artefact

**Name the form in one line, then wait.** Do not pick silently and do not start
building. The line says which form you would use and why, and nothing else:

> That's a document with review rounds in it, so I'd build it as a living
> artefact through the repo. Say go, or say static if you want a plain page.

Two forms exist:

| Form | When | What it is |
|---|---|---|
| living artefact | anything with a reader, a review round, or a second version | this runtime: editable in place, every gesture a typed op, journal read back as intent |
| plain static page | a throwaway visual answer, or anything leaving the organization | the Artifact tool directly, no editor, no `db` |

A `db` artefact is organization-internal and **cannot** be shared publicly.
Anything for a customer is a separate static export with `capabilities: {}`.

Follow the `living-artifacts` skill from there. It is the procedure; this file
is only the routing rule and the defaults.

## Defaults that are not decisions

- **The look is always Verbolia.** One theme, shipped by the runtime. Do not
  build a second theme, do not ask which theme, do not style a page. If a
  document needs something the runtime lacks, add it to the runtime.
- **The template is the variable, and the document's purpose picks it:**
  `house` for a PRD or spec, `desk-research` for research and analysis,
  `brief` for a one-pager or memo. The skill has the full table. When none
  fits, say so and use `house` rather than inventing a layout in the document.
  There is no deck template, and a deck is not a living document.
- **Never style a page.** Writing CSS into a document means the runtime is
  missing something and the next document will need it too.

## Layout

```
runtime/     the product: editor, model, self-republish, the two CLIs, the tests
docs/        model.md is the schema; direction.md is what was rejected and why
docs/<name>/ one folder per document: the .doc.json seed and its built shell/
skills/      the living-artifacts skill, symlinked into ~/.claude/skills
tray/        threads and one artefact record per document
examples/    documents kept as references
dist/        build output, gitignored, never committed
```

The document you are working on lives in **the project you are working in**,
not here. Only the runtime and the skill live in this repo.

## Commands

```sh
node runtime/build.mjs shell <doc>.json <outdir>   # the publishable folder
node runtime/build.mjs extract <model.js> <doc>.json  # pull the live model down
node runtime/mark-changes.mjs <last-seen>.json <doc>.json --rev <n>
node runtime/preflight.mjs <built>.html            # drive one document
npm test                                           # the full suite
```

## Rules that have been paid for

- **Pull the live model down before every round.** The repo seed goes stale the
  moment the reader saves; rebuilding from it silently reverts their work.
- **Do not build a round while the reader is in the document.** Their save is
  refused rather than clobbered. Ask first.
- **Read the journal, not the page.** The whole point of the repo is that an
  edit arrives as intent. A diff of the prose is the thing this replaced.
- **Stop after the read-back.** One row per op, what you believe it asks for,
  then wait. This gate is where a round is won or lost.
- **Never commit `dist/`.** It is derivable.
