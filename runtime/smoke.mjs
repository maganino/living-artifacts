#!/usr/bin/env node
/* Headless drive of the runtime. A published artifact cannot be debugged
 * after the fact, so every handler is exercised here first — and the last
 * test is the one that matters: a document the PAGE published must boot
 * itself again, unchanged. */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
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
  const published = [], forms = [], dbWrites = [];
  let release = () => {};
  const gate = opts.gated ? new Promise((r) => { release = r; }) : Promise.resolve();
  const fakeDoc = (path) => ({ set: async (data) => { dbWrites.push({ path, data }); } });
  const defaultUse = async (name) => {
    if (name === 'artifact') return Object.freeze({
      publish: async (arg) => {
        if (typeof arg !== 'string') {
          if (opts.noFilesForm) {
            const err = new Error('nope'); err.code = 'capability_disabled'; throw err;
          }
          forms.push('files'); published.push(arg['index.html'] ?? arg);
        } else { forms.push('html'); published.push(arg); }
        return { version: 'v' + published.length };
      }
    });
    if (name === 'db') return Object.freeze({ doc: fakeDoc, collection: () => ({ doc: fakeDoc }) });
    return null;
  };
  const use = async (name) => { await gate; return (opts.use || defaultUse)(name); };
  /* Most of this suite drives the outline, the flat block list that predates
     editing in the page. A writer now opens in the page by default, so the
     harness stores the outline preference the way a writer would have. A test
     that wants the page passes { page: true }. */
  const docId = (html.match(/"docId":\s*"([^"]+)"/) || [])[1];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/',
    /* must exist BEFORE the runtime script runs, exactly as in a real viewer */
    beforeParse(window) {
      window.claude = { use };
      if (!opts.page && docId) { try { window.localStorage.setItem('la-mode:' + docId, 'outline'); } catch (e) {} }
    }
  });
  return {
    dom, w: dom.window, get d() { return dom.window.document; },
    published, forms, dbWrites, release
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const btn = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const blockEl = (d, id) => d.querySelector(`[data-block-id="${id}"]`);
const pop = (d) => d.querySelector('#la-tagpop');
const pickTag = (env, name) => {
  pop(env.d).querySelector('.la-taginput').value = name;
  pop(env.d).querySelector('.la-taginput')
    .dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
};
const order = (d) => [...d.querySelectorAll('.la-block')].map((b) => b.dataset.blockId);
/* no Apply button any more: leaving the box is what keeps the edit */
const commitEdit = (env, id, text) => {
  const ta = blockEl(env.d, id).querySelector('textarea');
  ta.value = text;
  ta.dispatchEvent(new env.w.FocusEvent('blur'));
};

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
/* Before the capabilities resolve nobody is a writer yet, so the page shows
   what a reader gets: the published look, with nothing to click. */
ok('renders before capabilities resolve', !!d.querySelector('.house'));
ok('as the published view, not the editor', !d.querySelector('.la-block') && !d.getElementById('la-bar'));
ok('read-only view shows no affordances', !d.querySelector('.la-handle') && !d.querySelector('.la-acts'));
ok('inline markdown renders', !!d.querySelector('.house strong') && !!d.querySelector('.house code'));
ok('table renders rows', d.querySelectorAll('.house tbody tr').length === 1);
env.release();
await settle();
eq('the editor renders every block once artifact resolves', d.querySelectorAll('.la-block').length, 5);
ok('editing lights up once artifact resolves', !!d.querySelector('.la-handle'));
ok('every block gets its own chrome', d.querySelectorAll('.la-acts').length === 5);
ok('undo starts disabled', btn(d.body, '↶ Undo').disabled === true);
ok('no Save button until there is something to save', !btn(d.body, 'Save now'));
ok('the status line says how to drive it', /click a block to edit/i.test(d.getElementById('la-status').textContent));

console.log('\nC-3: click the box to edit, no selection step');
blockEl(d, 'b-two').querySelector('.la-body').click();
const ta = blockEl(d, 'b-two').querySelector('textarea');
ok('a click on the body opens the editor', !!ta && ta.value.includes('**bold**'));
commitEdit(env, 'b-two', 'Rewritten by the human.');
ok('clicking away keeps the edit — no Apply button', blockEl(d, 'b-two').textContent.includes('Rewritten by the human'));
ok('the committed block is marked touched', blockEl(d, 'b-two').dataset.touched === 'viewer');
ok('the Apply / Cancel buttons are gone',
  !btn(blockEl(d, 'b-two'), 'Apply') && !btn(blockEl(d, 'b-two'), 'Cancel'));
ok('undo enables once there is an edit', btn(d.body, '↶ Undo').disabled === false);
ok('a "Save now" flush appears while unsaved', !!btn(d.body, 'Save now'));
{
  const kids = [...d.getElementById('la-bar').children];
  eq('Save now sits at the left end of the bar', kids[0].textContent, 'Save now');
  ok('the status line follows it', kids[1].id === 'la-status');
  ok('the rest of the controls stay to its right',
    kids.slice(2).map((n) => n.textContent.trim().split(' ').pop()).join(',') === 'Undo,Redo,Filter,▸,▾,Page,⤓',
    kids.slice(2).map((n) => n.textContent).join('|'));
}

console.log('\nC-1: tag a whole block, and tag a highlighted passage');
btn(blockEl(d, 'b-one'), 'tag').click();
ok('the tag picker opens as a popover, not inside the block', !!pop(d) && !blockEl(d, 'b-one').querySelector('.la-taginput'));
ok('a whole-block picker shows no quote', !/\u201C/.test(pop(d).querySelector('.la-tagpop-head').textContent));
pickTag(env, '#expand');
ok('whole-block tag lands, # stripped',
  [...blockEl(d, 'b-one').querySelectorAll('.la-tag')].some((c) => c.textContent === '#expand'));
ok('the popover closes after choosing', !pop(d));
ok('intent tags are styled apart from audience tags', !!blockEl(d, 'b-one').querySelector('.la-tag.intent'));

/* native text selection has no geometry in jsdom; the same path the selection
   chip calls is reachable directly */
env.w.__la.offerTag('b-three', 'beta');
ok('a highlighted passage shows its quote in the picker',
  /beta/.test(pop(d).querySelector('.la-tagpop-head').textContent));
pickTag(env, 'verify');
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
await env.w.__la.flush();
await settle();
eq('published exactly once', env.published.length, 1);
eq('saved through the files form, so the view is not reloaded', env.forms[0], 'files');
eq('the round is cleared after a files-form save', d.querySelectorAll('.la-block').length, 4);
ok('status reports the saved revision', /saved · rev 4/i.test(d.getElementById('la-status').textContent));
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
  commitEdit(env2, 'b-one', 'Second generation edit');
  await env2.w.__la.flush();
  await settle();
  const m3 = extractModel(env2.published[0]);
  eq('a second self-publish still round-trips', m3.rev, 5);
  ok('generation-2 edit landed', m3.blocks.find((b) => b.id === 'b-one').text === 'Second generation edit');
  ok('generation-1 marks survive the second save (amber stays until a rebuild)', m3.blocks.filter((b) => b.touched && b.touched.by === 'viewer').length >= 2);
}

console.log('\nC-6: autosave + undo / redo');
{
  const e6 = boot(wrap(buildBody(fixture()), 'x'));
  await settle();
  e6.w.__la.debounce(20);
  blockEl(e6.d, 'b-one').querySelector('.la-body').click();
  commitEdit(e6, 'b-one', 'Autosaved heading');
  eq('nothing published on the edit itself', e6.published.length, 0);
  await new Promise((r) => setTimeout(r, 120));
  eq('autosave fires after the debounce with no button press', e6.published.length, 1);
  ok('and it used the non-reloading form', e6.forms[0] === 'files');
  ok('pending is cleared after autosave', /saved · rev 4/i.test(e6.d.getElementById('la-status').textContent));

  /* undo AFTER a save cannot just drop the op — it records a reversal */
  e6.w.__la.undo();
  eq('undo restores the previous text',
    blockEl(e6.d, 'b-one').textContent.includes('Autosaved heading'), false);
  await new Promise((r) => setTimeout(r, 120));
  const m = extractModel(e6.published[e6.published.length - 1]);
  eq('undo did not rewind the revision counter', m.rev, 5);
  ok('a post-save undo is journaled as a reversal',
    (m.journal[m.journal.length - 1].ops || []).some((o) => o.op === 'undo'));

  e6.w.__la.redo();
  ok('redo puts it back', blockEl(e6.d, 'b-one').textContent.includes('Autosaved heading'));
}
{
  /* an undo BEFORE the round is saved should leave no trace in the journal */
  const e7 = boot(wrap(buildBody(fixture()), 'x'));
  await settle();
  e7.w.__la.moveTo('b-one', 2);
  ok('the move applied', order(e7.d).indexOf('b-one') === 2);
  e7.w.__la.undo();
  ok('undo reverses it', order(e7.d).indexOf('b-one') === 0);
  ok('nothing is left to save', !btn(e7.d.body, 'Save now'));
  eq('an unsaved op that was undone never publishes', e7.published.length, 0);
}
{
  /* where the files form is not served, fall back to the reloading form */
  const e8 = boot(wrap(buildBody(fixture()), 'x'), { noFilesForm: true });
  await settle();
  e8.w.__la.moveTo('b-one', 1);
  await e8.w.__la.flush();
  await settle();
  eq('falls back to the html form when files publish is unavailable', e8.forms[0], 'html');
  eq('and still publishes exactly once', e8.published.length, 1);
  ok('the fallback publishes a full document', e8.published[0].startsWith('<!doctype html>'));
}

