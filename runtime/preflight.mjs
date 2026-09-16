#!/usr/bin/env node
/* Drive a BUILT document headlessly before publishing it. A published page
 * cannot be debugged after the fact, so every document goes through this. */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { extractModel } from './build.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: preflight.mjs <built.html>'); process.exit(1); }

const body = readFileSync(file, 'utf8');
const published = [], jsErrors = [];
const dom = new JSDOM(
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
  {
    runScripts: 'dangerously', url: 'https://example.test/',
    virtualConsole: new (await import('jsdom')).VirtualConsole()
      .on('jsdomError', (e) => jsErrors.push(e.message)),
    beforeParse(w) {
      w.claude = {
        use: async (n) =>
          n === 'artifact' ? Object.freeze({ publish: async (h) => { published.push(h); return { version: 'v2' }; } })
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
line('blocks rendered', `${d.querySelectorAll('.la-block').length} / ${model.blocks.length}`,
  d.querySelectorAll('.la-block').length === model.blocks.length);
line('editor lit up', String(!!d.querySelector('.la-handle')), !!d.querySelector('.la-handle'));
line('hover chrome on every block', `${d.querySelectorAll('.la-acts').length}`,
  d.querySelectorAll('.la-acts').length === model.blocks.length);
line('no js errors', jsErrors.length ? jsErrors.join('; ') : 'none', jsErrors.length === 0);
line('every block has an id', String(model.blocks.every((b) => b.id)), model.blocks.every((b) => b.id));

/* exercise a real round: tag, edit, save, and read the model back out */
const first = model.blocks.find((b) => b.type === 'para');
const host = () => d.querySelector(`[data-block-id="${first.id}"]`);
[...host().querySelectorAll('button')].find((b) => b.textContent.trim() === 'tag').click();
host().querySelector('.la-taginput').value = 'preflight';
[...host().querySelectorAll('button')].find((b) => b.textContent.trim() === '+ tag').click();
[...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click();
await settle();

line('save published once', String(published.length), published.length === 1);
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
