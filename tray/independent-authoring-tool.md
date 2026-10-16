---
type: thread
status: wip
area: living-artifacts
topic: tooling
created: 2026-09-16
title: Independent authoring tool
---

# Create new documents without a Claude session

Asked for 2026-09-16: creating a new living document should be an independent
tool, still callable from a skill when that helps — not something that requires
me to be in the loop every time.


## Built on 16 October 2026: the scaffold, not yet the shell

`build.mjs new` exists and is tested:

```sh
node runtime/build.mjs new <docId> --template templates/<name>.template.json \
  --title "What it is called"
```

It writes `docs/<docId>/<docId>.doc.json` with every section the format names,
present and empty, carrying the format's own `info` and a `badge` on the ones
it demands. Section ids are derived from the template, so regenerating a
document from the same template keeps notes and marks anchored.

**What is still missing from the decision below:** it does not build the shell
or open it locally. Today you run `build.mjs shell` yourself afterwards. The
next action is one step in the CLI: after writing the seed, call `writeShell`
and print the local path.

## Decided 15 October 2026: accept the split, make starting cheap

Chosen: **CLI + manual publish**. Authoring and building already work with no
session; only minting the URL does not, and no page can create a second
artefact. So a document started alone is a draft — full editor, full model, no
autosave, no journal, no comments — until a session publishes it.

To build: `la new <title>` scaffolds the `.doc.json`, builds the shell and
opens it locally.

Rejected for now, not forever:

- **A drafting bench artefact** — one published scratch surface where a draft
  can start with no session, promoted to its own artefact when it matters.
  Real work for a problem the next item may solve for free.
- **Duplicating a template artefact from the claude.ai UI** — unverified. If
  the interface can duplicate an artefact with its files, this is the smallest
  answer by a distance. Check before designing anything around it.

The workbench is off the table: see [[v3-index-and-export]], decided the same
week.

## What blocks it

Authoring and building are already independent (`build.mjs` is a plain CLI).
**Publishing is not.** A published page can only republish *itself* — no page
can mint a new artifact — and the Artifact tool that can is only reachable from
a Claude session. So "author a new document alone" is fine; "get a URL for it
alone" is not.

## Three routes

- **CLI + manual publish.** `la new <title>` scaffolds a `.doc.json`, builds it,
  opens it locally for editing. Works offline today, no session. But it has no
  URL, no comments, no autosave until someone publishes it.
- **One workbench artifact holding many documents.** New documents become rows
  in a shared `db`, so creating one needs nobody. This is the real unlock —
  and note it is **the same architectural fork as the v3 index**
  ([[v3-index-and-export]]): per-document artifacts give independent URLs and
  isolated stores; one workbench gives shared state and self-service creation.
  Cannot have both. Decide once, for both questions.
- **Template artifact + duplicate.** If the platform can duplicate an artifact
  from inside the UI, a blank living document could be duplicated per new doc.
  Unverified — check before designing around it.

## Decide before building

The per-document choice was made at the very start of the repo, before either
of these costs was visible. Worth re-opening deliberately rather than drifting.
