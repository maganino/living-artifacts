---
status: open
repo: living-artifacts
---

# Create new documents without a Claude session

Asked for 2026-09-16: creating a new living document should be an independent
tool, still callable from a skill when that helps — not something that requires
me to be in the loop every time.

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
