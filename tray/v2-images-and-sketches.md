---
type: thread
status: wip
area: living-artifacts
topic: roadmap
created: 2026-09-16
title: v2 — images and typed sketches
---

# v2 — images and typed sketches

Deferred from v1 by decision on 2026-09-09 (see `docs/direction.md`).

> **Half of this landed 2026-09-16.** A `figure` block now carries a picture
> with reader-editable words on it, and a `mermaid` block carries a diagram
> that is a view of its own editable source. What landed is the **Claude-authored**
> direction: I draw it, the reader corrects the words, I redraw. What is below
> is the **reader-authored** direction, which is still open.
>
> One premise below is now wrong: the `assets` capability **is** available on
> this account, so a real plot should be uploaded and referenced by URL rather
> than squeezed into `db` as base64. Downscaling still matters for anything the
> reader pastes.

- Paste/drop an image → downscale in-browser (canvas → WebP, target ~150 KB)
  → store in `db`, not as a data URI. The 16 MB rendered-page limit is the
  reason; there is no `assets` capability on this account.
- Claude reads an image back by pulling the base64 from `db`, decoding it to a
  file, and actually looking at it. Verify this path works before building the UI.
- Sketches as **typed** shapes (box, arrow, label), not freehand rasters, so
  Claude reads a graph rather than guessing at a scribble. Freehand overlay
  anchored to a block is a separate, later thing.

## What is still open after 2026-09-16

- **The reader putting an image in.** Paste or drop, downscale in-browser, and
  either upload it as an asset or hold it in `db`. Today a photo of a
  hand-drawn diagram goes to Claude through the chat instead, which works and
  is the reason this is not urgent.
- **Claude reading a reader-supplied image back.** Verify the whole path — pull
  it out, decode it, actually look at it — before any UI is built on top.
- **Typed sketches.** Unchanged and still the interesting one: boxes, arrows
  and labels as shapes Claude can read, rather than a raster to guess at. Note
  that `mermaid` now covers most of what typed sketches were wanted for, so the
  case for them is narrower than it was: what survives is sketching something
  that is not a graph.
- **Editing text inside an inline SVG figure.** Today a label change is a
  redraw request. For an SVG the text nodes could be edited in place and the
  picture would update with no redraw at all. Worth it only if figures start
  being authored as SVG rather than PNG.
