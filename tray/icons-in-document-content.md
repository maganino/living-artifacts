---
type: thread
status: tray
area: living-artifacts
topic: brand
created: 2026-10-16
title: Reaching the brand icon set from a document's content
---

# Reaching the brand icon set from a document's content

Opened 16 October 2026, out of the icon work ([[v2-images-and-sketches]] is a
different thread — that one is about pictures a reader supplies).

## What this is

The Verbolia design system ships 43 icons, 24x24, drawn in `currentColor`. They
are vendored at `runtime/brand/icons.json` by `build.mjs brand`, which copies
them from `claude-design/icons/svg` in the design system repo.

Exactly one of them, `info`, is chrome: the runtime draws it on a table
column's definition and a gantt row's detail. **The other 42 are a domain set**
— `ai-engine`, `bounce`, `broken-link`, `conversion-funnel`, `keyword`,
`robot`, `server`, `shopping-cart`, `sitemap`, `speedometer`, `workflow` and so
on. They name what Verbolia's product is *about*.

So they are not UI icons waiting to replace glyphs. They are content, and
nothing in the model can reach them.

## Why it is only in the tray

It needs a decision before it needs code: **how does a model name an icon?**
The options are not equivalent and the choice is hard to reverse, because every
document written under it carries the syntax.

- A field on a block — `"icon": "sitemap"` on a callout, a heading, a stat
  tile. Explicit, typed, validated at build time. Does not work inside a
  sentence.
- Inline in text — `:sitemap:` or similar, resolved by `inline()`. Works
  anywhere prose works, including a table cell. Invents a syntax a reader has
  to learn, and collides with any text that legitimately contains colons.
- Both, for different jobs. Most likely right and most likely to sprawl.

## What is already true, so it is not re-derived

- The runtime carries **only** the icons it draws as chrome, listed in
  `RUNTIME_ICONS` in `runtime/build.mjs`. The whole set is 24 KB and the
  runtime is inlined into every document, so carrying all 43 would be paid for
  on every save. Whatever is decided must keep that property: a document pays
  for the icons it uses, not for the set.
- `icon(name, cls)` in `runtime/la-runtime.js` renders one, and
  `.la-icon` sizes it to `1em` so it takes the colour and size of whatever it
  sits in.
- The icons are `currentColor` throughout, so there is no light and dark
  variant to keep in step.

## Next step

Put the three options above to Mina with a recommendation. Do not build first:
the syntax is the decision.