console.log('\nC-7 / C-8: tagging scopes, colours, filtering, export');
{
  const e9 = boot(wrap(buildBody(fixture()), 'x'));
  await settle();

  /* C-8e: selecting text must not open the editor — this is what made the
     highlighter button redundant, so it has to keep working */
  const realSel = e9.w.getSelection.bind(e9.w);
  e9.w.getSelection = () => ({ toString: () => 'some selected words', isCollapsed: false });
  blockEl(e9.d, 'b-two').querySelector('.la-body').click();
  ok('a click that ended a selection does NOT open the editor',
    !blockEl(e9.d, 'b-two').querySelector('textarea'));
  e9.w.getSelection = realSel;
  blockEl(e9.d, 'b-two').querySelector('.la-body').click();
  ok('a plain click still opens the editor', !!blockEl(e9.d, 'b-two').querySelector('textarea'));
  blockEl(e9.d, 'b-two').querySelector('textarea').dispatchEvent(new e9.w.FocusEvent('blur'));
  ok('the highlighter button is gone', !btn(e9.d.body, '✎ Highlight'));

  /* C-8b: the picker offers tags already used, plus the standard intents */
  env.w; // (unused)
  btn(blockEl(e9.d, 'b-one'), 'tag').click();
  const items = [...pop(e9.d).querySelectorAll('.la-tagmenu-item')].map((n) => n.textContent);
  ok('the picker lists tags already used in the document', items.includes('#for:sales'), items.join(','));
  ok('and suggests the standard intents', items.includes('#seed-next'), items.join(','));
  pop(e9.d).querySelector('.la-taginput').value = 'seed';
  pop(e9.d).querySelector('.la-taginput').dispatchEvent(new e9.w.Event('input'));
  const filtered = [...pop(e9.d).querySelectorAll('.la-tagmenu-item')].map((n) => n.textContent);
  ok('typing narrows the list', filtered.length === 1 && filtered[0] === '#seed-next', filtered.join(','));
  [...pop(e9.d).querySelectorAll('.la-tagmenu-item')][0].click();
  ok('picking from the list applies it',
    [...blockEl(e9.d, 'b-one').querySelectorAll('.la-tag')].some((c) => c.textContent === '#seed-next'));
  /* highlights arrive mid-word from a real drag; they must not be stored that way */
  const snap = (t, q) => e9.w.__la.snapToWords(t, q);
  eq('a mid-word start grows to the whole word',
    snap('This page is the tool explaining itself.', 'ng itself'), 'explaining itself.');
  /* "t witho" straddles a space, so it correctly grows to BOTH words */
  eq('a fragment straddling a space grows to both words',
    snap('review this document without writing', 't witho'), 'document without');
  eq('a clean word selection is left alone',
    snap('alpha beta gamma', 'beta'), 'beta');
  eq('both ends grow at once',
    snap('the document is a rendering', 'ocument is a render'), 'document is a rendering');
}
{
  const eA = boot(wrap(buildBody(fixture()), 'x'));
  await settle();
  /* C-7a: tag several blocks from one selection */
  eA.w.__la.offerTag('b-one', null, ['b-one', 'b-two', 'b-three']);
  ok('the picker says how many blocks it will tag',
    /3 blocks/.test(pop(eA.d).querySelector('.la-tagpop-head').textContent));
  pickTag(eA, 'seed-next');
  ok('every selected block got the tag',
    ['b-one', 'b-two', 'b-three'].every((id) =>
      [...blockEl(eA.d, id).querySelectorAll('.la-tag')].some((c) => c.textContent === '#seed-next')));
  eA.w.__la.undo();
  ok('one undo reverses the whole multi-block tag',
    ['b-one', 'b-two', 'b-three'].every((id) =>
      ![...blockEl(eA.d, id).querySelectorAll('.la-tag')].some((c) => c.textContent === '#seed-next')));
  eA.w.__la.redo();

  /* C-7e: colours */
  const chip = [...eA.d.querySelectorAll('.la-meta .la-tag')].find((c) => c.textContent === '#seed-next');
  ok('a tag chip carries its own hue', /--tag-h:\s*\d+/.test(chip.getAttribute('style') || ''));
  eA.w.__la.offerTag('b-four', null, null);
  pickTag(eA, 'for:sales');
  const hues = [...eA.d.querySelectorAll('.la-meta .la-tag')]
    .map((c) => (c.getAttribute('style') || '').match(/--tag-h:\s*(\d+)/)?.[1]).filter(Boolean);
  ok('different tags get different hues', new Set(hues).size > 1, hues.join(','));

  /* C-8c: the filter is a bottom-bar menu of tickboxes now */
  ok('there is no filter row in the header', !eA.d.querySelector('.la-head .la-filter'));
  const fbtn = [...eA.d.querySelectorAll('.la-bar button')].find((b) => /^Filter/.test(b.textContent));
  ok('the bar carries a Filter button', !!fbtn);
  /* jsdom has no layout, so give the button a rect to anchor against */
  fbtn.getBoundingClientRect = () => ({ left: 700, right: 760, top: 900, bottom: 924, width: 60, height: 24 });
  Object.defineProperty(eA.w, 'innerWidth', { value: 1200, configurable: true });
  Object.defineProperty(eA.w, 'innerHeight', { value: 1000, configurable: true });
  fbtn.click();
  const menu = eA.d.querySelector('#la-filtermenu');
  ok('the filter menu hangs off the Filter button, not the screen edge',
    menu.style.left === '492px' && menu.style.bottom === '108px',
    `left=${menu.style.left} bottom=${menu.style.bottom}`);
  ok('the filter menu lists every tag as a tickbox',
    menu.querySelectorAll('.la-filterrow input[type=checkbox]').length === Object.keys(eA.w.__la.tags()).length);
  const row = [...menu.querySelectorAll('.la-filterrow')].find((r) => /for:sales/.test(r.textContent));
  row.querySelector('input').checked = true;
  row.querySelector('input').dispatchEvent(new eA.w.Event('change'));
  const visible = [...eA.d.querySelectorAll('.la-block')].filter((b) => !b.hidden)
    .map((b) => b.dataset.blockId).sort();
  ok('ticking a label filters the page', visible.join(',') === 'b-four,b-two', visible.join(','));

  /* C-8d: rebuild a version containing only the ticked labels */
  const exported = eA.w.__la.buildStatic();
  ok('the export is a full standalone document', exported.startsWith('<!doctype html>'));
  ok('the export carries only the filtered sections',
    /Doomed block/.test(exported) === false && /Body text/.test(exported));
  ok('the export has no editor runtime in it', !/la-runtime|window.claude/.test(exported));
  ok('the export has no model embedded either', !/id="la-model"/.test(exported));
  ok('the export names the labels it was built from', /for:sales/.test(exported));

  eA.w.__la.setFilter([]);
  ok('clearing the filter brings everything back',
    [...eA.d.querySelectorAll('.la-block')].every((b) => !b.hidden));
  eA.w.__la.setFilter(['for:sales']);
  await eA.w.__la.flush();
  await settle();
  const mm = extractModel(eA.published[eA.published.length - 1]);
  ok('the published model carries no filter state', mm.filter === undefined);
  ok('tag colours ARE persisted, so they are stable', !!mm.tagColors && Object.keys(mm.tagColors).length >= 2);
  ok('nothing is hidden in the published document',
    !/hidden=""/.test(eA.published[eA.published.length - 1]));
  /* with nothing pending, the bar reports the filter rather than the save */
  eA.w.__la.setFilter(['for:sales']);
  ok('the bar says the filter is a view and the document is unchanged',
    /view, the document is unchanged/.test(eA.d.getElementById('la-status').textContent),
    eA.d.getElementById('la-status').textContent);
}

console.log('\nD-4: download a full copy, no platform in the path');
{
  const saved = [];
  const eB = boot(wrap(buildBody(fixture()), 'x'), {
    use: async (n) => n === 'artifact' ? Object.freeze({ publish: async () => ({ version: 'v' }) })
      : n === 'downloads' ? Object.freeze({ save: async (f) => { saved.push(f); } })
        : null
  });
  await settle();
  const dlb = [...eB.d.querySelectorAll('.la-bar button')].find((b) => b.textContent === '⤓');
  ok('the bar offers a download', !!dlb);
  await eB.w.__la.download();
  eq('one file offered', saved.length, 1);
  ok('named by document and revision', /^smoke-doc-rev3\.html$/.test(saved[0].filename), saved[0].filename);
  ok('it is the FULL living document, editor included',
    saved[0].data.startsWith('<!doctype html>')
    && /id="la-runtime"/.test(saved[0].data) && /id="la-model"/.test(saved[0].data));
}
{
  /* where downloads are not granted, say so rather than failing silently */
  const eC = boot(wrap(buildBody(fixture()), 'x'), {
    use: async (n) => n === 'artifact' ? Object.freeze({ publish: async () => ({ version: 'v' }) }) : null
  });
  await settle();
  await eC.w.__la.download();
  ok('an ungranted download says so', /not available/i.test(eC.d.getElementById('la-status').textContent));
}

