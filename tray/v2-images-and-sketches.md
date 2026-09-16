---
type: thread
status: todo
area: living-artifacts
topic: roadmap
created: 2026-09-16
title: v2 — images and typed sketches
---

# v2 — images and typed sketches

Deferred from v1 by decision on 2026-09-09 (see `docs/direction.md`).

- Paste/drop an image → downscale in-browser (canvas → WebP, target ~150 KB)
  → store in `db`, not as a data URI. The 16 MB rendered-page limit is the
  reason; there is no `assets` capability on this account.
- Claude reads an image back by pulling the base64 from `db`, decoding it to a
  file, and actually looking at it. Verify this path works before building the UI.
- Sketches as **typed** shapes (box, arrow, label), not freehand rasters, so
  Claude reads a graph rather than guessing at a scribble. Freehand overlay
  anchored to a block is a separate, later thing.
