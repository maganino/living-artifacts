#!/usr/bin/env node
/* Headless drive of the runtime. A published artifact cannot be debugged
 * after the fact, so every handler is exercised here first — and the last
 * test is the one that matters: a document the PAGE published must boot
 * itself again, unchanged. */
import { JSDOM } from 'jsdom';
import { buildBody, extractModel, validate } from './build.mjs';

let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failed++; }
};
const eq = (name, a, b) => ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const fixture = () => ({
  v: 1, docId: 'smoke-doc', title: 'Smoke Doc', thread: 'tests', component: 'Runtime',
  rev: 3, style: { directives: [{ id: 's1', text: 'no hedging', rev: 1, active: true }] },
  blocks: [
    { id: 'b-one', type: 'heading', level: 2, text: 'First', tags: [], author: 'claude' },
    { id: 'b-two', type: 'para', text: 'Body text with **bold** and `code`.', tags: ['for:sales'], author: 'claude' },
    { id: 'b-three', type: 'list', items: ['alpha', 'beta'], tags: [], author: 'claude' },
    { id: 'b-four', type: 'table', head: ['A', 'B'], rows: [['1', '2']], tags: [], author: 'claude' },
    { id: 'b-five', type: 'para', text: 'Doomed block.', tags: [], author: 'claude' }
  ]
});