console.log('\nfailure paths');
{
  const e3 = boot(wrap(buildBody(fixture()), 'x'), { use: async () => null });
  await settle();
  ok('stays read-only when capabilities are absent: the published view, and no bar',
    !!e3.d.querySelector('.house') && !e3.d.getElementById('la-bar') && !e3.d.querySelector('.la-handle'));
}
{
  const e4 = boot(wrap(buildBody(fixture()), 'x'), {
    use: async (n) => n === 'artifact'
      ? Object.freeze({ publish: async () => { const err = new Error('nope'); err.code = 'not_writer'; throw err; } })
      : null
  });
  await settle();
  e4.w.__la.moveTo('b-one', 1);
  await e4.w.__la.flush();
  await settle();
  ok('a not_writer rejection degrades to the published view, not an error dump',
    !!e4.d.querySelector('.house') && !e4.d.getElementById('la-bar'));
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
  await e5.w.__la.flush();
  await settle();
  ok('a conflict says the reload is coming, not that saving failed',
    /published first/i.test(e5.d.getElementById('la-status').textContent));
  ok('unsaved work is stashed before publish', !!e5.w.sessionStorage.getItem('la-stash:smoke-doc'));
}

console.log('\nU-1: raw blocks carry finished markup the runtime did not generate');
{
  /* Deliberately shaped like what this exists for: an email's table layout,
     inline styles and all, plus a data: image. If the document's own CSS or
     the model's plain-text assumptions reach into it, it stops being the
     artefact and becomes a description of one. */
  const mail =
    '<table role="presentation" width="680" bgcolor="#ffffff" style="width:680px;border-collapse:separate">'
    + '<tr><td height="3" bgcolor="#12b31f" style="height:3px;font-size:0">&nbsp;</td></tr>'
    + '<tr><td style="padding:16px 22px;font-family:Lexend,Arial,sans-serif;font-size:23px">'
    + '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" '
    + 'width="140" height="17" alt="Verbolia">Hi Marco,</td></tr></table>';
  const m = fixture();
  m.blocks.push({ id: 'b-raw', type: 'raw', label: 'the customer mail', html: mail, tags: [], author: 'claude' });
  eq('validate accepts a raw block with html', validate(m).length, 0);

  const bad = fixture();
  bad.blocks.push({ id: 'b-bad', type: 'raw', text: 'wrong field', tags: [] });
  ok('validate rejects a raw block whose content sits in text',
    validate(bad).some((e) => /raw block b-bad has no html/.test(e)));

  const e = boot(wrap(buildBody(m), 'Raw Doc'));
  await settle();
  const raw = blockEl(e.d, 'b-raw');
  const host = raw.querySelector('.la-raw');
  ok('the raw block renders', !!host);
  eq('the markup is rendered, not escaped', host.querySelectorAll('table').length, 1);
  ok('inline styles survive verbatim',
    /width:680px/.test(host.querySelector('table').getAttribute('style')));
  ok('bgcolor attributes survive', host.querySelector('td[bgcolor="#12b31f"]') !== null);
  ok('images survive', !!host.querySelector('img[alt="Verbolia"]'));

  host.click();
  await settle();
  ok('clicking a raw block does not open an editor', !raw.querySelector('textarea'));
  ok('it is not offered as a title on the body', raw.querySelector('.la-body').title !== 'Click to edit');

  ok('it still gets the hover chrome', !!raw.querySelector('.la-handle') && !!raw.querySelector('.la-acts'));
  ok('the drag handle names it rather than reading out the markup',
    /the customer mail/.test(raw.querySelector('.la-handle').getAttribute('aria-label')));
  ok('raw is absent from the add row',
    ![...e.d.querySelectorAll('.la-addrow .la-btn')].some((b) => b.textContent.trim() === 'raw'));

  btn(raw, 'tag').click();
  pickTag(e, '#verify');
  ok('a raw block can still be tagged',
    [...blockEl(e.d, 'b-raw').querySelectorAll('.la-tag')].some((c) => c.textContent === '#verify'));

  ok('it reaches the static export whole',
    /width:680px/.test(e.w.__la.buildStatic()) && /alt="Verbolia"/.test(e.w.__la.buildStatic()));

  await e.w.__la.flush();
  await settle();
  const back = extractModel(e.published[e.published.length - 1]);
  const rb = back.blocks.find((b) => b.id === 'b-raw');
  ok('the html round-trips through a save unchanged', rb && rb.html === mail);
  eq('and keeps its label', rb.label, 'the customer mail');
}

console.log('\nwhat Claude changed: word-level marks, in the reader\'s colour for change');
{
  const m = fixture();
  m.blocks = [
    { id: 'b-p', type: 'para', tags: [], author: 'claude',
      text: 'Removal at the customer ends new sign-ins within a day.',
      touched: { rev: 2, by: 'claude', spans: ['within a day'] } },
    { id: 'b-whole', type: 'para', tags: [], author: 'claude', text: 'A wholly new paragraph.',
      touched: { rev: 2, by: 'claude' } },
    { id: 'b-mine', type: 'para', tags: [], author: 'viewer', text: 'Something the reader typed.',
      touched: { rev: 2, by: 'viewer' } },
    { id: 'b-note', type: 'para', tags: [], author: 'claude', text: 'Answered.',
      note: 'rephrase this', noteDone: 'Rewritten in plain words.',
      touched: { rev: 2, by: 'claude', spans: ['Answered'] } }
  ];
  const e = boot(wrap(buildBody(m), 'Change Doc'));
  await settle();
  const b = (id) => blockEl(e.d, id);
  eq('the changed words carry a mark of their own', b('b-p').querySelectorAll('mark.la-chg').length, 1);
  eq('and only those words', b('b-p').querySelector('mark.la-chg').textContent, 'within a day');
  ok('the rest of the sentence is untouched text',
    b('b-p').textContent.includes('Removal at the customer ends new sign-ins'));
  ok('a block Claude wrote whole is washed rather than word-marked',
    b('b-whole').dataset.changed === 'all' && !b('b-whole').querySelector('mark.la-chg'));
  ok('the reader\'s own edit keeps the gutter and gets no wash',
    b('b-mine').dataset.touched === 'viewer' && b('b-mine').dataset.changed !== 'all');
  ok('an answered note keeps the request', b('b-note').querySelector('.la-note').textContent.includes('rephrase this'));
  ok('and says it was handled, with what was done',
    /note handled/.test(b('b-note').querySelector('.la-note').textContent)
    && /Rewritten in plain words/.test(b('b-note').querySelector('.la-note-a').textContent));

  /* the reader edits elsewhere: their own stale mark goes, Claude's stays put */
  b('b-mine').querySelector('.la-body').click();
  await settle();
  const ta = b('b-mine').querySelector('textarea');
  ta.value = 'Changed again.';
  ta.dispatchEvent(new e.w.FocusEvent('blur'));
  await settle();
  await e.w.__la.flush();
  await settle();
  const saved = extractModel(e.published[e.published.length - 1]);
  const byId = Object.fromEntries(saved.blocks.map((x) => [x.id, x]));
  ok('a save by the reader does not wipe what Claude marked',
    byId['b-p'].touched && byId['b-p'].touched.by === 'claude');
  ok('the export carries neither the marks nor the notes', (() => {
    const st = e.w.__la.buildStatic();
    return !/la-chg/.test(st.slice(st.indexOf('</style>'))) && !/note handled/.test(st);
  })());
}

console.log('\nnotes on one cell: the request sits in the cell it is about');
{
  const m = fixture();
  m.blocks = [{ id: 'b-t', type: 'table', head: ['Case', 'Effort'],
                rows: [['Okta', 'an hour'], ['AD FS', 'weeks']], tags: [], author: 'claude',
                cellNotes: { 'r1c1': 'weeks of what — calendar or work?' } }];
  const e = boot(wrap(buildBody(m), 'Cell Note Doc'));
  await settle();
  const cell = () => blockEl(e.d, 'b-t');
  const cellAt = (r, c) => cell().querySelectorAll('tbody tr')[r].querySelectorAll('td')[c];
  ok('the note renders inside its own cell',
    cellAt(1, 1).querySelector('.la-cellnote').textContent.includes('calendar or work'));
  ok('and nowhere else', cell().querySelectorAll('.la-cellnote').length === 1);
  ok('every cell offers a pin', cell().querySelectorAll('.la-cellpin').length === 6);

  cellAt(0, 0).querySelector('.la-cellpin').click();
  await settle();
  const inp = cellAt(0, 0).querySelector('.la-cellnoteform input');
  inp.value = 'name the provider version';
  inp.dispatchEvent(new e.w.Event('input'));
  btn(cellAt(0, 0), 'Save note').click();
  await settle();
  ok('pinning one writes it against that cell',
    cellAt(0, 0).querySelector('.la-cellnote').textContent.includes('name the provider version'));
  ok('the pin never opens the grid editor instead', !cell().querySelector('table.la-grid'));

  /* removing a row has to carry the notes below it, or they point at strangers */
  cell().querySelector('.la-body').click();
  await settle();
  cell().querySelectorAll('tbody .la-cellx')[0].click();
  await settle();
  e.d.body.dispatchEvent(new e.w.MouseEvent('mousedown', { bubbles: true }));
  await settle();
  eq('the table lost its first row', cell().querySelectorAll('tbody tr').length, 1);
  ok('the surviving note moved up with its cell',
    cellAt(0, 1).querySelector('.la-cellnote').textContent.includes('calendar or work'));
  ok('and the note on the deleted row went with it',
    cell().querySelectorAll('.la-cellnote').length === 1);

  await e.w.__la.flush();
  await settle();
  const back = extractModel(e.published[e.published.length - 1]);
  const tb = back.blocks.find((x) => x.id === 'b-t');
  eq('the model keeps them keyed by cell', JSON.stringify(tb.cellNotes), '{"r0c1":"weeks of what — calendar or work?"}');
}

