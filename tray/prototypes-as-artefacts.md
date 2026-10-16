---
type: thread
status: wip
area: living-artifacts
topic: artefact-types
created: 2026-09-16
title: Prototypes as a special artefact type
---

# Prototypes as a special artefact type

Opened 2026-09-16 by Mina, to be picked up later. Nothing has been done on it.

## The question

Living artefacts now cover documents that carry pictures: `figure` holds a
drawn image with editable words on it, `mermaid` holds a diagram that is a view
of its own source. That closes the gap for reports and specs — everything Mina
asks for can be a living artefact.

**Prototypes are the exception, and they should be their own kind of thing.** A
prototype is not a document with a picture in it. It is a working screen the
reader drives: the SSO sign-in prototype
(`sso-client-scoping/components/login-journey`, published at
https://claude.ai/code/artifact/091a2988-e4e7-42dd-8e65-aecf005cc892) is a real
two-step sign-in that responds to typed addresses. Wrapping that in a block
model would destroy the thing that makes it useful.

## Decided and built, 16 October 2026

A prototype is a **living document with one `prototype` block** holding the
screen, and ordinary blocks around it. The screen runs sandboxed in a frame;
its strings are `labels` keyed by `data-la-text`, listed beside the frame for
the writer; editing one shows on the screen as it is typed and lands as one
`edit` op; tagging one is a mark that points into the screen. Feedback comes
back as the journal. Versioned as any document.

Chosen over a plain artefact with comments because the 14 open threads on the
SSO screen were mostly copy and "what has to be tested" — exactly what strings
and tags carry. Chosen over region anchors because the text IS the anchor, so
nothing couples a screen to the runtime beyond one attribute.

**Not yet done: migrating the SSO prototype.** It lives in another repo
(`sso-client-scoping/components/login-journey`, published at
https://claude.ai/code/artifact/091a2988-e4e7-42dd-8e65-aecf005cc892) and has
the 14 threads to prove the design against. Next step: mark its strings with
`data-la-text`, wrap it in a document, carry the open threads over as notes.

## What had to be decided

- What a prototype artefact **is**: a whole page with no block model, or a
  living document with one block that is the prototype and ordinary blocks
  around it carrying the notes.
- How feedback comes back. A living document's answer is the journal. A
  prototype's is probably still comments — 14 threads sat open on the sign-in
  screen — unless the frame around it can hold tags and notes that point *into*
  the screen.
- Whether a prototype is versioned the way a document is. A document's every
  save mints a version; a prototype is more likely to be replaced outright.
- Where it lives in `tray/`, and whether the artefact record template needs a
  second shape.

## Why it is parked

The three block types landed first because they unblock every ordinary
document. Prototypes need the shape of the thing decided before any runtime
work, and that is a conversation, not an implementation.