const wrap = (body, title) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function boot(html, opts = {}) {
  const published = [], dbWrites = [];
  let release = () => {};
  const gate = opts.gated ? new Promise((r) => { release = r; }) : Promise.resolve();
  const fakeDoc = (path) => ({ set: async (data) => { dbWrites.push({ path, data }); } });
  const defaultUse = async (name) => {
    if (name === 'artifact') return Object.freeze({
      publish: async (h) => { published.push(h); return { version: 'v' + published.length }; }
    });
    if (name === 'db') return Object.freeze({ doc: fakeDoc, collection: () => ({ doc: fakeDoc }) });
    return null;
  };
  const use = async (name) => { await gate; return (opts.use || defaultUse)(name); };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/',
    /* must exist BEFORE the runtime script runs, exactly as in a real viewer */
    beforeParse(window) { window.claude = { use }; }
  });
  return {
    dom, w: dom.window, get d() { return dom.window.document; },
    published, dbWrites, release
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const btn = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const blockEl = (d, id) => d.querySelector(`[data-block-id="${id}"]`);
const order = (d) => [...d.querySelectorAll('.la-block')].map((b) => b.dataset.blockId);

console.log('\nvalidate()');
{
  const bad = fixture(); bad.docId = 'has spaces'; bad.blocks[1].id = 'b-one';
  const errs = validate(bad);
  ok('rejects an illegal docId', errs.some((e) => /legal db path segment/.test(e)));
  ok('rejects duplicate block ids', errs.some((e) => /duplicate block id/.test(e)));
  eq('accepts a good model', validate(fixture()).length, 0);
}

console.log('\nrender + capability gating');
const body = buildBody(fixture());
const env = boot(wrap(body, 'Smoke Doc'), { gated: true });
const d = env.d;
await settle();
ok('renders before capabilities resolve', !!d.querySelector('.la-block'));
eq('renders every block', d.querySelectorAll('.la-block').length, 5);
ok('starts read-only', /read-only/i.test(d.getElementById('la-status').textContent));
ok('read-only view shows no affordances', !d.querySelector('.la-handle') && !d.querySelector('.la-acts'));
ok('inline markdown renders', !!blockEl(d, 'b-two').querySelector('strong') && !!blockEl(d, 'b-two').querySelector('code'));
ok('table renders rows', blockEl(d, 'b-four').querySelectorAll('tbody tr').length === 1);
env.release();
await settle();
ok('editing lights up once artifact resolves', !!d.querySelector('.la-handle'));
ok('every block gets its own chrome', d.querySelectorAll('.la-acts').length === 5);
ok('save button starts disabled', btn(d.body, 'Save').disabled === true);
ok('the status line says how to drive it', /click a block to edit/i.test(d.getElementById('la-status').textContent));

console.log('\nC-3: click the box to edit, no selection step');
blockEl(d, 'b-two').querySelector('.la-body').click();
const ta = blockEl(d, 'b-two').querySelector('textarea');
ok('a click on the body opens the editor', !!ta && ta.value.includes('**bold**'));
ta.value = 'Rewritten by the human.';
btn(blockEl(d, 'b-two'), 'Apply').click();
ok('applying updates the rendered body', blockEl(d, 'b-two').textContent.includes('Rewritten by the human'));
ok('applying marks the block touched', blockEl(d, 'b-two').dataset.touched === '1');
ok('save button enables once dirty', btn(d.body, 'Save').disabled === false);

console.log('\nC-1: tag a whole block, and tag a highlighted passage');
btn(blockEl(d, 'b-one'), 'tag').click();
{
  const inp = blockEl(d, 'b-one').querySelector('.la-taginput');
  ok('the block tag form has no quote chip', !blockEl(d, 'b-one').querySelector('.la-quote'));
  inp.value = '#expand';
  btn(blockEl(d, 'b-one'), '+ tag').click();
}
ok('whole-block tag lands, # stripped',
  [...blockEl(d, 'b-one').querySelectorAll('.la-tag')].some((c) => c.textContent === '#expand'));
ok('intent tags are styled apart from audience tags', !!blockEl(d, 'b-one').querySelector('.la-tag.intent'));

/* native text selection has no geometry in jsdom; the same path the selection
   chip calls is reachable directly */
env.w.__la.offerTag('b-three', 'beta');
ok('a highlighted passage shows its quote in the form', !!blockEl(d, 'b-three').querySelector('.la-quote'));
{
  blockEl(d, 'b-three').querySelector('.la-taginput').value = 'verify';
  btn(blockEl(d, 'b-three'), '+ tag').click();
}
ok('the tagged passage is highlighted in place', !!blockEl(d, 'b-three').querySelector('mark.la-mark'));
eq('only the highlighted passage is marked',
  blockEl(d, 'b-three').querySelector('mark.la-mark').textContent, 'beta');
ok('the range tag chip carries its quote',
  /verify.*beta/s.test(blockEl(d, 'b-three').querySelector('.la-tag.ranged').textContent));

console.log('\nC-2 / C-4: drag handle reorder, ✕ delete');
ok('the reorder handle is a drag handle', !!blockEl(d, 'b-three').querySelector('.la-handle'));
ok('the old ↑ / ↓ buttons are gone', !btn(blockEl(d, 'b-three'), '↓') && !btn(blockEl(d, 'b-three'), '↑'));
{
  const before = order(d);
  const handle = blockEl(d, 'b-three').querySelector('.la-handle');
  handle.dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  ok('keyboard reorder works on the focused handle (a11y path)',
    before.indexOf('b-three') - order(d).indexOf('b-three') === 1);
}
{
  const before = order(d);
  env.w.__la.moveTo('b-one', 3);
  ok('drag-drop reorder moves to an arbitrary index',
    order(d).indexOf('b-one') === 3 && before.indexOf('b-one') === 0);
}
btn(blockEl(d, 'b-five'), '✕').click();
ok('✕ deletes the block', !blockEl(d, 'b-five'));

console.log('\nnote + C-5: the writing rules panel explains itself');
btn(blockEl(d, 'b-two'), 'note').click();
{
  blockEl(d, 'b-two').querySelector('.la-noteform input').value = 'contradicts the completeness artifact';
  btn(blockEl(d, 'b-two'), 'Save note').click();
}
ok('note renders anchored to its block', /contradicts/.test(blockEl(d, 'b-two').querySelector('.la-note').textContent));
{
  const c = d.querySelector('.la-contract');
  ok('the panel is no longer labelled "Style contract"', !/style contract/i.test(c.querySelector('summary').textContent));
  ok('the panel says what it is for', !!c.querySelector('.la-contract-help'));
  ok('the panel is open by default', c.open === true);
  c.querySelector('input').value = 'lead with the number, not the caveat';
  btn(c, 'Add rule').click();
}
ok('a writing rule is added', /lead with the number/.test(d.querySelector('.la-contract').textContent));

console.log('\nsave -> journal + publish');
btn(d.body, 'Save').click();
await settle();
eq('published exactly once', env.published.length, 1);
ok('published html is a full document', env.published[0].startsWith('<!doctype html>'));
const journalWrite = env.dbWrites.find((w) => /\/journal\/r4$/.test(w.path));
ok('journal is one document per revision', !!journalWrite, env.dbWrites.map((w) => w.path).join(', '));
const opKinds = journalWrite ? journalWrite.data.ops.map((o) => o.op) : [];
ok('journal captured every op kind',
  ['edit', 'tag', 'note', 'move', 'delete', 'style'].every((k) => opKinds.includes(k)), opKinds.join(','));
{
  const del = journalWrite.data.ops.find((o) => o.op === 'delete');
  ok('deleted text is preserved in the journal', /Doomed block/.test(del.text));
  const ed = journalWrite.data.ops.find((o) => o.op === 'edit');
  ok('edit op carries before and after', /\*\*bold\*\*/.test(ed.before) && /Rewritten/.test(ed.after));
  const ranged = journalWrite.data.ops.find((o) => o.op === 'tag' && o.quote);
  ok('a passage tag reaches Claude with its quote', ranged && ranged.quote === 'beta' && ranged.tag === 'verify');
}
{
  const reg = env.dbWrites.find((w) => w.path === 'docs/smoke-doc');
  ok('registry counts block tags and passage tags alike',
    reg.data.tagCounts.expand === 1 && reg.data.tagCounts.verify === 1);
  eq('registry counts open notes', reg.data.openNotes, 1);
  ok('registry carries active writing rules', reg.data.styleDirectives.length === 2);
}

console.log('\nround-trip: the page republishes ITSELF');
const out = env.published[0];
const m2 = extractModel(out);
eq('revision incremented', m2.rev, 4);
eq('block removed from the model', m2.blocks.length, 4);
eq('edited text landed in the model', m2.blocks.find((b) => b.id === 'b-two').text, 'Rewritten by the human.');
ok('passage tags survive as anchored quotes',
  m2.blocks.find((b) => b.id === 'b-three').marks[0].quote === 'beta');
ok('only this revision stays marked', m2.blocks.filter((b) => b.touched).every((b) => b.touched.rev === 4));
ok('journal embedded as a fallback to db', (m2.journal || []).some((e) => e.rev === 4));

const env2 = boot(out);
await settle();
eq('self-published document boots again', env2.d.querySelectorAll('.la-block').length, 4);
ok('runtime survived re-emission intact', !!env2.d.querySelector('.la-handle'));
ok('the highlight survives re-emission', !!env2.d.querySelector('mark.la-mark'));
{
  blockEl(env2.d, 'b-one').querySelector('.la-body').click();
  const ta2 = blockEl(env2.d, 'b-one').querySelector('textarea');
  ta2.value = 'Second generation edit';
  btn(blockEl(env2.d, 'b-one'), 'Apply').click();
  btn(env2.d.body, 'Save').click();
  await settle();
  const m3 = extractModel(env2.published[0]);
  eq('a second self-publish still round-trips', m3.rev, 5);
  ok('generation-2 edit landed', m3.blocks.find((b) => b.id === 'b-one').text === 'Second generation edit');
  ok('generation-1 marks were cleared', m3.blocks.filter((b) => b.touched).length === 1);
}

console.log('\nfailure paths');
{
  const e3 = boot(wrap(buildBody(fixture()), 'x'), { use: async () => null });
  await settle();
  ok('stays read-only when capabilities are absent',
    /read-only/i.test(e3.d.getElementById('la-status').textContent));
}
{
  const e4 = boot(wrap(buildBody(fixture()), 'x'), {
    use: async (n) => n === 'artifact'
      ? Object.freeze({ publish: async () => { const err = new Error('nope'); err.code = 'not_writer'; throw err; } })
      : null
  });
  await settle();
  e4.w.__la.moveTo('b-one', 1);
  btn(e4.d.body, 'Save').click();
  await settle();
  ok('a not_writer rejection degrades to read-only, not an error dump',
    /read-only/i.test(e4.d.getElementById('la-status').textContent));
  ok('affordances are withdrawn on a read-only rejection', !e4.d.querySelector('.la-acts'));
}
{
  const e5 = boot(wrap(buildBody(fixture()), 'x'), {
    use: async (n) => n === 'artifact'
      ? Object.freeze({ publish: async () => { const err = new Error('c'); err.code = 'conflict'; throw err; } })
      : null
  });
  await settle();
  e5.w.__la.moveTo('b-one', 1);
  btn(e5.d.body, 'Save').click();
  await settle();
  ok('a conflict says the reload is coming, not that saving failed',
    /published first/i.test(e5.d.getElementById('la-status').textContent));
  ok('unsaved work is stashed before publish', !!e5.w.sessionStorage.getItem('la-stash:smoke-doc'));
}

console.log(failed ? `\n${failed} failing\n` : '\nall green\n');
process.exit(failed ? 1 : 0);