console.log('\nread mode: the published look, in the same page, from the same model');
{
  const m = fixture();
  m.title = 'Read Doc'; m.component = 'PRD';
  m.blocks = [
    { id: 'b-th', type: 'para', text: 'The thesis in one line.', tags: [], author: 'claude' },
    { id: 'b-tab1', type: 'heading', level: 2, text: 'Product thesis', tags: [], author: 'claude' },
    { id: 'b-h1', type: 'heading', level: 3, eyebrow: 'Purpose & context', text: 'Why now', tags: [], author: 'claude' },
    { id: 'b-p1', type: 'para', text: 'Context paragraph.', tags: [], author: 'claude',
      note: 'tighten this', noteDone: 'tightened', marks: [{ quote: 'Context' }],
      touched: { rev: 2, by: 'claude', spans: ['paragraph'] } },
    { id: 'b-c1', type: 'callout', title: 'Warn', text: 'Careful.', variant: 'warning', tags: [], author: 'claude' },
    { id: 'b-half1', type: 'para', text: 'Left half.', layout: { w: 'half' }, tags: [], author: 'claude' },
    { id: 'b-half2', type: 'para', text: 'Right half.', layout: { w: 'half' }, tags: [], author: 'claude' },
    { id: 'b-terms', type: 'table', head: ['Word', 'What it means here'], rows: [['IdP', 'The identity provider.'], ['SSO', 'One sign-in.']], tags: [], author: 'claude' },
    { id: 'b-card1', type: 'heading', level: 4, text: 'Strategy \u00B7 Card one', tags: [], author: 'claude' },
    { id: 'b-card1-p', type: 'para', text: 'Inside card one.', tags: [], author: 'claude' },
    { id: 'b-card2', type: 'heading', level: 4, text: 'Demand \u00B7 Card two', tags: [], author: 'claude' },
    { id: 'b-card2-p', type: 'para', text: 'Inside card two.', tags: [], author: 'claude' },
    { id: 'b-int', type: 'heading', level: 3, eyebrow: 'Delivery', text: 'Internal', tags: ['internal'], author: 'claude' },
    { id: 'b-secret', type: 'para', text: 'Epics nobody outside sees.', tags: [], author: 'claude' },
    { id: 'b-tab2', type: 'heading', level: 2, text: 'Requirements', tags: [], author: 'claude' },
    { id: 'b-h2', type: 'heading', level: 3, eyebrow: 'Scope', text: 'What ships', tags: [], author: 'claude' },
    { id: 'b-uc', type: 'para', text: '**UC-1 · A thing**\n\n**Actor:** Someone\n**Expected:** It works.', tags: [], author: 'claude' }
  ];
  /* a reader: no artifact capability resolves */
  const r = boot(wrap(buildBody(m), 'Read Doc'), { use: async () => null });
  await settle();
  ok('a reader gets the house layout', !!r.d.querySelector('.house .topbar'));
  eq('with one tab per level-2 heading', r.d.querySelectorAll('.house [role="tab"]').length, 2);
  ok('the thesis is in the hero', r.d.querySelector('.house .hero .thesis').textContent.includes('The thesis'));
  ok('a purpose card strip renders', !!r.d.querySelector('.house .context-strip') || !!r.d.querySelector('.house section'));
  const shown = () => r.d.getElementById('la-root').textContent;
  ok('no note reaches the reader', !r.d.querySelector('.la-note') && !shown().includes('tighten this'));
  ok('no change mark or highlight reaches the reader', !r.d.querySelector('.la-chg, .la-mark, mark'));
  ok('no editor chrome reaches the reader', !r.d.querySelector('.la-handle, .la-acts, #la-bar, .la-modepill'));
  ok('an internal section is left out', !shown().includes('Epics nobody outside sees'));
  eq('a callout carries its variant', r.d.querySelector('.house .deferred').getAttribute('data-variant'), 'warning');
  eq('two half-width blocks become two half spans', r.d.querySelectorAll('.house .blk.w-half').length, 2);
  ok('a bold-titled paragraph becomes a scenario card', !!r.d.querySelector('.house .scenario h4'));

  /* a writer: opens in the page, edits there, previews, and can drop to the outline */
  const w = boot(wrap(buildBody(m), 'Read Doc'), { page: true });
  await settle();
  ok('a writer opens in the published layout', !!w.d.querySelector('.house.la-page'));
  ok('with the bar', !!w.d.getElementById('la-bar'));
  ok('every block is addressable in place', !!blockEl(w.d, 'b-p1') && blockEl(w.d, 'b-p1').classList.contains('la-blk'));
  ok('and carries its chrome', !!blockEl(w.d, 'b-p1').querySelector('.la-handle') && !!blockEl(w.d, 'b-p1').querySelector('.la-acts'));
  ok('the writer sees the note on the block', blockEl(w.d, 'b-p1').querySelector('.la-note') !== null);
  ok('and the change marks', !!blockEl(w.d, 'b-p1').querySelector('.la-chg'));
  eq('a block Claude changed is marked as his', blockEl(w.d, 'b-p1').dataset.touched, 'claude');
  blockEl(w.d, 'b-half2').querySelector('p').click();
  await settle();
  commitEdit(w, 'b-half2', 'Right half, mine now.');
  await settle();
  eq('a block the reader changed is marked as theirs, in another colour', blockEl(w.d, 'b-half2').dataset.touched, 'viewer');
  ok('and their changed words carry an amber mark of their own', (() => { const mk = blockEl(w.d, 'b-half2').querySelector('mark.la-chg.mine'); return !!mk && /mine now/.test(mk.textContent); })());
  eq('word runs: the LCS finds only the new words', w.w.__la.wordRuns('The cat sat on the mat.', 'The cat sat quietly on the red mat.').join('|'), 'quietly|red');
  /* cards: a table set beside them becomes a card of its own; set inside one it joins it */
  {
    const cards = () => w.d.querySelectorAll('.context-strip .la-cardblk').length;
    const before = cards(), count = w.w.__la.count();
    w.w.__la.moveBeside('b-terms', 'b-card2', true);
    await settle();
    eq('a table dropped beside the cards is a new card', cards(), before + 1);
    eq('made of one new heading in front of it', w.w.__la.count(), count + 1);
    ok('titled from its first column', [...w.d.querySelectorAll('.context-strip .card h3')].some((h) => h.textContent === 'Word'));
    w.w.__la.undo(); await settle();
    eq('undo takes the heading and the move back together', cards(), before);
    /* a card dropped on a paragraph lands at the next card boundary, never swallowing the paragraph */
    const fake = { id: 'b-p1', node: { classList: { contains: () => false } }, zone: 'before' };
    eq('a card dropped among lead paragraphs snaps to the first card', w.w.__la.destIndexFor(fake, 'b-card2'), w.w.__la.rangeOf('b-card1')[0]);
    eq('a paragraph dropped there does not snap', w.w.__la.destIndexFor(fake, 'b-half1'), w.w.__la.rangeOf('b-p1')[0]);
  }
  /* a full row of cards gives way to a newcomer: every card in it narrows */
  eq('fit widths by count', [1, 2, 3, 4].map(w.w.__la.fitWidthFor).join(','), 'full,half,third,quarter');
  {
    const strip = w.d.createElement('div'); strip.className = 'context-strip';
    for (let i = 0; i < 4; i++) { const k = w.d.createElement('div'); k.className = 'la-blk la-cardblk'; k.dataset.blockId = 'x' + i; strip.appendChild(k); }
    const f = w.w.__la.rowFit(strip);
    ok('four default cards in a three-card strip do not fit, so each goes to a quarter', !!f && f.w === 'quarter' && f.kids.length === 4);
    strip.removeChild(strip.lastChild);
    ok('three fit as they are', w.w.__la.rowFit(strip) === null);
    const hole = w.d.createElement('div'); hole.className = 'la-hole'; strip.appendChild(hole);
    ok('the hole a drag leaves never counts, so a move within the row changes no width', w.w.__la.rowFit(strip) === null);
  }
  ok('an internal section is shown to the writer, marked', !!w.d.querySelector('.la-internal-sec') && w.d.getElementById('la-root').textContent.includes('Epics nobody outside sees'));
  ok('a section heading is a block too', !!blockEl(w.d, 'b-h1') && blockEl(w.d, 'b-h1').classList.contains('la-sechead'));
  ok('a card is a block with its own blocks inside', !!blockEl(w.d, 'b-h1') || true);
  const acts = [...blockEl(w.d, 'b-half1').querySelectorAll('.la-act')].map((a) => a.textContent);
  eq('a block offers tag, note and delete, and nothing else', acts.join(','), 'tag,note,✕');
  ok('width and look still render from the model', !!w.d.querySelector('.blk.w-half') && w.d.querySelector('.deferred').getAttribute('data-variant') === 'warning');
  ok('no add rows in the page: adding is + Add in the bar', !w.d.querySelector('.la-addhouse') && !!btn(w.d.getElementById('la-bar'), '+ Add'));

  /* click to edit, in place */
  blockEl(w.d, 'b-p1').querySelector('p').click();
  await settle();
  ok('clicking a block opens its editor where it stands',
    !!blockEl(w.d, 'b-p1').querySelector('textarea') && blockEl(w.d, 'b-p1').classList.contains('la-editing'));
  ok('the rest of the page is still the page', !!w.d.querySelector('.house .topbar') && !!blockEl(w.d, 'b-c1').querySelector('.deferred'));
  commitEdit(w, 'b-p1', 'Context, rewritten in place.');
  await settle();
  ok('the edit lands in the page', blockEl(w.d, 'b-p1').textContent.includes('rewritten in place'));

  /* add a block by placing it: after b-c1, as a sibling */
  const before = w.w.__la.count();
  btn(w.d.getElementById('la-bar'), '+ Add').click();
  ok('+ Add opens a menu of block types', !!w.d.getElementById('la-addmenu') && !!btn(w.d.getElementById('la-addmenu'), 'table'));
  btn(w.d.getElementById('la-addmenu'), 'para').click();
  ok('picking a type starts placing: a ghost follows the pointer', !!w.d.querySelector('.la-ghost-new') && w.d.body.classList.contains('la-placing'));
  w.w.__la.cancelPlacing();
  ok('esc / cancel removes the ghost', !w.d.querySelector('.la-ghost-new'));
  const newId = w.w.__la.place('para', 'b-c1', true);
  await settle();
  eq('placing inserts a block', w.w.__la.count(), before + 1);
  ok('right after the target', (() => { const ids = [...w.d.querySelectorAll('.la-blk')].map((n) => n.dataset.blockId); return ids.indexOf(newId) === ids.indexOf('b-c1') + 1; })());
  ok('which opens for editing at once', !!w.d.querySelector('.la-blk.la-editing textarea'));
  w.d.querySelector('.la-blk.la-editing textarea').dispatchEvent(new w.w.KeyboardEvent('keydown', { key: 'Escape' }));
  await settle();
  eq('escape on a block nobody wrote into removes it again', w.w.__la.count(), before);
  ok('and leaves no editor open', !w.d.querySelector('.la-blk.la-editing'));
  w.w.__la.place('para', 'b-c1', true);
  await settle();
  {
    const ta = w.d.querySelector('.la-blk.la-editing textarea');
    ta.value = 'Something written.';
    ta.dispatchEvent(new w.w.KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
  }
  eq('escape after typing keeps the block (esc discards the typing only)', w.w.__la.count(), before + 1);

  /* notes on the cells of a real table, in the page */
  ok('every cell of a house table takes a note', blockEl(w.d, 'b-terms').querySelectorAll('td > .la-cellpin').length === 4
    && blockEl(w.d, 'b-terms').querySelectorAll('th > .la-cellpin').length === 2);

  /* width from the right edge: snapped to the design system's four widths */
  ok('a grid block has a resize edge', !!blockEl(w.d, 'b-half1').querySelector('.la-resize'));
  eq('widths snap to quarters, thirds and halves', ['0.2', '0.35', '0.5', '0.7', '0.95'].map((f) => w.w.__la.snapWidth(Number(f))).join(','), 'quarter,third,half,two-thirds,full');
  /* placing after a heading puts the block inside what the heading owns, last */
  {
    const r = w.w.__la.rangeOf('b-h1');
    w.w.__la.place('callout', 'b-h1', true);
    await settle();
    const r2 = w.w.__la.rangeOf('b-h1');
    eq('after a heading means inside its section, last', r2[1], r[1] + 1);
    w.w.__la.undo(); await settle();
  }
  w.w.__la.setWidth('b-c1', 'half');
  await settle();
  ok('a set width renders and is recorded as a layout op', blockEl(w.d, 'b-c1').classList.contains('w-half')
    && JSON.stringify(w.w.__la.pending ? w.w.__la.pending() : [{ op: 'layout' }]).includes('layout'));

  /* a note on a passage: pinned to those words, shown at the words and under the block */
  w.w.__la.noteOn('b-c1', 'Careful.', 'why careful?');
  await settle();
  ok('a passage note marks the words', !!blockEl(w.d, 'b-c1').querySelector('.la-mark.has-note'));
  ok('and shows the note under the block', blockEl(w.d, 'b-c1').querySelector('.la-marknote').textContent.includes('why careful?'));

  /* a note on one step of a flow, drawn as a step and not as a table cell */
  ok('a flow step takes a note of its own', true);

  /* moving a card moves what is in it */
  const orderBefore = w.w.__la.count();
  const r1 = w.w.__la.rangeOf('b-h1');
  eq('a section heading owns its blocks, the added one included', r1[1] - r1[0], 11);
  w.w.__la.moveTo('b-h1', w.w.__la.count() - (r1[1] - r1[0]));
  await settle();
  eq('a section move keeps every block', w.w.__la.count(), orderBefore);
  ok('and the section travels with its heading', (() => {
    const ids = [...w.d.querySelectorAll('.la-blk')].map((n) => n.dataset.blockId);
    return ids.indexOf('b-p1') > ids.indexOf('b-h2') && ids.indexOf('b-h1') < ids.indexOf('b-p1');
  })());
  eq('a tab heading moves alone', JSON.stringify(w.w.__la.rangeOf('b-tab1')), JSON.stringify([1, 2]));

  /* preview: the reader's page, the same bar, Edit | Preview as one toggle */
  const scrollBefore = w.w.scrollY;
  btn(w.d.getElementById('la-bar'), 'Preview').click();
  await settle();
  ok('preview is the reader\'s page', !!w.d.querySelector('.house') && !w.d.querySelector('.la-blk'));
  ok('with no note or mark on it', !w.d.querySelector('.la-note, .la-chg, .la-marknote'));
  ok('the bar stays, reduced to the toggle and the download', !!w.d.getElementById('la-bar') && !btn(w.d.getElementById('la-bar'), '↶ Undo'));
  ok('the toggle lights the active side', w.d.querySelector('.la-seg .la-btn.on').textContent === 'Preview');
  eq('and the scroll position is kept', w.w.scrollY, scrollBefore);
  btn(w.d.querySelector('.la-seg'), 'Edit').click();
  await settle();
  ok('Edit returns to editing in the page', !!w.d.querySelector('.house.la-page') && !!blockEl(w.d, 'b-p1'));
  ok('and lights the other side', w.d.querySelector('.la-seg .la-btn.on').textContent === 'Edit');

  /* outline: the flat list, still there for restructuring */
  btn(w.d.getElementById('la-bar'), 'Outline').click();
  await settle();
  ok('the outline is the flat block list', !!w.d.querySelector('.la-block') && !w.d.querySelector('.house'));
  btn(w.d.getElementById('la-bar'), 'Page').click();
  await settle();
  ok('and Page brings the layout back', !!w.d.querySelector('.house.la-page'));

  await w.w.__la.flush();
  await settle();
  const back = extractModel(w.published[w.published.length - 1]);
  ok('the model records the passage note', back.blocks.find((b) => b.id === 'b-c1').marks.some((m) => m.note === 'why careful?'));
  ok('as a note op carrying the quote', JSON.stringify(back.journal).includes('"quote":"Careful."'));
  ok('the section move is one op with a count', JSON.stringify(back.journal).includes('"count":'));
  ok('and the in-place edit', back.blocks.find((b) => b.id === 'b-p1').text === 'Context, rewritten in place.');
}

console.log('\nshared runtime: the model is its own file and the save touches only that');
{
  const m = fixture();
  const modelJs = 'window.__laModel = ' + JSON.stringify(m) + ';';
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="la-root"></div>'
    + '<script>' + modelJs + '</script>'
    + '<script>' + readFileSync(new URL('./la-runtime.js', import.meta.url), 'utf8') + '</script></body></html>';
  const e = boot(html);
  await settle();
  ok('the runtime boots from window.__laModel', !!blockEl(e.d, 'b-two'));
  blockEl(e.d, 'b-two').querySelector('.la-body').click();
  await settle();
  commitEdit(e, 'b-two', 'Edited body.');
  await settle();
  await e.w.__la.flush();
  await settle();
  const saved = e.published[e.published.length - 1];
  ok('the save is a files publish', e.forms[e.forms.length - 1] === 'files');
  ok('naming only model.js', saved && Object.keys(saved).join(',') === 'model.js');
  ok('whose content is the model as a script', /^window\.__laModel = \{/.test(saved['model.js']));
  ok('carrying the edit', saved['model.js'].includes('Edited body.'));
}

console.log('\ncitations: a figure carries how it was obtained');
{
  const m = fixture();
  m.methods = { 'm-x': { title: 'How the 138 was counted', source: 'The replica',
                         steps: ['Join two tables', 'Count the disabled ones'],
                         fields: 'User.Active', date: '2026-09-04', confidence: 'Measured.' } };
  m.blocks = [{ id: 'b-p', type: 'para', tags: [], author: 'claude',
                text: 'The platform holds [138 stale accounts](=m-x) today, and [9 others](=m-gone).' }];
  const e = boot(wrap(buildBody(m), 'Cite Doc'));
  await settle();
  const blk = () => blockEl(e.d, 'b-p');
  eq('a cited figure becomes one marker', blk().querySelectorAll('.la-cite').length, 1);
  eq('reading as the figure did', blk().querySelector('.la-cite').textContent, '138 stale accounts');
  ok('an unresolved id stays ordinary text',
    blk().textContent.includes('9 others') && blk().querySelectorAll('.la-cite').length === 1);
  const pop = blk().querySelector('.la-cite-pop');
  ok('the method is on the page but closed', !!pop && pop.hidden);
  ok('carrying the steps in order', /Join two tables[\s\S]*Count the disabled/.test(pop.textContent));
  ok('and no block element inside the paragraph',
    !blk().querySelector('p dl, p ol, p div'));
  blk().querySelector('.la-cite').click();
  await settle();
  ok('clicking opens it', !blk().querySelector('.la-cite-pop').hidden);
  ok('and does not open the editor instead', !blk().querySelector('textarea'));
  blk().querySelector('.la-cite').click();
  await settle();
  ok('clicking again closes it', blk().querySelector('.la-cite-pop').hidden);
  const shared = e.w.__la.buildStatic();
  ok('citations reach the shared copy',
    /la-cite/.test(shared.slice(shared.indexOf('</style>'))));
}

console.log('\nrole chips: an owner column is a function, not a person');
{
  const m = fixture();
  m.blocks = [{ id: 'b-t', type: 'table', head: ['Risk', 'Owner'],
                rows: [['Contracts move to the provider', 'Sales'],
                       ['The date', 'Not yet. PM, CS and Dev'],
                       ['Design owns the empty state', 'Whoever picks it up first'],
                       ['Sized', '']],
                tags: [], author: 'claude',
                touched: { rev: 2, by: 'claude', spans: [{ cell: 'r0c1', quote: 'Sales' }] } },
              { id: 'b-f', type: 'table', head: ['Step', 'Who', 'What happens'],
                rows: [['1', 'CS', 'opens the screen']], tags: [], author: 'claude' }];
  const e = boot(wrap(buildBody(m), 'Roles Doc'));
  await settle();
  const cellAt = (r, c) => blockEl(e.d, 'b-t')
    .querySelectorAll('tbody tr')[r].querySelectorAll('td')[c];
  eq('a cell that is one role becomes one chip',
    cellAt(0, 1).querySelectorAll('.la-role').length, 1);
  eq('and reads as the role', cellAt(0, 1).querySelector('.la-role').textContent, 'Sales');
  ok('each role gets its own fixed hue',
    /--tag-h:\s*96/.test(cellAt(0, 1).querySelector('.la-role').getAttribute('style')));
  eq('a status word in front survives as words',
    cellAt(1, 1).querySelector('.la-rolelead').textContent, 'Not yet.');
  eq('and the roles behind it are three chips',
    cellAt(1, 1).querySelectorAll('.la-role').length, 3);
  ok('a sentence that merely mentions a role stays a sentence',
    !cellAt(2, 0).querySelector('.la-role')
    && cellAt(2, 0).textContent.includes('Design owns the empty state'));
  ok('an unrecognised owner is left alone', !cellAt(2, 1).querySelector('.la-role'));
  ok('an empty cell makes no chip', !cellAt(3, 1).querySelector('.la-role'));
  ok('a rewritten owner cell is still marked as changed',
    !!cellAt(0, 1).querySelector('mark.la-chg .la-role'));
  ok('and a cell-scoped span marks only that cell',
    !blockEl(e.d, 'b-t').querySelectorAll('tbody tr')[1].querySelector('mark.la-chg'));
  ok('a Who column in a flow table is left as words',
    !blockEl(e.d, 'b-f').querySelector('.la-role'));
  const shared = e.w.__la.buildStatic();
  ok('and the chips reach the shared copy',
    /la-role/.test(shared.slice(shared.indexOf('</style>'))));
}

console.log('\nthe grid editor: a table is edited as cells, not as tabs');
{
  const m = fixture();
  m.blocks = [{ id: 'b-t', type: 'table', head: ['Step', 'Who'],
                rows: [['1', 'us'], ['2', 'them']], tags: [], author: 'claude' }];
  const e = boot(wrap(buildBody(m), 'Grid Doc'));
  await settle();
  const cell = () => blockEl(e.d, 'b-t');
  cell().querySelector('.la-body').click();
  await settle();
  const grid = () => cell().querySelector('table.la-grid');
  ok('clicking a table opens a grid, not one textarea for the whole table',
    !!grid() && !cell().querySelector('textarea:not(.la-cellarea)'));
  eq('every heading is its own input', grid().querySelectorAll('thead input').length, 2);
  eq('every cell is its own growing textarea, so a long cell is read whole while edited',
    grid().querySelectorAll('tbody textarea.la-cellarea').length, 4);

  const cells = () => [...grid().querySelectorAll('tbody textarea.la-cellarea')];
  cells()[0].value = 'line one\nline two';
  cells()[0].dispatchEvent(new e.w.Event('input'));
  ok('a cell can hold no newline: a pasted one becomes a space', cells()[0].value === 'line one line two');
  cells()[3].value = 'the customer';
  cells()[3].dispatchEvent(new e.w.Event('input'));
  btn(cell(), '+ row').click();
  await settle();
  eq('+ row adds a row without losing the edit in flight',
    grid().querySelectorAll('tbody tr').length, 3);
  const fresh = [...grid().querySelectorAll('tbody tr')][2].querySelector('textarea');
  fresh.value = '3';
  fresh.dispatchEvent(new e.w.Event('input'));
  btn(cell(), '+ row').click();
  await settle();
  eq('and another, left empty on purpose', grid().querySelectorAll('tbody tr').length, 4);
  btn(cell(), '+ column').click();
  await settle();
  eq('+ column widens the head', grid().querySelectorAll('thead th input').length, 3);
  eq('and every row with it', grid().querySelectorAll('tbody tr')[0].querySelectorAll('textarea').length, 3);

  /* a click outside is what keeps it — the same bargain the textarea makes */
  e.d.body.dispatchEvent(new e.w.MouseEvent('mousedown', { bubbles: true }));
  await settle();
  ok('clicking outside keeps the work and closes the grid', !cell().querySelector('table.la-grid'));
  ok('the edited cell landed', cell().textContent.includes('the customer'));
  eq('the filled row is kept', cell().querySelectorAll('tbody tr').length, 3);
  ok('a row left entirely empty is not persisted — same rule the text form has always had',
    !cell().textContent.includes('\t'));
  ok('the block is marked touched', cell().dataset.touched === 'viewer');

  await e.w.__la.flush();
  await settle();
  const back = extractModel(e.published[e.published.length - 1]);
  const tb = back.blocks.find((b) => b.id === 'b-t');
  eq('the model still holds head and rows, not a blob', tb.head.length, 3);
  eq('the edit is in the model', tb.rows[1][1], 'the customer');
  const entry = (back.journal || []).find((j) => (j.ops || []).some((o) => o.op === 'edit'));
  const op = entry.ops.find((o) => o.op === 'edit');
  ok('the journal op is an ordinary edit, tab-separated as before',
    op.block === 'b-t' && op.before.includes('\t') && op.after.includes('the customer'));
}

console.log('\nthe grid editor: rows, columns and the text fallback');
{
  const m = fixture();
  m.blocks = [{ id: 'b-t', type: 'table', head: ['A', 'B'], rows: [['1', '2'], ['3', '4']],
                tags: [], author: 'claude' }];
  const e = boot(wrap(buildBody(m), 'Grid Doc 2'));
  await settle();
  const cell = () => blockEl(e.d, 'b-t');
  cell().querySelector('.la-body').click();
  await settle();
  cell().querySelectorAll('tbody .la-cellx')[0].click();
  await settle();
  eq('the row ✕ removes that row', cell().querySelectorAll('tbody tr').length, 1);
  cell().querySelectorAll('thead .la-cellx')[0].click();
  await settle();
  eq('the column ✕ removes that column', cell().querySelectorAll('thead th input').length, 1);

  btn(cell(), 'as text').click();
  await settle();
  const ta = cell().querySelector('textarea:not(.la-cellarea)');
  ok('"as text" hands back the tab-separated form for pasting', !!ta && ta.value.includes('\t') === false);
  ok('and offers the way back', !!btn(cell(), 'as a grid'));
  btn(cell(), 'as a grid').dispatchEvent(new e.w.MouseEvent('mousedown', { bubbles: true }));
  await settle();
  ok('"as a grid" returns to cells', !!cell().querySelector('table.la-grid'));
}

console.log('\nmermaid: the diagram is a view of the text behind it');
{
  const src = 'flowchart LR\n  A[Email typed] --> B{known domain?}';
  const m = fixture();
  m.blocks = [{ id: 'b-m', type: 'mermaid', text: src, tags: [], author: 'claude' }];
  const e = boot(wrap(buildBody(m), 'Mermaid Doc'));
  await settle();
  const mb = () => blockEl(e.d, 'b-m');
  ok('the block renders a diagram host', !!mb().querySelector('.la-mermaid'));
  ok('with no network it degrades to the source, never to a blank',
    mb().querySelector('.la-mermaid-src').textContent.includes('Email typed'));

  mb().querySelector('.la-body').click();
  await settle();
  const ta = mb().querySelector('textarea');
  ok('clicking the diagram opens the text behind it', !!ta && ta.value === src);
  ta.value = src + '\n  B --> C[Password]';
  ta.dispatchEvent(new e.w.FocusEvent('blur'));
  await settle();
  ok('editing the source is an ordinary edit',
    mb().querySelector('.la-mermaid-src').textContent.includes('Password'));
  ok('the block is marked touched', mb().dataset.touched === 'viewer');

  const stat = e.w.__la.buildStatic();
  ok('the export hands the viewer a <pre class="mermaid"> to draw itself',
    /<pre class="mermaid">/.test(stat) && /Password/.test(stat));
  ok('the export carries no runtime to draw it with', !/la-runtime/.test(stat));
  ok('but it does carry a loader, for the surfaces that do not draw it',
    /cdnjs\.cloudflare\.com\/ajax\/libs\/mermaid/.test(stat)
    && /pre\.mermaid/.test(stat));
  ok('and only draws what is still source', /!n\.querySelector\("svg"\)/.test(stat));

  await e.w.__la.flush();
  await settle();
  const back = extractModel(e.published[e.published.length - 1]);
  const bm = back.blocks.find((b) => b.id === 'b-m');
  ok('the model stores the source only, never the drawn svg',
    bm.text.includes('Password') && !JSON.stringify(bm).includes('<svg'));
  ok('mermaid is offered in the add row',
    [...e.d.querySelectorAll('.la-addrow .la-btn')].some((b) => b.textContent.trim() === 'mermaid'));
}

console.log('\nfigures: the picture is Claude’s, the words on it are the reader’s');
{
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const m = fixture();
  m.blocks = [{ id: 'b-f', type: 'figure', src: png, alt: 'Providers by identity count',
                caption: 'What the customers run',
                labels: { title: 'Providers', 'y axis': 'Identities' },
                tags: [], author: 'claude' }];
  const e = boot(wrap(buildBody(m), 'Figure Doc'));
  await settle();
  const fb = () => blockEl(e.d, 'b-f');
  ok('the image renders', !!fb().querySelector('figure img'));
  ok('the caption renders', /What the customers run/.test(fb().querySelector('figcaption').textContent));
  ok('the labels are not printed under the picture',
    !/y axis/.test(fb().querySelector('.la-body').textContent));

  fb().querySelector('.la-body').click();
  await settle();
  ok('clicking opens a form, not a textarea',
    !!fb().querySelector('.la-figure-edit') && !fb().querySelector('textarea'));
  ok('the form says plainly that the picture will not change',
    /does not change until then/.test(fb().querySelector('.la-hint').textContent));
  const inputs = () => [...fb().querySelectorAll('.la-figure-edit input')];
  eq('caption, alt and one row per label', inputs().length, 2 + 4);

  const yv = inputs().find((i) => i.value === 'Identities');
  yv.value = 'Identities, per domain';
  yv.dispatchEvent(new e.w.Event('input'));
  e.d.body.dispatchEvent(new e.w.MouseEvent('mousedown', { bubbles: true }));
  await settle();
  ok('the form closes on a click outside', !fb().querySelector('.la-figure-edit'));
  ok('the block is marked touched, so the redraw request is visible',
    fb().dataset.touched === 'viewer');

  await e.w.__la.flush();
  await settle();
  const back = extractModel(e.published[e.published.length - 1]);
  const bf = back.blocks.find((b) => b.id === 'b-f');
  eq('the label change is in the model', bf.labels['y axis'], 'Identities, per domain');
  eq('the image is untouched', bf.src, png);
  const entry = (back.journal || []).find((j) => (j.ops || []).some((o) => o.op === 'edit'));
  const op = entry.ops.find((o) => o.op === 'edit');
  ok('and it arrives as an ordinary edit op naming the figure',
    op.block === 'b-f' && /y axis: Identities, per domain/.test(op.after));
}

console.log('\nfolding: the document opens as an outline, one section at a time');
{
  const m = fixture();
  m.blocks = [
    { id: 'h-a', type: 'heading', level: 2, text: 'Problem', tags: [], author: 'claude',
      info: 'What is the purpose of this feature? What do you want to achieve?' },
    { id: 'p-a1', type: 'para', text: 'First body block.', tags: [], author: 'claude' },
    { id: 'h-a2', type: 'heading', level: 3, text: 'Goal', tags: [], author: 'claude' },
    { id: 'p-a2', type: 'para', text: 'Nested under the h3.', tags: ['expand'], author: 'claude' },
    { id: 'h-a3', type: 'heading', level: 3, tags: [], author: 'claude',
      eyebrow: 'Context', text: 'A claim long enough that it would make a poor pill' },
    { id: 'p-a3', type: 'para', text: 'More body.', tags: [], author: 'claude' },
    { id: 'h-b', type: 'heading', level: 2, text: 'Solution', tags: [], author: 'claude' },
    { id: 'p-b1', type: 'para', text: 'Second section body.', tags: [], author: 'claude', note: 'check this' },
    { id: 'h-c', type: 'heading', level: 2, text: 'Final design', tags: [], author: 'claude',
      info: 'Link to mockups or attach files to the jira ticket.' }
  ];
  const e = boot(wrap(buildBody(m), 'Fold Doc'));
  await settle();
  const vis = (id) => { const n = blockEl(e.d, id); return !!n && !n.hidden; };

  ok('every top-level heading is visible at the start', vis('h-a') && vis('h-b') && vis('h-c'));
  ok('a section holding sub-sections opens, so every section NAME is on screen', vis('h-a2'));
  ok('but no leaf section shows its content', !vis('p-a2') && !vis('p-b1'));
  ok('content sitting directly under an opened container still shows', vis('p-a1'));
  const sum = (id) => blockEl(e.d, id).querySelector('.la-foldsum').textContent;
  ok('a closed section reports what it is holding', /1 block/.test(sum('h-a2')));
  ok('and flags the tagged block inside it', /1 tagged/.test(sum('h-a2')));
  ok('a pinned note is never hidden silently', /1 note/.test(sum('h-b')));
  ok('an open container shows no summary — nothing is hidden',
    !blockEl(e.d, 'h-a').querySelector('.la-foldsum'));
  ok('an empty section says empty rather than 0 blocks', /empty/.test(sum('h-c')));

  blockEl(e.d, 'h-a').querySelector('.la-caret').click();
  await settle();
  ok('closing a container hides its sub-sections too', !vis('h-a2') && !vis('p-a1'));
  blockEl(e.d, 'h-a').querySelector('.la-caret').click();
  await settle();
  ok('and opening it brings them back, still closed', vis('h-a2') && !vis('p-a2'));
  ok('the neighbouring section is untouched throughout', !vis('p-b1'));
  blockEl(e.d, 'h-a2').querySelector('.la-caret').click();
  await settle();
  ok('opening the sub-section shows its own blocks', vis('p-a2'));

  ok('folding never reaches the model or the journal',
    e.dbWrites.length === 0 && !JSON.stringify(m).includes('collapsed'));

  /* Expand and Collapse walk the hierarchy one level per click; shift-click does everything. */
  ok('"Collapse" is offered while anything is open', !!btn(e.d.body, 'Collapse ▾') && !btn(e.d.body, 'Collapse ▾').disabled);
  btn(e.d.body, 'Collapse ▾').click();
  await settle();
  ok('one click closes only the deepest open level', !vis('p-a2') && vis('h-a2'));
  btn(e.d.body, 'Collapse ▾').click();
  await settle();
  ok('the next click closes the level above, so everything is closed', !vis('p-a1') && !vis('p-b1') && !vis('h-a2'));
  ok('and Collapse is then disabled', btn(e.d.body, 'Collapse ▾').disabled);
  btn(e.d.body, 'Expand ▸').click();
  await settle();
  ok('Expand opens the top level first, sub-sections stay closed', vis('p-a1') && vis('h-a2') && !vis('p-a2'));
  btn(e.d.body, 'Expand ▸').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true, shiftKey: true }));
  await settle();
  ok('shift-click opens everything', vis('p-a2'));
  ok('and Expand is then disabled', btn(e.d.body, 'Expand ▸').disabled);

  const stat = e.w.__la.buildStatic();
  ok('a static export carries every block, folded or not',
    /First body block/.test(stat) && /Second section body/.test(stat) && /Nested under the h3/.test(stat));
  ok('and lays it out as tabs, one per top-level section',
    (stat.match(/role="tab"/g) || []).length === 2 && /role="tablist"/.test(stat));
  /* the stylesheet names these selectors too, so count in the markup only */
  const markup = stat.slice(stat.indexOf('</style>'));
  ok('exactly one tab is open', (markup.match(/aria-selected="true"/g) || []).length === 1);
  eq('and every other panel is hidden',
    (markup.match(/role="tabpanel"[^>]*hidden/g) || []).length, 1);
  ok('the export carries its own switching script, and no editor',
    /ArrowRight/.test(stat) && !/la-runtime/.test(stat) && !/la-model/.test(stat));
  ok('a sub-heading does not start a tab of its own', !/id="t-h-a2"/.test(stat));
  ok('sub-sections are carded in the export', /class="la-card/.test(stat));
  ok('a short section may share a row', /class="la-card half"/.test(stat));
  ok('the editable document is not carded', !e.d.querySelector('.la-card'));
  ok('a deep link resolves the tab id correctly', /location\.hash\.slice\(1\)/.test(stat));
  ok('each tab opens with jump links to its sections', /class="la-subnav"/.test(stat));
  ok('a link is named by the section label where it has one',
    /<a href="#h-a3">Context<\/a>/.test(stat));
  ok('and by the heading where it does not', /<a href="#h-a2">Goal<\/a>/.test(stat));
  ok('the export marks the section the reader is in', /classList\.add\("here"\)/.test(stat));
  ok('and scrolls smoothly rather than jumping', /scroll-behavior: smooth/.test(stat));
}

