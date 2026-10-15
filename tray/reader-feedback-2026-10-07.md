---
type: thread
status: done
area: living-artifacts-factory
topic: runtime-reader-feedback
created: 2026-10-07
title: Reader feedback from the Action Inventory review, 7 October 2026
---

# Reader feedback from the Action Inventory review, 7 October 2026

Mina reviewed the vpage-triage Action Inventory on the page on 7 October 2026
and asked for four changes to the runtime and the authoring rules, recorded
below as given.

**All four were built on 9 October 2026**, in commit `6a2edad`, along with the
chip bug found while applying that round. Four affordances that lived only in
the Outline moved into the page rather than going with it: the writing rules,
a section's `info`, the `badge`, and the empty-section placeholder.

Source: the vpage-triage-package session, `tray/recommendation-ontology.md` in
that repo. The document is
https://claude.ai/code/artifact/fe783068-abd1-4ca6-8daf-a7d04b6440f7.

## 1. Decision options are clickable, and the choice is recorded

A decision callout already parses `**Options:** (a) … (b) …` into chips. Make
those chips clickable. A click records the chosen option as a typed journal op
(for example `{op: "decide", block, option: "b"}`) and shows that chip as
chosen. When Mina says "follow the analysis", Claude reads the chosen options
from the journal rather than parsing free-text notes.

Evidence: in this review she answered all four decisions by typing notes like
"b) product scope, bring creation in" and "agree with recommendation".

Open: can a choice be changed or cleared? Does a choice plus a note on the same
decision stay two ops, or become one?

## 2. Drop the Outline mode

Keep only Preview and Edit. Outline (`mode === 'outline'` in
`runtime/la-runtime.js`, the `Page | Outline` toggle near line 3558) goes.

Open: Outline is where folding, expand-all and collapse-all live today. Decide
whether any of that moves to Edit or is dropped with it.

## 3. Multiline notes

The note input is a single line, so Mina cannot see a long note while writing
it. Make it a textarea that grows with its content, for block, cell and passage
notes alike. Enter must not submit. Use a modifier such as Cmd+Enter, or click
outside, consistent with how the block editor keeps work on click-away.

## 4. No round status in headings or section notes

Claude must not write titles or section notes that describe the round, such as
"Four calls, three carried from v2 unreviewed", "Added in v3" or
"new in v3". The change highlighting already shows what is new. A heading
states the content. This is an authoring rule: add it to the
`living-artifacts` skill, and to the desk-research template notes where
headings and eyebrows are described.

Related, from the same review: notes about sources and revisions inside the
reading flow (for example "v3 narrows it to…") break the story. They belong in
an expandable section or a hover, not in the body text. The ⓘ `info` and
`headInfo` already exist for this. The skill should say so.

## Found while applying the round

A decided callout highlights the **recommended** chip, not the chosen one. In
the Action Inventory, D-01 and D-03 were decided on (b) against a (a)
recommendation, and the page still fills (a). Request 1 should fix this too:
the filled chip is the choice once there is one, and the recommendation gets a
lighter mark.
