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
import { readFileSync, writeFileSync, mkdirSync, realpathSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
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

/* The commit a generated file was built from, so the published copy can say
 * which source it came from. The shared design-system artifact is republished
 * by hand from more than one session, and `dist/` is gitignored — so the
 * published file is the only copy of what every document runs. Without this,
 * reconciling two sessions' builds means diffing 240 KB of generated text by
 * eye; with it, it is a `git diff` between two SHAs. */
export function buildStamp() {
  let sha = 'unknown', dirty = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    const status = execSync('git status --porcelain runtime templates', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    /* A dirty build is legitimate while developing and dangerous to publish:
       its SHA does not describe it, so say so in the file itself. */
    if (status) dirty = ' +uncommitted-changes';
  } catch (e) { /* not a git checkout: say unknown rather than guess */ }
  return `living-artifacts ${sha}${dirty} · built ${new Date().toISOString().slice(0, 10)}`;
}

export function styleBundle() {
  return `/* ${buildStamp()} */\n`
    + readFileSync(join(REPO, 'runtime/brand/tokens.css'), 'utf8') + '\n'
    + readFileSync(join(REPO, 'runtime/house.css'), 'utf8') + '\n'
    + readFileSync(join(REPO, 'runtime/desk.css'), 'utf8') + '\n'
    + readFileSync(join(REPO, 'runtime/brief.css'), 'utf8') + '\n'
    + readFileSync(join(REPO, 'runtime/la-style.css'), 'utf8');
}
export function runtimeSource() {
  const js = readFileSync(join(REPO, 'runtime/la-runtime.js'), 'utf8');
  if (js.includes('<' + '/script')) {
    throw new Error('la-runtime.js contains a literal closing script tag — it cannot be re-emitted.');
  }
  return `/* ${buildStamp()} */\n` + js;
}

/* --- the shared-runtime form --------------------------------------------
 * A document is a small shell plus its model. The runtime and the stylesheet
 * are the design system's files, copied server-side into every document at
 * publish, so they are shipped once and never re-read. The page saves
 * model.js and nothing else. */

/* --- icons a document uses -------------------------------------------------
 * The brand set is 43 icons and the runtime is inlined into every document, so
 * the runtime carries only the one it draws as chrome. An icon a DOCUMENT names
 * travels with that document instead: collected from the model at build time,
 * validated against the set, and emitted beside the model. A document pays for
 * the icons it uses and for no others. */
export function documentIcons(model) {
  const want = new Set();
  for (const b of model.blocks ?? []) if (b.icon) want.add(String(b.icon));
  if (!want.size) return {};
  let all;
  try { all = JSON.parse(readFileSync(join(REPO, 'runtime/brand/icons.json'), 'utf8')); }
  catch (e) { throw new Error('runtime/brand/icons.json is missing — run `build.mjs brand`'); }
  const out = {}, unknown = [];
  for (const name of [...want].sort()) {
    if (all[name]) out[name] = all[name];
    else unknown.push(name);
  }
  if (unknown.length) {
    throw new Error(`no such icon: ${unknown.join(', ')}.\n`
      + `The set is: ${Object.keys(all).sort().join(', ')}`);
  }
  return out;
}
export function iconsJs(model) {
  const icons = documentIcons(model);
  return Object.keys(icons).length
    ? 'window.__laIcons = ' + JSON.stringify(icons) + ';\n' : '';
}

export function modelJs(model) {
  normaliseNotes(model);
  return iconsJs(model) + 'window.__laModel = ' + JSON.stringify(model, null, 1) + ';\n';
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
<!-- model rev ${model.rev || 0} -->
<div id="la-root" data-rev="${model.rev || 0}"></div>
${S} src="model.js">${E}
${S} src="runtime.js">${E}
</body>
</html>
`;
}
export function writeShell(model, dir) {
  normaliseNotes(model);
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
</div>
${iconSheet()}
</div></div></body></html>
`);
}

/* The brand icon set, rendered so it can be judged rather than described.
 * It is a DOMAIN set — crawling, indexing, traffic — not a UI-chrome set:
 * of 43 icons exactly one (`info`) names something this runtime's controls do.
 * So the sheet is here to decide what a document's CONTENT can reach for, and
 * the runtime keeps its text glyphs for the rest. */