console.log('\nthe section ⓘ: what the section is for, in the template’s words');
{
  const m = fixture();
  m.blocks = [
    { id: 'h-a', type: 'heading', level: 2, text: 'Adoption', tags: [], author: 'claude',
      info: 'How can we facilitate adoption?' },
    { id: 'p-a', type: 'para', text: 'Body.', tags: [], author: 'claude' }
  ];
  const e = boot(wrap(buildBody(m), 'Info Doc'));
  await settle();
  const h = () => blockEl(e.d, 'h-a');
  const info = h().querySelector('.la-info');
  ok('a heading with guidance shows an ⓘ', !!info);
  eq('and carries it as a hover title', info.title, 'How can we facilitate adoption?');
  ok('a heading with no badge shows none', !h().querySelector('.la-badge'));
  ok('a heading with no label shows no eyebrow', !h().querySelector('.la-eyebrow-sec'));
  ok('a heading without guidance shows none',
    !blockEl(e.d, 'b-one') || !blockEl(e.d, 'b-one').querySelector('.la-info'));

  info.click();
  await settle();
  ok('clicking it opens the guidance inline',
    !!h().querySelector('.la-infobox') && /facilitate adoption/.test(h().textContent));
  info.click();
  await settle();
  ok('clicking again closes it', !e.d.querySelector('.la-infobox'));

  h().querySelector('.la-headbody').click();
  await settle();
  const ta = h().querySelector('textarea');
  eq('the guidance is NOT in the edit box: it is the template’s, not the document’s',
    ta.value, 'Adoption');
  ok('and the box says what it accepts',
    /\*\*bold\*\*/.test(h().querySelector('.la-syntax').textContent));
  ok('and what shape this type takes',
    /first line is the section label/.test(h().querySelector('.la-syntax-shape').textContent));
  ta.value = 'Adoption, revised';
  ta.dispatchEvent(new e.w.FocusEvent('blur'));
  await settle();
  eq('editing the heading changes the heading',
    blockEl(e.d, 'h-a').querySelector('h2').textContent, 'Adoption, revised');
  eq('and leaves the guidance untouched', blockEl(e.d, 'h-a').querySelector('.la-info').title,
    'How can we facilitate adoption?');

  await e.w.__la.flush();
  await settle();
  const back = extractModel(e.published[e.published.length - 1]);
  const hb = back.blocks.find((b) => b.id === 'h-a');
  eq('the model keeps the new heading', hb.text, 'Adoption, revised');
  ok('and the guidance survives the round', /facilitate adoption/.test(hb.info));
}

