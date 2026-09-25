#!/usr/bin/env node
/* living-artifacts build tool.
 *
 *   build   <doc.json> [out.html]   model + runtime -> BODY-FORM html for the
 *                                   Artifact tool (no doctype/html/head/body:
 *                                   the tool supplies that wrapper).
 *   extract <page.html> [out.json]  pull the model back out of a published
 *                                   page — the read-back mirror after the
 *                                   human has edited and self-published.
 *   shell   <doc.json> [outdir]      the shared-runtime form: index.html (a
 *                                   shell) + model.js, with runtime.js and
 *                                   style.css beside them for local viewing.
 *                                   Publish with the Artifact tool, copying
 *                                   runtime.js and style.css from the
 *                                   design-system artifact.
 *   ds      [outdir]                the design-system artifact's files.
 *   export  <doc.json> [--tags a,b] [out.html]
 *                                   the FINAL shareable copy: only the blocks
 *                                   carrying those labels (all of them if none
 *                                   given), with no editor, no model and no db.
 *                                   Stripping db is what makes it shareable at
 *                                   all — a db artifact is org-internal.
 *
 * The page itself emits the FULL-form document at self-publish time
 * (buildDocument in la-runtime.js). Both forms render identically because the
 * reset lives in la-style.css, not in a host wrapper.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const MODEL_EL = 'la-model', STYLE_EL = 'la-style', RUNTIME_EL = 'la-runtime';
const S = '<' + 'script', E = '<' + '/' + 'script>';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* '<' occurs only inside JSON string literals, where < is a legal
   escape — so the model can never break out of its script element. */
const embed = (model) => JSON.stringify(model, null, 2).replace(/</g, '\\u003c');

/* One stylesheet for both looks: the house look for read mode, scoped under
   .house so it never leaks, then the editor chrome. Tokens come with the house
   sheet. */
export function styleBundle() {
  return readFileSync(join(REPO, 'runtime/house.css'), 'utf8') + '\n'
    + readFileSync(join(REPO, 'runtime/desk.css'), 'utf8') + '\n'
    + readFileSync(join(REPO, 'runtime/la-style.css'), 'utf8');
}
export function runtimeSource() {
  const js = readFileSync(join(REPO, 'runtime/la-runtime.js'), 'utf8');
  if (js.includes('<' + '/script')) {
    throw new Error('la-runtime.js contains a literal closing script tag — it cannot be re-emitted.');
  }
  return js;
}

/* --- the shared-runtime form --------------------------------------------
 * A document is a small shell plus its model. The runtime and the stylesheet
 * are the design system's files, copied server-side into every document at
 * publish, so they are shipped once and never re-read. The page saves
 * model.js and nothing else. */
export function modelJs(model) {
  return 'window.__laModel = ' + JSON.stringify(model, null, 1) + ';\n';
}
export function shellHtml(model) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<div id="la-root"></div>
${S} src="model.js">${E}
${S} src="runtime.js">${E}
</body>
</html>
`;
}
export function writeShell(model, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), shellHtml(model));
  writeFileSync(join(dir, 'model.js'), modelJs(model));
  /* local copies so the folder opens from disk exactly as it will publish */
  writeFileSync(join(dir, 'runtime.js'), runtimeSource());
  writeFileSync(join(dir, 'style.css'), styleBundle());
}
/* The design-system artifact: the two shared files, and a page that says what
   they are. Documents copy runtime.js and style.css from it. */
export function writeDesignSystem(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runtime.js'), runtimeSource());
  writeFileSync(join(dir, 'style.css'), styleBundle());
  writeFileSync(join(dir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verbolia living design system</title><link rel="stylesheet" href="style.css"></head>
<body><div class="house"><div class="wrap" style="padding:56px 24px;max-width:760px">
<div class="eyebrow">Design system · living artifacts</div>
<h1>Verbolia living design system</h1>
<p class="thesis">Two files every living document copies at publish: <code>runtime.js</code>, the editor and the published view, and <code>style.css</code>, the house look with its tokens and the editor chrome. A document is a shell and a <code>model.js</code>; nothing else.</p>
<div class="blocks" style="margin-top:28px">
<div class="deferred" data-variant="note"><span class="tag">Note</span><div>A callout in its plain look.</div></div>
<div class="deferred" data-variant="warning"><span class="tag">Warning</span><div>The same block, warning variant.</div></div>
<div class="deferred" data-variant="decision"><span class="tag">Decision</span><div>Decision variant.</div></div>
<div class="deferred" data-variant="excluded"><span class="tag">Excluded</span><div>Excluded variant.</div></div>
<p>Owner chips: <span class="pill role" style="--role-h:260">PM</span> <span class="pill role" style="--role-h:214">Dev</span> <span class="pill role" style="--role-h:150">CS</span> <span class="pill role" style="--role-h:334">Sec</span> <span class="pill role" style="--role-h:96">Sales</span> <span class="pill role" style="--role-h:28">Legal</span></p>
<p>Importance: <span class="pill high">High</span> <span class="pill medium">Medium</span> <span class="pill low">Low</span></p>
</div></div></div></body></html>
`);
}

