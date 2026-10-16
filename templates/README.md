# Document templates

A **layout** says how a page is drawn — `house`, `desk-research`, `brief`. It
lives in `runtime/` and this repo owns it.

A **document template** says which sections a document has, what each one is
for, and which ones a format demands. That is content structure, and it belongs
to whoever owns the domain: the Verbolia PRD format, the two-stage one, a Jira
spec. This repo owns none of them.

```sh
node runtime/build.mjs new <docId> --template templates/<name>.template.json \
  --title "What it is called"
```

It writes a model whose sections are all present and all empty, so every
section the format names stays a visible decision rather than something
forgotten.

## Why the files are here for now

A template should ship with the skill that owns the format. `verbolia-prd` is a
**synced** skill: it lives under `~/.claude/skills/synced/`, its sync round
overwrites local edits, and nothing added here would survive. So its template
is vendored into this folder until the skill can carry its own, and the file
records where its wording came from.

**The `info` on every section is the format's own wording, copied.** Not a
gloss written over it. Someone filling a section should read the brief they
would have read in the format's own documentation. Where the format leaves a
section undescribed, leave the `info` off rather than inventing guidance that
will be mistaken for the format's.

## The format

```jsonc
{
  "v": 1,
  "name": "verbolia-prd",      // what a document records as its format
  "title": "Verbolia PRD",     // the default document title
  "layout": "house",           // a read-mode layout, validated against the runtime
  "badge": "verbolia prd",     // the provenance label on sections the format demands
  "source": "where the wording came from",
  "sections": [
    {
      "text": "Product thesis",  // the heading
      "level": 2,                // 2 is a tab, 3 a section, 4 a card
      "eyebrow": "Timing",       // optional label over the heading
      "info": "…",               // what the section is FOR, in the format's words
      "required": true,          // badge it: the format demands this section
      "badge": "…"               // optional, overrides the template's badge
    }
  ]
}
```

The first section must be level 2 — it is the document's first tab. Section ids
are derived from the template name and the section text, so regenerating a
document from the same template keeps every note, tag and change mark anchored
where it was.