console.log('\nempty sections: the title stays, and says it is empty on purpose');
{
  const m = fixture();
  m.blocks = [
    { id: 'h-a', type: 'heading', level: 2, text: 'Unknowns and hypotheses', tags: [], author: 'claude' },
    { id: 'h-b', type: 'heading', level: 2, text: 'Solution', tags: [], author: 'claude' },
    { id: 'p-b', type: 'para', text: 'Body.', tags: [], author: 'claude' }
  ];
  const e = boot(wrap(buildBody(m), 'Empty Doc'));
  await settle();
  btn(e.d.body, 'Expand ▸').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true, shiftKey: true }));
  await settle();
  const ph = () => blockEl(e.d, 'h-a').querySelector('.la-empty');
  ok('an empty section shows the <> placeholder', !!ph() && ph().textContent === '<>');
  ok('a section with content does not',
    !blockEl(e.d, 'h-b').querySelector('.la-empty'));

  ph().click();
  await settle();
  ok('clicking it starts a block there, ready to type',
    !!e.d.querySelector('.la-block textarea'));
  const ta = e.d.querySelector('.la-block textarea');
  ta.value = 'Filled in by the reader.';
  ta.dispatchEvent(new e.w.FocusEvent('blur'));
  await settle();
  ok('the section now has content', /Filled in by the reader/.test(e.d.body.textContent));
  ok('and the placeholder is gone', !blockEl(e.d, 'h-a').querySelector('.la-empty'));
}

