#!/usr/bin/env node
/* living-artifacts build tool.
 *
 *   build   <doc.json> [out.html]   model + runtime -> BODY-FORM html for the
 *                                   Artifact tool (no doctype/html/head/body:
 *                                   the tool supplies that wrapper).
 *   extract <page.html> [out.json]  pull the model back out of a published
 *                                   page — the read-back mirror after the
 *                                   human has edited and self-published.
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

export function buildBody(model) {
  const css = readFileSync(join(REPO, 'runtime/la-style.css'), 'utf8');
  const js = readFileSync(join(REPO, 'runtime/la-runtime.js'), 'utf8');
  if (js.includes('<' + '/script')) {
    throw new Error('la-runtime.js contains a literal closing script tag — it cannot be re-emitted.');
  }
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
  }
  return errs;
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
  } else if (cmd === 'extract') {
    const model = extractModel(readFileSync(input, 'utf8'));
    const out = output ?? join(REPO, 'examples', model.docId + '.doc.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(model, null, 2) + '\n');
    console.log(`${out}  (rev ${model.rev}, ${model.blocks.length} blocks, ${(model.journal ?? []).length} journal entries)`);
  } else {
    console.error('usage: build.mjs build <doc.json> [out.html] | extract <page.html> [out.json]');
    process.exit(1);
  }
}