function iconSheet() {
  let icons;
  try { icons = JSON.parse(readFileSync(join(REPO, 'runtime/brand/icons.json'), 'utf8')); }
  catch (e) { return ''; }
  const names = Object.keys(icons).sort();
  const cells = names.map((n) => `<figure style="margin:0;text-align:center">`
    + `<svg viewBox="0 0 24 24" style="width:26px;height:26px;color:var(--ink)" aria-hidden="true">${icons[n]}</svg>`
    + `<figcaption style="font-size:10.5px;color:var(--muted);margin-top:6px;word-break:break-word">${esc(n)}</figcaption>`
    + `</figure>`).join('');
  return `<h2 style="margin-top:44px">The icon set</h2>
<p class="muted" style="max-width:62ch">${names.length} icons, 24x24, drawn in <code>currentColor</code>: each one takes the colour of whatever it sits in, so there is no light and dark variant to keep in step. One of them, <code>info</code>, is chrome and the runtime draws it. The rest name things a document can be <em>about</em>.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:18px 10px;margin-top:20px">${cells}</div>`;
}

/* The single-file form carries the same icons the shell form puts in model.js. */
function iconsScript(model) {
  const js = iconsJs(model);
  return js ? `${S}>\n${js}${E}\n` : '';
}
export function buildBody(model) {
  normaliseNotes(model);
  const css = styleBundle();
  const js = runtimeSource();
  return `<title>${esc(model.title)}</title>
<style id="${STYLE_EL}">
${css}
</style>
${S} type="application/json" id="${MODEL_EL}">
${embed(model)}
${E}
${iconsScript(model)}<div class="la-shell"><div id="la-root"></div></div>
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


/* --- the brand, vendored ---------------------------------------------------
 * The runtime inlines its stylesheet into every document, so it cannot link to
 * the Verbolia design system at render time: the brand has to be COPIED in.
 * A copy drifts, which is exactly what happened — the runtime's hand-mapped
 * tints had moved off the brand's own values and nobody could see it. So the
 * copy is generated, carries the version it came from, and is refreshed by one
 * command rather than edited.
 *
 *   node runtime/build.mjs brand [path-to-verbolia-design-system]
 *
 * With no path it resolves the repo from the design-system skill's symlink,
 * the same way the living-artifacts skill resolves this one. */
export function brandRepo(explicit) {
  if (explicit) return explicit;
  const link = join(homedir(), '.claude/skills/verbolia-design-system');
  try {
    const target = realpathSync(link);          // .../<repo>/skills/verbolia-design-system
    return dirname(dirname(target));
  } catch (e) {
    throw new Error('cannot find the Verbolia design system: pass its path, or symlink'
      + ' its skill into ~/.claude/skills/verbolia-design-system');
  }
}

/* The icons the runtime itself draws. Everything else in the brand set is for
 * a document's content, not for chrome. */
export const RUNTIME_ICONS = ['info'];

export function vendorBrand(repo) {
  const bundle = join(repo, 'claude-design');
  const readme = readFileSync(join(bundle, 'README.md'), 'utf8');
  const version = (readme.match(/@verbolia\/design-system v([\d.]+)/) || [])[1] || 'unknown';
  const out = join(REPO, 'runtime/brand');
  mkdirSync(out, { recursive: true });
  const stamp = (what, src) =>
    `/* ${what}\n   Copied from @verbolia/design-system v${version} (${src}).\n`
    + `   Generated by \`build.mjs brand\` — do not edit by hand; edit the brand\n`
    + `   repo and run it again. */\n`;

  const tokens = readFileSync(join(bundle, 'tokens.css'), 'utf8');
  writeFileSync(join(out, 'tokens.css'),
    stamp('Verbolia design tokens.', 'claude-design/tokens.css') + tokens);

  /* The wordmark goes straight into the runtime as a data URI, because the
     runtime is one file and a document carries it inlined. An SVG data URI is
     utf8, not base64: it stays readable and it is a tenth of the size the
     exported PNG was (41 KB of base64 for a 1415x180 raster). */
  const uri = (svg) => 'data:image/svg+xml,' + encodeURIComponent(
    svg.trim().replace(/\s*\n\s*/g, ' ')).replace(/'/g, '%27');
  const logos = {};
  for (const [key, name] of [['DK_LOGO', 'verbolia-wordmark-black'],
                             ['DK_LOGO_WHITE', 'verbolia-wordmark-white']]) {
    logos[key] = uri(readFileSync(join(bundle, 'logos/svg', name + '.svg'), 'utf8'));
  }
  /* The whole icon set is vendored for the reference page, but only the icons
     the runtime actually draws go INTO the runtime: it is inlined into every
     document, and 24 KB of icons nobody uses is paid for on every save. Adding
     one to the chrome means adding its name here, deliberately. */
  const iconDir = join(bundle, 'icons/svg');
  const all = {};
  for (const f of readdirSync(iconDir).filter((n) => n.endsWith('.svg'))) {
    const svg = readFileSync(join(iconDir, f), 'utf8');
    const inner = (svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/) || [])[1];
    if (!inner) throw new Error(`cannot read the icon ${f}`);
    all[f.replace(/\.svg$/, '')] = inner.trim();
  }
  writeFileSync(join(out, 'icons.json'), JSON.stringify(all, null, 1) + '\n');

  const used = {};
  for (const name of RUNTIME_ICONS) {
    if (!all[name]) throw new Error(`the design system has no icon "${name}"`);
    used[name] = all[name];
  }

  const rtPath = join(REPO, 'runtime/la-runtime.js');
  let rt = readFileSync(rtPath, 'utf8');
  let patched = 0;
  for (const [key, value] of Object.entries(logos)) {
    const re = new RegExp(`(var ${key} = ')[^']*(')`);
    if (re.test(rt)) { rt = rt.replace(re, `$1${value}$2`); patched++; }
  }
  if (patched !== 2) {
    throw new Error(`expected to patch DK_LOGO and DK_LOGO_WHITE in la-runtime.js, patched ${patched}`);
  }
  const iconRe = /(var ICONS = )\{[\s\S]*?\};/;
  if (!iconRe.test(rt)) throw new Error('cannot find the ICONS map in la-runtime.js');
  rt = rt.replace(iconRe, `$1${JSON.stringify(used, null, 1)};`);
  writeFileSync(rtPath, rt);
  return { version, out, logos: patched, icons: Object.keys(all).length, inRuntime: RUNTIME_ICONS };
}