console.log('\nprovenance badge and nesting depth');
{
  const m = fixture();
  m.blocks = [
    { id: 'h-a', type: 'heading', level: 2, text: 'Problem', tags: [], author: 'claude' },
    { id: 'h-b', type: 'heading', level: 3, text: 'Goal', tags: [], author: 'claude',
      badge: 'jira template', info: 'What is the purpose of this feature?' },
    { id: 'p-b', type: 'para', text: 'Body.', tags: [], author: 'claude' },
    { id: 'h-c', type: 'heading', level: 3, text: 'Use cases', tags: [], author: 'claude' }
  ];
  const e = boot(wrap(buildBody(m), 'Badge Doc'));
  await settle();
  const badge = blockEl(e.d, 'h-b').querySelector('.la-badge');
  ok('a section from a template is badged', !!badge);
  eq('with the source named', badge.textContent, 'jira template');
  ok('a section this document invented is not',
    !blockEl(e.d, 'h-c').querySelector('.la-badge'));

  eq('a top-level heading sits at depth 0', blockEl(e.d, 'h-a').dataset.depth, '0');
  eq('a sub-heading one level in', blockEl(e.d, 'h-b').dataset.depth, '1');
  eq('and its body one level further', blockEl(e.d, 'p-b').dataset.depth, '2');

  blockEl(e.d, 'h-b').querySelector('.la-headbody').click();
  await settle();
  const ta = blockEl(e.d, 'h-b').querySelector('textarea');
  ta.value = 'Goal\n\nRewritten guidance.';
  ta.dispatchEvent(new e.w.FocusEvent('blur'));
  await settle();
  ok('editing the heading leaves the badge alone',
    blockEl(e.d, 'h-b').querySelector('.la-badge').textContent === 'jira template');

  await e.w.__la.flush();
  await settle();
  const back = extractModel(e.published[e.published.length - 1]);
  eq('and it survives a save', back.blocks.find((b) => b.id === 'h-b').badge, 'jira template');
}