export function buildBody(model) {
  const css = styleBundle();
  const js = runtimeSource();
  return `<title>${esc(model.title)}</title>
<style id="${STYLE_EL}">
${css}
</style>
${S} type="application/json" id="${MODEL_EL}">
${embed(model)}
${E}
<div class="la-shell"><div id="la-root"></div></div>
${S} id="${RUNTIME_EL}">
${js}
${E}
`;
}

export function extractModel(html) {
  /* a saved model.js reads back the same way as a page */
  const mj = html.match(/^\s*window\.__laModel\s*=\s*([\s\S]*?);\s*$/);
  if (mj) return JSON.parse(mj[1]);
  const re = new RegExp(
    S + '[^>]*id="' + MODEL_EL + '"[^>]*>([\\s\\S]*?)' + E.replace(/\//g, '\\/'), 'i');
  const m = html.match(re);
  if (!m) throw new Error(`no <script id="${MODEL_EL}"> found in this page`);
  return JSON.parse(m[1].replace(/\\u003c/g, '<'));
}

/* --- validation: catch what only shows up after publishing ---------------- */
export function validate(model) {
  const errs = [];
  if (!model.docId) errs.push('docId is required (it is the db path segment)');
  else if (!/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(model.docId))
    errs.push(`docId "${model.docId}" is not a legal db path segment`);
  if (!model.title) errs.push('title is required');
  if (!Array.isArray(model.blocks) || !model.blocks.length) errs.push('blocks must be a non-empty array');
  const seen = new Set();
  for (const b of model.blocks ?? []) {
    if (!b.id) errs.push('every block needs a stable id');
    else if (seen.has(b.id)) errs.push(`duplicate block id "${b.id}" — ids must be stable AND unique`);
    seen.add(b.id);
    if (!b.type) errs.push(`block ${b.id} has no type`);
    if (b.type === 'raw' && !b.html)
      errs.push(`raw block ${b.id} has no html — a raw block's content field is "html", not "text"`);
    if (b.type === 'mermaid' && !b.text)
      errs.push(`mermaid block ${b.id} has no text — the diagram source IS the block`);
    if (b.type === 'figure' && !b.src && !b.svg && !b.caption)
      errs.push(`figure block ${b.id} has no svg, src or caption — an empty figure says nothing`);
    if (b.type === 'figure' && b.labels && typeof b.labels !== 'object')
      errs.push(`figure block ${b.id}: labels must be an object of name -> text`);
  }
  return errs;
}

/* --- export --------------------------------------------------------------
 * Rendered by booting the real runtime in jsdom and calling the same
 * buildStatic() the page's own "Build this version" button uses. Reusing the
 * page's renderer rather than reimplementing it here is the point: a second
 * renderer would drift from the first within two changes. */
export async function exportStatic(model, tags) {
  const { JSDOM } = await import('jsdom');
  const body = buildBody(model);
  const dom = new JSDOM(
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
    {
      runScripts: 'dangerously', url: 'https://export.local/',
      beforeParse(w) { w.claude = { use: async () => null }; }
    }
  );
  await new Promise((r) => setTimeout(r, 60));
  const la = dom.window.__la;
  if (!la) throw new Error('the runtime did not boot — cannot render the export');
  if (tags && tags.length) la.setFilter(tags);
  const html = la.buildStatic();
  /* from the model, not the DOM: folding hides blocks on screen and they are
     still in the export, so a DOM count under-reports it. */
  const kept = la.count();
  dom.window.close();
  return { html, kept };
}

/* --- cli ----------------------------------------------------------------- */
const [cmd, input, output] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === 'build') {
    const model = JSON.parse(readFileSync(input, 'utf8'));
    const errs = validate(model);
    if (errs.length) {
      console.error('invalid document model:\n  - ' + errs.join('\n  - '));
      process.exit(1);
    }
    const out = output ?? join(REPO, 'dist', basename(input).replace(/\.(doc\.)?json$/, '') + '.html');
    mkdirSync(dirname(out), { recursive: true });
    const body = buildBody(model);
    writeFileSync(out, body);
    console.log(`${out}  (${(body.length / 1024).toFixed(1)} KB, ${model.blocks.length} blocks, rev ${model.rev ?? 0})`);
  } else if (cmd === 'shell') {
    const model = JSON.parse(readFileSync(input, 'utf8'));
    const errs = validate(model);
    if (errs.length) { console.error('invalid document model:\n  - ' + errs.join('\n  - ')); process.exit(1); }
    const dir = output ?? join(REPO, 'dist', basename(input).replace(/\.(doc\.)?json$/, ''));
    writeShell(model, dir);
    console.log(`${dir}/  index.html + model.js (${(modelJs(model).length / 1024).toFixed(1)} KB, ${model.blocks.length} blocks, rev ${model.rev ?? 0}) + runtime.js + style.css`);
  } else if (cmd === 'ds') {
    const dir = input ?? join(REPO, 'dist', 'design-system');
    writeDesignSystem(dir);
    console.log(`${dir}/  runtime.js + style.css + index.html`);
  } else if (cmd === 'export') {
    const args = process.argv.slice(3);
    const file = args.find((a) => !a.startsWith('--') && /\.json$/.test(a));
    const outArg = args.find((a) => !a.startsWith('--') && /\.html$/.test(a));
    const tagArg = args.find((a) => a.startsWith('--tags'));
    const tags = tagArg
      ? (tagArg.includes('=') ? tagArg.split('=')[1] : args[args.indexOf(tagArg) + 1] || '')
        .split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
      : [];
    const model = JSON.parse(readFileSync(file, 'utf8'));
    const { html, kept } = await exportStatic(model, tags);
    const suffix = tags.length ? '-' + tags.join('-').replace(/[^A-Za-z0-9-]/g, '') : '-full';
    const out = outArg ?? join(REPO, 'dist', basename(file).replace(/\.(doc\.)?json$/, '') + suffix + '.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    console.log(`${out}  (${(html.length / 1024).toFixed(1)} KB, ${kept} of ${model.blocks.length} blocks`
      + `${tags.length ? ', labels ' + tags.map((t) => '#' + t).join(' ') : ', unfiltered'}, no editor)`);
  } else if (cmd === 'extract') {
    const model = extractModel(readFileSync(input, 'utf8'));
    const out = output ?? join(REPO, 'examples', model.docId + '.doc.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(model, null, 2) + '\n');
    console.log(`${out}  (rev ${model.rev}, ${model.blocks.length} blocks, ${(model.journal ?? []).length} journal entries)`);
  } else {
    console.error('usage: build.mjs build <doc.json> [out.html]'
      + ' | export <doc.json> [--tags a,b] [out.html]'
      + ' | extract <page.html> [out.json]');
    process.exit(1);
  }
}
