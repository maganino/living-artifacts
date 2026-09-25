---
type: thread
status: wip
area: living-artifacts
topic: templates
created: 2026-09-25
title: The desk-research template
---

# The desk-research template

## How to resume

Read this file, then `skills/living-artifacts/SKILL.md` section **"The desk-research
template"**, which is the reference for how a model maps onto the layout. Nothing
below repeats it. Then check the two open hazards under *Immediate next steps*
before publishing anything from this repo.

## What this is

A second read-mode layout for living documents, added 25 September 2026. The
house layout was built for specifications (tabs, cards, flows) and Mina rejected
it for research pages: rebuilding the vpage-triage desk-research artifacts in it
lost the stat tiles, charts and grouped inventory tables of the hand-written
August originals, which is how she reads and decides. She asked for the living
document mechanics and the newer writing style **on top of** the old look.

So the runtime now draws two looks from one model, chosen by `"template":
"desk-research"` on the document. Default stays the house layout.

Where it lives:

| Path | What |
|---|---|
| `runtime/desk.css` | The whole look, scoped under `.house.desk` |
| `runtime/la-runtime.js`, the `dk*` functions | The renderer: `readHtmlDesk`, `dkTable`, `dkDecision`, `dkBody`, `dkSection` |
| `skills/living-artifacts/SKILL.md` | The authoring reference — model → layout |
| `docs/model.md` | The `template` field on the document |

**Design rule it obeys, from the skill:** a document never carries its own CSS.
Everything is in the runtime, so a change reaches every document on its next
publish. That is also why adding the template meant republishing the design
system artifact before any document could use it.

## What's built and live

- **The template**, end to end. Header with the Verbolia wordmark (inverted in
  dark), sticky nav with the PRD's scroll-spy underline, sections as eyebrow over
  claim, level-4 heading runs as card grids.
- **Charts as table variants**, so they stay editable as grids rather than
  becoming pictures: `stats`, `bars`, `tiers` (numbered ladder with progress
  bars), `donut` (inline SVG, no library).
- **Grouped tables**: frozen header, sticky group rows, pills read off the column
  name, monospace flag column.
- **Decision cards** parsed from a `decision` callout's own text conventions.
- **Three documents using it**, all in `MCP test/vpage-triage-package/docs/`:
  challenge-inventory, action-inventory, executability-map. Published to their
  original URLs; records in that repo's `tray/*-artefact.md`.
- **The design system artifact** republished with it:
  https://claude.ai/code/artifact/1e1428f7-4fab-494a-98f5-58eaec6b2a6d
- **A sample artifact** built for approval, still published:
  https://claude.ai/artifact/Q7j1cWJEQWAq7CyNY8oHyR

**Verified:** `npm test` (the runtime smoke suite) green; each document builds and
passes preflight for JS errors, save round-trip and block count; the template's
own parts probed headlessly in jsdom (logo, nav, rungs, bars, group rows, donut,
decision chips, cards).
**Not verified:** nobody has opened the published pages in a real browser. No
visual regression check exists for the house layout — the smoke suite covers
behaviour, not appearance, so the house look is assumed intact because nothing
outside `.house.desk` was touched.

## Key decisions — don't re-ask these

1. **A second layout in the same runtime, not a second runtime.** One stylesheet
   and one renderer ship to every document; forking would make two documents
   written a month apart stop looking alike, which is the failure the
   hand-written static pages had.
2. **Charts are table variants, not a new block type.** A chart the reader cannot
   edit is a picture. As a table it stays a grid they can type into, and it
   degrades to a plain table if they change its shape.
3. **The decision card parses conventions in the callout's own text**
   (`"D-1 · question. Open."`, `**Options:** (a) …`, `**Recommendation:** (a) …`)
   rather than adding model fields. Same reason: the reader can rewrite it into
   ordinary prose and nothing breaks.
4. **Wordmark, not the colour slashes**, and the PRD's scroll-spy underline on the
   nav — both Mina, 25 September 2026.
5. **The logo is a base64 PNG inlined in the runtime**, from
   `MCP test/vpage-triage-package/design/verbolia-logo.png` (1415×180). There is
   no SVG wordmark anywhere on this machine. If one appears, swap it: the PNG is
   about 30 KB carried by every document.

## Immediate next steps

1. **Resolve the runtime drift before anyone republishes the design system.**
   The published design system holds the runtime I built (232,386 bytes). The
   local repo has moved past it: `runtime/la-runtime.js` and `runtime/desk.css`
   were edited at 10:14 on 25 September 2026 by another session, which built
   `sso-client-scoping/docs/sso-plan/` against them. A build from the current
   repo produces about 235,053 bytes. Whoever republishes the design system next
   decides what every document gets on *its* next publish. **Not urgent:** a
   document keeps the copy it was published with, so nothing live is broken.
   Diff the two, confirm both the house and desk layouts still pass `npm test`,
   then republish once.
2. **Commit.** The whole repo is uncommitted and mixes at least two sessions'
   work: `runtime/build.mjs`, `la-runtime.js`, `la-style.css`, `smoke.mjs`
   modified; `desk.css`, `house.css`, `mark-changes.mjs` untracked. Last commit
   is `b1f662c`, 16 September 2026. Separate the template commit from the rest.
3. **Fix preflight's first checks.** `runtime/preflight.mjs` counts `.la-block`
   and `.la-acts` elements, which only the outline mode emits. Against the fused
   page render it reports `blocks rendered 0 / N` and sometimes a hover-chrome
   miss on *every* document, including known-good ones, and then prints
   "do not publish". It cried wolf on four documents this session. Make it count
   `.la-blk` in page mode, or state which mode each check applies to.

## Loose ends — not blocking

- No donut, stats or tiers variant appears in `examples/blocks-demo.doc.json`.
  Adding one would make the template visible to anyone reading the repo.
- `dkCellHtml` recognises column names in English only (`Detectable`, `Tier`,
  `Surface`, `Effort`, …). Fine for now; it fails soft, rendering plain text.
- The sample artifact above is redundant now that the three real documents use
  the template. Mina was asked whether to delete it and did not answer.
- The template was designed against one document (challenge-inventory) and then
  applied to two more. A fourth desk-research document is the real test of
  whether the conventions generalise.