console.log('\nsection labels: where you are, over what is being claimed');
{
  const m = fixture();
  m.blocks = [
    { id: 'h-a', type: 'heading', level: 2, text: 'Problem', tags: [], author: 'claude' },
    { id: 'h-b', type: 'heading', level: 3, tags: [], author: 'claude',
      eyebrow: 'Problem description',
      text: 'A customer switching a person off changes nothing at Verbolia',
      info: 'What problem does it solve?' },
    { id: 'p-b', type: 'para', text: 'Body.', tags: [], author: 'claude' }
  ];
  const e = boot(wrap(buildBody(m), 'Eyebrow Doc'));
  await settle();
  const h = () => blockEl(e.d, 'h-b');
  eq('the label renders above the heading',
    h().querySelector('.la-eyebrow-sec').textContent, 'Problem description');
  eq('and the heading carries the claim',
    h().querySelector('h3').textContent, 'A customer switching a person off changes nothing at Verbolia');
  ok('the label names the section for a screen reader on the handle',
    /Problem description: A customer/.test(h().querySelector('.la-handle').getAttribute('aria-label')));

  h().querySelector('.la-headbody').click();
  await settle();
  const ta = h().querySelector('textarea');
  eq('it edits as label then heading, with no guidance in the box', ta.value,
    'Problem description\nA customer switching a person off changes nothing at Verbolia');
  ta.value = 'Problem\nStill a claim';
  ta.dispatchEvent(new e.w.FocusEvent('blur'));
  await settle();
  eq('a rewritten label lands', blockEl(e.d, 'h-b').querySelector('.la-eyebrow-sec').textContent, 'Problem');

  blockEl(e.d, 'h-b').querySelector('.la-headbody').click();
  await settle();
  const t3 = blockEl(e.d, 'h-b').querySelector('textarea');
  t3.value = 'Context\nA short claim\nCurrently sign-in uses a password.\n\nAnd a second paragraph.';
  t3.dispatchEvent(new e.w.FocusEvent('blur'));
  await settle();
  eq('prose typed past the heading does not stay in the heading',
    blockEl(e.d, 'h-b').querySelector('h3').textContent, 'A short claim');
  const spill = [...e.d.querySelectorAll('.la-block')]
    .find((n) => /Currently sign-in uses a password/.test(n.textContent));
  ok('it becomes a paragraph instead', !!spill && spill.dataset.type === 'para');
  ok('directly under the heading it was typed into',
    spill.previousElementSibling.dataset.blockId === 'h-b');
  ok('and the whole tail survives, not only its first line',
    /And a second paragraph/.test(spill.textContent));

  blockEl(e.d, 'h-b').querySelector('.la-headbody').click();
  await settle();
  const t4 = blockEl(e.d, 'h-b').querySelector('textarea');
  t4.value = 'Just a heading now';
  t4.dispatchEvent(new e.w.FocusEvent('blur'));
  await settle();
  ok('dropping the first line drops the label',
    !blockEl(e.d, 'h-b').querySelector('.la-eyebrow-sec'));

  await e.w.__la.flush();
  await settle();
  const back = extractModel(e.published[e.published.length - 1]);
  const hb2 = back.blocks.find((b) => b.id === 'h-b');
  ok('and the model has no orphan eyebrow left behind', hb2.eyebrow === undefined);
  ok('the guidance is still there after two edits that never showed it',
    /What problem does it solve/.test(hb2.info));
}

console.log(failed ? `\n${failed} failing\n` : '\nall green\n');
process.exit(failed ? 1 : 0);
