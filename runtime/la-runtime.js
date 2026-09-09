/* living-artifacts runtime — v1 (model + read-back loop).
 *
 * The document's truth is the JSON in <script id="la-model">. The DOM is a
 * rendering of it and is never read back. Saving re-emits a COMPLETE html
 * file from the model and hands it to artifact.publish(), and appends the
 * revision's ops to db so Claude can read intent without parsing the page.
 *
 * Never write a literal closing script tag in this file — it is re-emitted
 * inside a script element by buildDocument().
 */
(function () {
  'use strict';

  var MODEL_EL = 'la-model', STYLE_EL = 'la-style', RUNTIME_EL = 'la-runtime';
  var model, pending = [], caps = { artifact: null, db: null };
  var readOnly = true, selected = null, editing = null, statusTimer = null;

  /* ------------------------------------------------------------------ util */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  /* Deliberately tiny inline subset. The model stores plain text with these
     markers, so an edit never yields contenteditable HTML soup. */
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  }
  function uid(p) {
    return p + '-' + Math.random().toString(36).slice(2, 7);
  }
  function nowIso() { return new Date().toISOString(); }
  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…[truncated]' : s;
  }

  /* ----------------------------------------------------------- model access */
  function loadModel() {
    try { return JSON.parse(document.getElementById(MODEL_EL).textContent); }
    catch (e) { return null; }
  }
  function blockIndex(id) {
    for (var i = 0; i < model.blocks.length; i++) if (model.blocks[i].id === id) return i;
    return -1;
  }
  function getBlock(id) { var i = blockIndex(id); return i < 0 ? null : model.blocks[i]; }

  /* The textarea representation of a block. One reversible function pair per
     type keeps editing plain-text and the model structured. */
  function blockSource(b) {
    switch (b.type) {
      case 'list': return (b.items || []).join('\n');
      case 'table': return [(b.head || []).join('\t')]
        .concat((b.rows || []).map(function (r) { return r.join('\t'); })).join('\n');
      case 'callout': return (b.title ? b.title + '\n\n' : '') + (b.text || '');
      default: return b.text || '';
    }
  }
  function applySource(b, src) {
    switch (b.type) {
      case 'list':
        b.items = src.split('\n').map(function (l) { return l.replace(/^\s*[-*]\s*/, '').trim(); })
          .filter(Boolean);
        break;
      case 'table':
        var rows = src.split('\n').filter(function (l) { return l.trim(); })
          .map(function (l) { return l.split('\t').map(function (c) { return c.trim(); }); });
        b.head = rows.shift() || [];
        b.rows = rows;
        break;
      case 'callout':
        var parts = src.split(/\n\s*\n/);
        b.title = parts.length > 1 ? parts.shift().trim() : (b.title || '');
        b.text = parts.join('\n\n').trim();
        break;
      default:
        b.text = src;
    }
  }

  /* ------------------------------------------------------------------- ops */
  function record(op) {
    pending.push(op);
    if (op.block) {
      var b = getBlock(op.block);
      if (b) b.touched = { rev: model.rev + 1, by: 'viewer' };
    }
    renderBar();
  }

  /* ---------------------------------------------------------------- render */
  function render() {
    var root = document.getElementById('la-root');
    root.textContent = '';
    root.appendChild(renderHead());
    var wrap = el('div', 'la-blocks');
    model.blocks.forEach(function (b) { wrap.appendChild(renderBlock(b)); });
    root.appendChild(wrap);
    if (!readOnly) root.appendChild(renderAddRow());
    renderBar();
  }

  function renderHead() {
    var h = el('header', 'la-head');
    var eye = el('div', 'la-eyebrow');
    if (model.thread) eye.appendChild(el('span', null, model.thread));
    if (model.component) eye.appendChild(el('span', null, '· ' + model.component));
    eye.appendChild(el('span', 'la-rev', 'rev ' + model.rev));
    h.appendChild(eye);
    h.appendChild(el('h1', 'la-title', model.title));
    if (model.updated) h.appendChild(el('p', 'la-updated', 'Updated: ' + model.updated));
    h.appendChild(renderContract());
    return h;
  }

  function renderContract() {
    var d = el('details', 'la-contract');
    d.open = !!(model.style && model.style.directives || []).length;
    var directives = (model.style && model.style.directives) || [];
    var sum = el('summary', null,
      'Style contract — ' + directives.filter(function (x) { return x.active; }).length + ' active');
    d.appendChild(sum);
    var ul = el('ul');
    directives.forEach(function (dir) {
      var li = el('li', dir.active ? '' : 'off');
      li.appendChild(el('span', null, dir.text));
      if (!readOnly) {
        var t = el('button', 'la-btn', dir.active ? 'mute' : 'unmute');
        t.onclick = function () {
          dir.active = !dir.active;
          record({ op: 'style', action: dir.active ? 'unmute' : 'mute', text: dir.text });
          render();
        };
        var x = el('button', 'la-btn danger', 'remove');
        x.onclick = function () {
          model.style.directives = directives.filter(function (o) { return o !== dir; });
          record({ op: 'style', action: 'remove', text: dir.text });
          render();
        };
        li.appendChild(t); li.appendChild(x);
      }
      ul.appendChild(li);
    });
    d.appendChild(ul);
    if (!readOnly) {
      var row = el('div', 'la-inline');
      var inp = el('input');
      inp.placeholder = 'e.g. no hedging — drop "it seems", "arguably"';
      inp.setAttribute('aria-label', 'New style directive');
      var add = el('button', 'la-btn primary', 'Add');
      function commit() {
        var v = inp.value.trim();
        if (!v) return;
        model.style = model.style || {};
        model.style.directives = (model.style.directives || [])
          .concat([{ id: uid('s'), text: v, rev: model.rev + 1, active: true }]);
        record({ op: 'style', action: 'add', text: v });
        render();
      }
      add.onclick = commit;
      inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
      row.appendChild(inp); row.appendChild(add);
      d.appendChild(row);
    }
    return d;
  }

  function renderBody(b) {
    var body = el('div', 'la-body');
    switch (b.type) {
      case 'heading':
        var h = el(b.level === 3 ? 'h3' : 'h2');
        h.id = b.id; h.innerHTML = inline(b.text || '');
        body.appendChild(h); break;
      case 'list':
        var list = el(b.ordered ? 'ol' : 'ul');
        (b.items || []).forEach(function (it) {
          var li = el('li'); li.innerHTML = inline(it); list.appendChild(li);
        });
        body.appendChild(list); break;
      case 'table':
        var w = el('div', 'la-tablewrap'), t = el('table'),
          thead = el('thead'), tr = el('tr');
        (b.head || []).forEach(function (c) {
          var th = el('th'); th.innerHTML = inline(c); tr.appendChild(th);
        });
        thead.appendChild(tr); t.appendChild(thead);
        var tb = el('tbody');
        (b.rows || []).forEach(function (r) {
          var row = el('tr');
          r.forEach(function (c) { var td = el('td'); td.innerHTML = inline(c); row.appendChild(td); });
          tb.appendChild(row);
        });
        t.appendChild(tb); w.appendChild(t); body.appendChild(w); break;
      case 'code':
        var pre = el('pre'), cd = el('code', null, b.text || '');
        pre.appendChild(cd); body.appendChild(pre); break;
      case 'callout':
        var c = el('div', 'la-callout');
        if (b.title) c.appendChild(el('span', 'la-callout-t', b.title));
        var cp = el('p'); cp.innerHTML = inline(b.text || ''); cp.style.margin = '0';
        c.appendChild(cp); body.appendChild(c); break;
      case 'divider':
        body.appendChild(el('hr', 'la-divider')); break;
      default:
        var p = el('p'); p.innerHTML = inline(b.text || ''); body.appendChild(p);
    }
    return body;
  }

  function renderBlock(b) {
    var wrap = el('div', 'la-block');
    wrap.dataset.blockId = b.id;
    wrap.dataset.type = b.type;
    if (b.touched) wrap.dataset.touched = '1';
    if (selected === b.id) wrap.classList.add('sel');

    if (!readOnly) {
      var handle = el('button', 'la-handle', '⠿');
      handle.title = 'Select block';
      handle.setAttribute('aria-label', 'Select block ' + b.id);
      handle.onclick = function (e) {
        e.stopPropagation();
        selected = (selected === b.id) ? null : b.id;
        render();
      };
      wrap.appendChild(handle);
    }

    if (b.note) {
      var n = el('div', 'la-note');
      n.appendChild(el('b', null, 'note to claude'));
      n.appendChild(document.createTextNode(b.note));
      wrap.appendChild(n);
    }

    if (editing === b.id) wrap.appendChild(renderEditor(b));
    else wrap.appendChild(renderBody(b));

    if ((b.tags && b.tags.length) || (!readOnly && selected === b.id)) {
      wrap.appendChild(renderMeta(b));
    }
    if (!readOnly && selected === b.id && editing !== b.id) {
      wrap.appendChild(renderBlockActions(b));
    }
    return wrap;
  }

  function renderMeta(b) {
    var m = el('div', 'la-meta');
    (b.tags || []).forEach(function (tag) {
      var isIntent = /^(expand|summarize|seed-next|rewrite|cut|verify)$/.test(tag);
      var chip = el('button', 'la-tag' + (isIntent ? ' intent' : ''), '#' + tag);
      chip.title = readOnly ? tag : 'Remove tag';
      if (!readOnly) chip.onclick = function () {
        b.tags = b.tags.filter(function (t) { return t !== tag; });
        record({ op: 'untag', block: b.id, tag: tag });
        render();
      };
      m.appendChild(chip);
    });
    if (!readOnly && selected === b.id) {
      var inp = el('input');
      inp.placeholder = 'tag… (expand, for:sales)';
      inp.setAttribute('aria-label', 'Add tag');
      inp.style.maxWidth = '190px';
      inp.className = '';
      var box = el('span', 'la-inline');
      box.style.margin = '0';
      var add = el('button', 'la-btn', '+ tag');
      function commit() {
        var v = inp.value.trim().replace(/^#/, '');
        if (!v) return;
        b.tags = (b.tags || []).concat([v]);
        record({ op: 'tag', block: b.id, tag: v });
        render();
      }
      add.onclick = commit;
      inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
      box.appendChild(inp); box.appendChild(add);
      m.appendChild(box);
    }
    return m;
  }

  function renderBlockActions(b) {
    var bar = el('div', 'la-editbar'), i = blockIndex(b.id);
    function btn(label, cls, fn) {
      var x = el('button', 'la-btn' + (cls ? ' ' + cls : ''), label);
      x.onclick = fn; bar.appendChild(x); return x;
    }
    if (b.type !== 'divider') btn('edit', '', function () { editing = b.id; render(); });
    btn('↑', '', function () { move(b.id, -1); }).disabled = i === 0;
    btn('↓', '', function () { move(b.id, 1); }).disabled = i === model.blocks.length - 1;
    btn(b.note ? 'edit note' : 'note to claude', '', function () { promptNote(b); });
    btn('delete', 'danger', function () { removeBlock(b); });
    return bar;
  }

  function renderEditor(b) {
    var wrap = el('div');
    var ta = el('textarea', 'la-edit');
    ta.value = blockSource(b);
    ta.setAttribute('aria-label', 'Edit block');
    var bar = el('div', 'la-editbar');
    var save = el('button', 'la-btn primary', 'Apply');
    var cancel = el('button', 'la-btn', 'Cancel');
    bar.appendChild(save); bar.appendChild(cancel);
    bar.appendChild(el('span', null, '⌘↩ apply · esc cancel'));
    function apply() {
      var before = blockSource(b), after = ta.value;
      editing = null;
      if (before !== after) {
        applySource(b, after);
        b.author = 'viewer';
        record({ op: 'edit', block: b.id, before: clip(before, 1500), after: clip(after, 1500) });
      }
      render();
    }
    save.onclick = apply;
    cancel.onclick = function () { editing = null; render(); };
    ta.onkeydown = function (e) {
      if (e.key === 'Escape') { editing = null; render(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply(); }
    };
    wrap.appendChild(ta); wrap.appendChild(bar);
    setTimeout(function () { ta.focus(); ta.style.height = ta.scrollHeight + 'px'; }, 0);
    return wrap;
  }

  /* Modal dialogs do nothing in a sandboxed artifact frame — always inline. */
  function promptNote(b) {
    var host = document.querySelector('[data-block-id="' + b.id + '"]');
    if (!host || $('.la-noteform', host)) return;
    var form = el('div', 'la-inline'); form.className = 'la-inline la-noteform';
    var inp = el('input');
    inp.value = b.note || '';
    inp.placeholder = 'what should Claude do here?';
    inp.setAttribute('aria-label', 'Note to Claude');
    var ok = el('button', 'la-btn primary', 'Save note');
    function commit() {
      var v = inp.value.trim();
      b.note = v || undefined;
      record({ op: 'note', block: b.id, text: v });
      render();
    }
    ok.onclick = commit;
    inp.onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { form.remove(); }
    };
    form.appendChild(inp); form.appendChild(ok);
    host.appendChild(form);
    inp.focus();
  }

  function move(id, dir) {
    var i = blockIndex(id), j = i + dir;
    if (i < 0 || j < 0 || j >= model.blocks.length) return;
    var b = model.blocks.splice(i, 1)[0];
    model.blocks.splice(j, 0, b);
    record({ op: 'move', block: id, from: i, to: j });
    render();
  }

  function removeBlock(b) {
    var i = blockIndex(b.id);
    if (i < 0) return;
    model.blocks.splice(i, 1);
    if (selected === b.id) selected = null;
    /* Deletions are the highest-regret edit: keep the text in the journal so
       Claude reports what left rather than silently losing it. */
    record({ op: 'delete', block: b.id, type: b.type, text: clip(blockSource(b), 1500) });
    render();
  }

  function renderAddRow() {
    var bar = el('div', 'la-editbar');
    bar.style.paddingLeft = '34px';
    ['para', 'heading', 'list', 'callout', 'code', 'table', 'divider'].forEach(function (t) {
      var x = el('button', 'la-btn', '+ ' + t);
      x.onclick = function () {
        var b = { id: uid('b'), type: t, author: 'viewer', tags: [] };
        if (t === 'heading') { b.text = 'New heading'; b.level = 2; }
        else if (t === 'list') b.items = ['New item'];
        else if (t === 'table') { b.head = ['Column']; b.rows = [['value']]; }
        else if (t === 'callout') { b.title = 'Note'; b.text = 'New callout'; }
        else if (t !== 'divider') b.text = 'New ' + t;
        var at = selected ? blockIndex(selected) + 1 : model.blocks.length;
        model.blocks.splice(at, 0, b);
        selected = b.id;
        record({ op: 'insert', block: b.id, type: t, at: at });
        editing = t === 'divider' ? null : b.id;
        render();
      };
      bar.appendChild(x);
    });
    return bar;
  }

  /* ------------------------------------------------------------------- bar */
  function renderBar() {
    var bar = document.getElementById('la-bar');
    if (!bar) { bar = el('div', 'la-bar'); bar.id = 'la-bar'; document.body.appendChild(bar); }
    bar.textContent = '';
    var st = el('div', 'la-status');
    st.id = 'la-status';
    st.textContent = readOnly
      ? 'Read-only view — editing is unavailable here.'
      : (pending.length ? pending.length + ' unsaved change' + (pending.length > 1 ? 's' : '')
        : 'No unsaved changes · rev ' + model.rev);
    bar.appendChild(st);
    if (!readOnly) {
      var save = el('button', 'la-btn primary', 'Save ⌘S');
      save.disabled = !pending.length;
      save.onclick = doSave;
      bar.appendChild(save);
    }
  }
  function status(msg, isErr) {
    var st = document.getElementById('la-status');
    if (!st) return;
    st.textContent = msg;
    st.className = 'la-status' + (isErr ? ' err' : '');
    clearTimeout(statusTimer);
    if (!isErr) statusTimer = setTimeout(renderBar, 4000);
  }

  /* ------------------------------------------------------- document output */
  function buildDocument() {
    var css = document.getElementById(STYLE_EL).textContent;
    var js = document.getElementById(RUNTIME_EL).textContent;
    /* '<' can only occur inside JSON string literals, where < is a legal
       escape — so this can never break out of the script element. */
    var json = JSON.stringify(model, null, 2).replace(/</g, '\\u003c');
    var S = '<' + 'script', E = '<' + '/' + 'script>';
    return '<!doctype html>\n<html lang="en">\n<head>\n'
      + '<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<title>' + esc(model.title) + '</title>\n'
      + '<style id="' + STYLE_EL + '">\n' + css + '\n</style>\n'
      + '</head>\n<body>\n'
      + S + ' type="application/json" id="' + MODEL_EL + '">\n' + json + '\n' + E + '\n'
      + '<div class="la-shell"><div id="la-root"></div></div>\n'
      + S + ' id="' + RUNTIME_EL + '">\n' + js + '\n' + E + '\n'
      + '</body>\n</html>\n';
  }

  /* -------------------------------------------------------------- journal */
  function tagCounts() {
    var out = {};
    model.blocks.forEach(function (b) {
      (b.tags || []).forEach(function (t) { out[t] = (out[t] || 0) + 1; });
    });
    return out;
  }
  function registry() {
    return {
      docId: model.docId, title: model.title,
      thread: model.thread || '', component: model.component || '',
      rev: model.rev, updatedAt: nowIso(),
      blockCount: model.blocks.length, tagCounts: tagCounts(),
      openNotes: model.blocks.filter(function (b) { return b.note; }).length,
      styleDirectives: ((model.style || {}).directives || [])
        .filter(function (d) { return d.active; }).map(function (d) { return d.text; })
    };
  }
  /* One document per revision, not per op: the store caps an artifact at
     5,000 documents and warns against one-doc-per-event streams. */
  async function writeJournal(entry) {
    if (!caps.db) return 'db unavailable';
    try {
      await caps.db.doc('docs/' + model.docId + '/journal/r' + entry.rev).set(entry);
      await caps.db.doc('docs/' + model.docId).set(registry());
      return null;
    } catch (e) {
      return 'journal not written (' + (e && e.code ? e.code : 'error') + ')';
    }
  }

  /* ----------------------------------------------------------------- save */
  var saving = false;
  async function doSave() {
    if (saving || !pending.length || readOnly) return;
    saving = true;
    status('Saving…');

    var target = model.rev + 1;
    var entry = { rev: target, at: nowIso(), by: 'viewer', ops: pending.slice() };

    /* Only the latest revision stays marked — clear the previous round first. */
    model.blocks.forEach(function (b) {
      if (b.touched && b.touched.rev < target) delete b.touched;
    });
    model.rev = target;
    model.updated = entry.ops.length + ' edit' + (entry.ops.length > 1 ? 's' : '')
      + ' by viewer · ' + entry.at.slice(0, 10);
    model.journal = (model.journal || []).concat([entry]).slice(-40);

    var dbWarn = await writeJournal(entry);

    /* A conflict reloads this view and drops the edit, so stash first. */
    try {
      sessionStorage.setItem('la-stash:' + model.docId,
        JSON.stringify({ rev: target, at: entry.at, ops: entry.ops }));
    } catch (e) { /* private mode — nothing to do */ }

    var html;
    try { html = buildDocument(); }
    catch (e) { saving = false; return status('Could not build the document: ' + e.message, true); }

    try {
      await caps.artifact.publish(html);
      /* This view reloads to the new version; nothing after this runs. */
    } catch (e) {
      saving = false;
      model.rev = target - 1;
      var code = e && e.code;
      if (code === 'conflict') return status('Someone published first — reloading to their version.', true);
      if (code === 'not_writer' || code === 'not_granted' || code === 'not_declared') {
        readOnly = true; render();
        return status('This view is read-only — your edits were not saved.', true);
      }
      if (code === 'too_large') return status('Document is over the size limit — split it.', true);
      if (code === 'rate_limited') return status('Saving too often — wait a moment and try again.', true);
      return status('Save failed (' + (code || 'unknown') + ')'
        + (dbWarn ? ' · ' + dbWarn : '') + '. Your edits are still on the page.', true);
    }
  }

  /* ------------------------------------------------------------- recovery */
  function checkStash() {
    var key = 'la-stash:' + model.docId, raw;
    try { raw = sessionStorage.getItem(key); } catch (e) { return; }
    if (!raw) return;
    var s;
    try { s = JSON.parse(raw); } catch (e) { try { sessionStorage.removeItem(key); } catch (e2) {} return; }
    if (model.rev >= s.rev) { try { sessionStorage.removeItem(key); } catch (e) {} return; }
    var box = el('div', 'la-recovered');
    box.appendChild(el('b', null, 'The last save did not land.'));
    box.appendChild(el('p', null,
      'These ' + s.ops.length + ' edit(s) from ' + s.at.slice(0, 16).replace('T', ' ')
      + ' are not in this version. Re-apply them by hand, or tell Claude — they are in the journal below.'));
    box.appendChild(el('pre', null, JSON.stringify(s.ops, null, 2)));
    var x = el('button', 'la-btn', 'Dismiss');
    x.onclick = function () { try { sessionStorage.removeItem(key); } catch (e) {} box.remove(); };
    box.appendChild(x);
    document.getElementById('la-root').prepend(box);
  }

  /* ----------------------------------------------------------------- boot */
  function boot() {
    model = loadModel();
    var root = document.getElementById('la-root');
    if (!model || !Array.isArray(model.blocks)) {
      root.textContent = 'This document has no readable model.';
      return;
    }
    model.rev = model.rev || 0;
    render();
    checkStash();

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
    });

    /* Capabilities never resolve during this first synchronous run, and are
       not ordered against DOMContentLoaded. Render read-only, then light up. */
    if (!window.claude || typeof window.claude.use !== 'function') return;
    Promise.all([
      window.claude.use('artifact').catch(function () { return null; }),
      window.claude.use('db').catch(function () { return null; })
    ]).then(function (r) {
      caps.artifact = r[0]; caps.db = r[1];
      if (caps.artifact) { readOnly = false; render(); }
      else renderBar();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
