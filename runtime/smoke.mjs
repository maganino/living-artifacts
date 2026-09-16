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
          forms.push('files'); published.push(arg['index.html']);
        } else { forms.push('html'); published.push(arg); }
        return { version: 'v' + published.length };
      }
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
ok('undo starts disabled', btn(d.body, '↶ Undo').disabled === true);
ok('no Save button until there is something to save', !btn(d.body, 'Save now'));
ok('the status line says how to drive it', /click a block to edit/i.test(d.getElementById('la-status').textContent));

console.log('\nC-3: click the box to edit, no selection step');
blockEl(d, 'b-two').querySelector('.la-body').click();
const ta = blockEl(d, 'b-two').querySelector('textarea');
ok('a click on the body opens the editor', !!ta && ta.value.includes('**bold**'));
commitEdit(env, 'b-two', 'Rewritten by the human.');
ok('clicking away keeps the edit — no Apply button', blockEl(d, 'b-two').textContent.includes('Rewritten by the human'));
ok('the committed block is marked touched', blockEl(d, 'b-two').dataset.touched === '1');
ok('the Apply / Cancel buttons are gone',
  !btn(blockEl(d, 'b-two'), 'Apply') && !btn(blockEl(d, 'b-two'), 'Cancel'));
ok('undo enables once there is an edit', btn(d.body, '↶ Undo').disabled === false);
ok('a "Save now" flush appears while unsaved', !!btn(d.body, 'Save now'));
{
  const kids = [...d.getElementById('la-bar').children];
  eq('Save now sits at the left end of the bar', kids[0].textContent, 'Save now');
  ok('the status line follows it', kids[1].id === 'la-status');
  ok('the rest of the controls stay to its right',
    kids.slice(2).map((n) => n.textContent.trim().split(' ').pop()).join(',') === 'Undo,Redo,Filter,⤓',
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
  ok('generation-1 marks were cleared', m3.blocks.filter((b) => b.touched).length === 1);
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
  await e4.w.__la.flush();
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
  await e5.w.__la.flush();
  await settle();
  ok('a conflict says the reload is coming, not that saving failed',
    /published first/i.test(e5.d.getElementById('la-status').textContent));
  ok('unsaved work is stashed before publish', !!e5.w.sessionStorage.getItem('la-stash:smoke-doc'));
}

console.log(failed ? `\n${failed} failing\n` : '\nall green\n');
process.exit(failed ? 1 : 0);