/* The read-mode layouts, read out of the runtime's own TEMPLATES registry so
 * there is one list and not two. A template added to the runtime is accepted
 * here the moment it is registered there. */
export function knownTemplates() {
  const src = readFileSync(join(REPO, 'runtime/la-runtime.js'), 'utf8');
  const block = src.match(/var TEMPLATES = \{([\s\S]*?)\n  \};/);
  if (!block) throw new Error('cannot find the TEMPLATES registry in la-runtime.js');
  return [...block[1].matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
}


/* --- document templates ----------------------------------------------------
 * A LAYOUT says how a page is drawn: house, desk-research, brief. It lives in
 * the runtime and this repo owns it.
 *
 * A DOCUMENT TEMPLATE says which sections a document has, what each one is FOR
 * and which ones a format demands. That is content structure, and it belongs to
 * whoever owns the domain — the Verbolia PRD format, the two-stage one, a Jira
 * spec. The model has carried it all along: `info` holds the template's own
 * description of a section, `badge` records which format demanded it, and an
 * empty section keeps its heading so leaving it empty stays a visible decision.
 * What was missing was a file, so a template was retyped from prose each time.
 *
 *   node runtime/build.mjs new <docId> --template <file> [--title "..."] [out.json]
 *
 * It writes a model whose sections are all present and all empty. */
export function validateTemplate(t) {
  const errs = [];
  if (!t || typeof t !== 'object') return ['a template must be an object'];
  if (!t.name) errs.push('name is required — it is what a document records as its format');
  if (!Array.isArray(t.sections) || !t.sections.length) errs.push('sections must be a non-empty array');
  if (t.layout && !knownTemplates().includes(t.layout))
    errs.push(`layout "${t.layout}" is not a read-mode layout — known: ${knownTemplates().join(', ')}`);
  const seen = new Set();
  for (const [i, sec] of (t.sections ?? []).entries()) {
    const at = `section ${i + 1}${sec && sec.text ? ` ("${sec.text}")` : ''}`;
    if (!sec || !sec.text) { errs.push(`${at} has no text`); continue; }
    const lvl = sec.level ?? 2;
    if (![2, 3, 4].includes(lvl)) errs.push(`${at}: level must be 2, 3 or 4`);
    if (i === 0 && lvl !== 2) errs.push(`${at}: the first section must be level 2 — it is the document's first tab`);
    const key = `${lvl}:${sec.text}`;
    if (seen.has(key)) errs.push(`${at}: two sections at the same level share a name`);
    seen.add(key);
  }
  return errs;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/* Section ids are derived from the template and the section name, so the same
 * template always produces the same ids: a document regenerated from it keeps
 * every note, tag and change mark anchored where it was. */
export function scaffold(t, { docId, title, thread, component } = {}) {
  const used = new Set();
  const blocks = t.sections.map((sec) => {
    let id = `h-${slug(sec.text)}`;
    let n = 2;
    while (used.has(id)) id = `h-${slug(sec.text)}-${n++}`;
    used.add(id);
    const b = { id, type: 'heading', level: sec.level ?? 2, text: sec.text, tags: [], author: 'claude' };
    if (sec.eyebrow) b.eyebrow = sec.eyebrow;
    /* the template's OWN words, never a gloss written over them */
    if (sec.info) b.info = sec.info;
    /* badge what the format demands, leave what a document adds bare: the
       contrast is the information */
    if (sec.required && (sec.badge ?? t.badge)) b.badge = sec.badge ?? t.badge;
    return b;
  });
  const model = {
    v: 1,
    docId: docId ?? slug(title ?? t.name),
    title: title ?? t.title ?? t.name,
    template: t.layout ?? 'house',
    format: t.name,
    rev: 0,
    blocks
  };
  if (thread) model.thread = thread;
  if (component) model.component = component;
  return model;
}


/* --- notes: one list per element -------------------------------------------
 * Mirrors normaliseNotes() in la-runtime.js, for the build side: a seed written
 * under the old one-string-per-element shape is migrated when it is built, and
 * a model pulled down from a page is already in this shape. Keep the two in
 * step; the runtime's is the one the page runs. */
function noteEntries(text, done, doneRev) {
  if (!text) return [];
  const e = { id: 'n1', text };
  if (done) e.done = done;
  if (doneRev != null) e.doneRev = doneRev;
  return [e];
}
export function normaliseNotes(m) {
  for (const b of m.blocks ?? []) {
    if (!Array.isArray(b.notes)) b.notes = noteEntries(b.note, b.noteDone, b.noteDoneRev);
    delete b.note; delete b.noteDone; delete b.noteDoneRev;
    if (!b.notes.length) delete b.notes;
    if (b.cellNotes) {
      for (const k of Object.keys(b.cellNotes)) {
        if (!Array.isArray(b.cellNotes[k])) {
          b.cellNotes[k] = noteEntries(b.cellNotes[k], (b.cellNotesDone ?? {})[k], (b.cellNotesDoneRev ?? {})[k]);
        }
        if (!b.cellNotes[k].length) delete b.cellNotes[k];
      }
      if (!Object.keys(b.cellNotes).length) delete b.cellNotes;
    }
    delete b.cellNotesDone; delete b.cellNotesDoneRev;
    for (const mk of b.marks ?? []) {
      if (!Array.isArray(mk.notes)) mk.notes = noteEntries(mk.note, mk.noteDone, mk.noteDoneRev);
      delete mk.note; delete mk.noteDone; delete mk.noteDoneRev;
      if (!mk.notes.length) delete mk.notes;
    }
  }
  return m;
}

/* --- validation: catch what only shows up after publishing ---------------- */
export function validate(model) {
  const errs = [];
  if (!model.docId) errs.push('docId is required (it is the db path segment)');
  else if (!/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(model.docId))
    errs.push(`docId "${model.docId}" is not a legal db path segment`);
  if (!model.title) errs.push('title is required');
  if (!Array.isArray(model.blocks) || !model.blocks.length) errs.push('blocks must be a non-empty array');
  if (model.template && !knownTemplates().includes(model.template))
    errs.push(`template "${model.template}" is not a read-mode layout — known: ${knownTemplates().join(', ')}.`
      + ' A document never brings its own layout; add one to the runtime instead.');
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
    if (b.type === 'prototype' && !b.html)
      errs.push(`prototype block ${b.id} has no html — the screen IS the block`);
    if (b.type === 'prototype' && b.labels && typeof b.labels !== 'object')
      errs.push(`prototype block ${b.id}: labels must be an object of data-la-text key -> text`);
    if (b.type === 'prototype' && b.html && b.labels) {
      /* a string the screen cannot show is a string the reader edits for nothing */
      for (const k of Object.keys(b.labels)) {
        if (!new RegExp(`data-la-text=["']${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(b.html))
          errs.push(`prototype block ${b.id}: label "${k}" has no data-la-text="${k}" element in the screen`);
      }
    }
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
    let body;
    try { body = buildBody(model); }
    catch (e) { console.error(e.message); process.exit(1); }
    writeFileSync(out, body);
    console.log(`${out}  (${(body.length / 1024).toFixed(1)} KB, ${model.blocks.length} blocks, rev ${model.rev ?? 0})`);
  } else if (cmd === 'shell') {
    const model = JSON.parse(readFileSync(input, 'utf8'));
    const errs = validate(model);
    if (errs.length) { console.error('invalid document model:\n  - ' + errs.join('\n  - ')); process.exit(1); }
    const dir = output ?? join(REPO, 'dist', basename(input).replace(/\.(doc\.)?json$/, ''));
    try { writeShell(model, dir); }
    catch (e) { console.error(e.message); process.exit(1); }
    console.log(`${dir}/  index.html + model.js (${(modelJs(model).length / 1024).toFixed(1)} KB, ${model.blocks.length} blocks, rev ${model.rev ?? 0}) + runtime.js + style.css`);
  } else if (cmd === 'new') {
    const args = process.argv.slice(3);
    const flag = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };
    const positional = args.filter((a, i) =>
      !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
    const docId = positional[0];
    if (!docId) { console.error('usage: build.mjs new <docId> --template <file> [--title "..."] [out.json]'); process.exit(1); }
    const tplPath = flag('template');
    if (!tplPath) { console.error('a document needs a template: --template <file>'); process.exit(1); }
    const tpl = JSON.parse(readFileSync(tplPath, 'utf8'));
    const terrs = validateTemplate(tpl);
    if (terrs.length) { console.error('invalid template:\n  - ' + terrs.join('\n  - ')); process.exit(1); }
    const model = scaffold(tpl, {
      docId, title: flag('title'), thread: flag('thread'), component: flag('component')
    });
    const merrs = validate(model);
    if (merrs.length) { console.error('the template produced an invalid model:\n  - ' + merrs.join('\n  - ')); process.exit(1); }
    const out = positional[1] ?? join(REPO, 'docs', docId, docId + '.doc.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(model, null, 2) + '\n');
    const demanded = model.blocks.filter((b) => b.badge).length;
    console.log(`${out}  (${model.blocks.length} sections from "${tpl.name}", ${demanded} the format demands,`
      + ` layout ${model.template}, all empty)`);
  } else if (cmd === 'brand') {
    const repo = brandRepo(input);
    const vendored = vendorBrand(repo);
    const { version, out } = vendored;
    console.log(`${out}/  tokens.css  (design-system v${version}, from ${repo})`
      + `\n  runtime/brand/icons.json  ${vendored.icons} icons`
      + `\n  la-runtime.js  wordmark + ${vendored.inRuntime.length} chrome icon(s): ${vendored.inRuntime.join(', ')}`);
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
    const model = normaliseNotes(extractModel(readFileSync(input, 'utf8')));
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
