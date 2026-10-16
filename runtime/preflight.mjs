#!/usr/bin/env node
/* Drive a BUILT document headlessly before publishing it. A published page
 * cannot be debugged after the fact, so every document goes through this. */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { extractModel } from './build.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: preflight.mjs <built.html>'); process.exit(1); }

const body = readFileSync(file, 'utf8');
const published = [], forms = [], jsErrors = [];
const dom = new JSDOM(
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
  {
    runScripts: 'dangerously', url: 'https://example.test/',
    virtualConsole: new (await import('jsdom')).VirtualConsole()
      .on('jsdomError', (e) => jsErrors.push(e.message)),
    beforeParse(w) {
      w.claude = {
        use: async (n) =>
          n === 'artifact' ? Object.freeze({
            publish: async (a) => {
              if (typeof a === 'string') { forms.push('html'); published.push(a); }
              else { forms.push('files'); published.push(a['index.html']); }
              return { version: 'v2' };
            }
          })
            : n === 'db' ? Object.freeze({ doc: () => ({ set: async () => {} }) })
              : null
      };
    }
  }
);
const settle = () => new Promise((r) => setTimeout(r, 60));
await settle();
const d = dom.window.document;

let bad = 0;
const line = (label, value, ok) => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(26)} ${value}`);
};

const model = extractModel(body);
/* Addressability is checked by data-block-id, which every layout emits, and
   never by a layout's own class: the page wraps blocks in `.la-blk` and the
   outline in `.la-block`, so asserting either one made a document that was
   perfectly fine report two failures.

   The tabbed house layout renders a level-2 heading as a tab BUTTON, so it is
   the one block a writer cannot open in place. That is a property of that
   layout, not a fault in the document, so it is reported and not failed. Any
   other block missing its wrapper is a real fault: nothing can tag it, note
   it or edit it. */
const seen = new Set([...d.querySelectorAll('[data-block-id]')].map((n) => n.dataset.blockId));
const missing = model.blocks.filter((b) => !seen.has(b.id));
const tabHeads = missing.filter((b) => b.type === 'heading' && (b.level ?? 2) === 2);
const lost = missing.filter((b) => !tabHeads.includes(b));
line('blocks addressable', `${seen.size} / ${model.blocks.length}`
  + (tabHeads.length ? ` (${tabHeads.length} level-2 heading${tabHeads.length > 1 ? 's' : ''} render as tabs)` : ''),
  lost.length === 0);
if (lost.length) line('  unreachable blocks', lost.map((b) => `${b.id}:${b.type}`).join(', '), false);
line('editor lit up', String(!!d.querySelector('.la-handle')), !!d.querySelector('.la-handle'));
line('hover chrome', `${d.querySelectorAll('.la-acts').length} of ${seen.size} addressable`,
  d.querySelectorAll('.la-acts').length === seen.size);
line('no js errors', jsErrors.length ? jsErrors.join('; ') : 'none', jsErrors.length === 0);
line('every block has an id', String(model.blocks.every((b) => b.id)), model.blocks.every((b) => b.id));

/* Exercise a real round: tag, edit, save, and read the model back out.
   A document scaffolded from a template is all headings and no prose — every
   section present and empty is the point of it — so the round is driven on
   whatever block is actually addressable, and skipped when none is. A level-2
   heading is a tab in the house layout and has no chrome to drive. */
const first = model.blocks.find((b) => seen.has(b.id) && b.type !== 'divider' && b.type !== 'raw');
if (!first) {
  line('a round can be driven', 'no addressable block — nothing but tabs', false);
  console.log(`\n  ${bad} failing — do not publish\n`);
  process.exit(1);
}
const host = () => d.querySelector(`[data-block-id="${first.id}"]`);
[...host().querySelectorAll('button')].find((b) => b.textContent.trim() === 'tag').click();
const tp = d.querySelector('#la-tagpop');
line('tag picker opens as a popover', String(!!tp), !!tp);
line('picker offers known tags', `${tp.querySelectorAll('.la-tagmenu-item').length}`,
  tp.querySelectorAll('.la-tagmenu-item').length > 0);
tp.querySelector('.la-taginput').value = 'preflight';
tp.querySelector('.la-taginput')
  .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await dom.window.__la.flush();
await settle();

line('autosave published once', String(published.length), published.length === 1);
line('used the non-reloading form', forms[0] ?? 'none', forms[0] === 'files');
const out = published[0] ?? '';
line('publishable full document', out.slice(0, 15), out.startsWith('<!doctype html>'));
const m2 = published.length ? extractModel(out) : { blocks: [], rev: -1 };
line('round-trips through save', `rev ${model.rev} -> ${m2.rev}`, m2.rev === (model.rev ?? 0) + 1);
line('no blocks lost', `${m2.blocks.length}`, m2.blocks.length === model.blocks.length);
line('tag landed in the model', (m2.blocks.find((b) => b.id === first.id)?.tags ?? []).join(','),
  (m2.blocks.find((b) => b.id === first.id)?.tags ?? []).includes('preflight'));
const kb = out.length / 1024;
line('published size', `${kb.toFixed(1)} KB`, kb < 16 * 1024);

console.log(bad ? `\n  ${bad} failing — do not publish\n` : '\n  clear to publish\n');
process.exit(bad ? 1 : 0);
