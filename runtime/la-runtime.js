/* living-artifacts runtime — v1.1 (direct manipulation).
 *
 * The document's truth is the JSON in <script id="la-model">. The DOM is a
 * rendering of it and is never read back. Saving re-emits a COMPLETE html
 * file from the model and hands it to artifact.publish(), and appends the
 * revision's ops to db so Claude can read intent without parsing the page.
 *
 * Interaction model: hover a block to reveal its affordances, click it to
 * edit, drag its handle to reorder, select text to tag it. There is no
 * select-then-act step — v1 had one and it went unused.
 *
 * Never write a literal closing script tag in this file — it is re-emitted
 * inside a script element by buildDocument().
 */
(function () {
  'use strict';

  var MODEL_EL = 'la-model', STYLE_EL = 'la-style', RUNTIME_EL = 'la-runtime';
  var INTENTS = /^(expand|summarize|seed-next|rewrite|cut|verify)$/;
  var SOT = String.fromCharCode(1), EOT = String.fromCharCode(2), SEP = String.fromCharCode(3);
  /* distinguishable hues that survive both themes; assigned in creation order */
  var HUES = [8, 28, 48, 96, 150, 188, 214, 260, 300, 334];
  var model, pending = [], caps = { artifact: null, db: null };
  var readOnly = true, editing = null, tagging = null, tagQuote = null, tagTargets = null;
  var statusTimer = null, drag = null;
  var undoStack = [], redoStack = [], baseline = null;
  var saveTimer = null, filesForm = null, SAVE_DEBOUNCE = 2500, UNDO_DEPTH = 60;
  var filter = [], inGroup = false, groupPushed = false, selAnchor = null;
  var filterAnchor = null, FILTER_W = 268;
  var KNOWN = ['expand', 'summarize', 'seed-next', 'rewrite', 'cut', 'verify'];

  /* ------------------------------------------------------------------ util */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  /* Range tags are anchored by QUOTE, not by character offset — an offset
     breaks the moment anything above it is edited. Sentinels go in before
     escaping so they survive it, then become real elements after. */
  function withMarks(text, marks) {
    if (!marks || !marks.length) return inline(text);
    var t = String(text == null ? '' : text), hit = false;
    marks.forEach(function (m, idx) {
      if (!m.quote) return;
      var i = t.indexOf(m.quote);
      if (i < 0) return;
      hit = true;
      t = t.slice(0, i) + SOT + idx + SEP + m.quote + EOT + t.slice(i + m.quote.length);
    });
    if (!hit) return inline(text);
    var open = new RegExp(SOT + '(\\d+)' + SEP, 'g');
    return inline(t)
      .replace(open, function (_, n) {
        var m = marks[Number(n)];
        return m && m.tag
          ? '<mark class="la-mark" style="--tag-h:' + tagHue(m.tag) + '">'
          : '<mark class="la-mark untagged">';
      })
      .split(EOT).join('</mark>');
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  /* A tag keeps its colour for the life of the document, so the reader learns
     it. Stored in the model, so Claude sees the same mapping. */
  function tagHue(tag) {
    model.tagColors = model.tagColors || {};
    if (model.tagColors[tag] == null) {
      model.tagColors[tag] = HUES[Object.keys(model.tagColors).length % HUES.length];
    }
    return model.tagColors[tag];
  }
  function paint(node, tag) {
    if (tag) node.style.setProperty('--tag-h', tagHue(tag));
    else node.classList.add('untagged');
    return node;
  }
  function allTags() {
    var counts = {};
    model.blocks.forEach(function (b) {
      (b.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
      (b.marks || []).forEach(function (m) { if (m.tag) counts[m.tag] = (counts[m.tag] || 0) + 1; });
    });
    return counts;
  }
  function matchesFilter(b) {
    if (!filter.length) return true;
    return filter.some(function (t) {
      return (b.tags || []).indexOf(t) !== -1
        || (b.marks || []).some(function (m) { return m.tag === t; });
    });
  }
  function uid(p) { return p + '-' + Math.random().toString(36).slice(2, 7); }
  function nowIso() { return new Date().toISOString(); }
  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
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
  function blockText(b) {
    return b.type === 'list' ? (b.items || []).join('\n') : (b.text || '');
  }

  /* One reversible pair per type keeps editing plain-text and the model
     structured — the textarea shows exactly what the model holds. */
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
  /* `baseline` is the model as of the PREVIOUS recorded op, so at the moment
     record() runs it is exactly the pre-mutation state this op should undo to. */
  function record(op) {
    if (baseline && !(inGroup && groupPushed)) {
      undoStack.push({ model: baseline, pendingLen: pending.length, label: op.op });
      groupPushed = true;
      if (undoStack.length > UNDO_DEPTH) undoStack.shift();
      redoStack.length = 0;
    }
    pending.push(op);
    if (op.block) {
      var b = getBlock(op.block);
      if (b) b.touched = { rev: model.rev + 1, by: 'viewer' };
    }
    baseline = clone(model);
    scheduleSave();
    renderBar();
  }

  /* Several ops from one gesture (tagging four blocks at once) undo together. */
  function group(fn) {
    inGroup = true; groupPushed = false;
    try { fn(); } finally { inGroup = false; groupPushed = false; }
  }

  /* Undo restores the blocks, never the revision counter — rewinding rev
     would make the next save overwrite a version that already exists. */
  function restore(entry, undoneLabel, fromStack, toStack) {
    var keep = {
      rev: model.rev, updated: model.updated,
      journal: model.journal, url: model.url, docId: model.docId
    };
    toStack.push({ model: clone(model), pendingLen: pending.length, label: undoneLabel });
    model = entry.model;
    model.rev = keep.rev; model.updated = keep.updated;
    model.journal = keep.journal; model.url = keep.url; model.docId = keep.docId;
    baseline = clone(model);
    /* If the op being reversed has not been saved yet, drop it rather than
       recording a reversal — the journal should not carry both. */
    if (pending.length > entry.pendingLen) pending.length = entry.pendingLen;
    else pending.push({ op: fromStack === undoStack ? 'undo' : 'redo', undid: undoneLabel });
    editing = null; tagging = null; tagQuote = null;
    render();
    scheduleSave();
  }
  function undo() {
    if (!undoStack.length || readOnly) return false;
    var e = undoStack.pop();
    restore(e, e.label, undoStack, redoStack);
    status('Undid ' + e.label);
    return true;
  }
  function redo() {
    if (!redoStack.length || readOnly) return false;
    var e = redoStack.pop();
    restore(e, e.label, redoStack, undoStack);
    status('Redid ' + e.label);
    return true;
  }

  /* ---------------------------------------------------------------- render */
  function render() {
    var root = document.getElementById('la-root');
    var scroll = window.scrollY;
    root.textContent = '';
    root.appendChild(renderHead());
    var wrap = el('div', 'la-blocks');
    model.blocks.forEach(function (b) {
      var node = renderBlock(b);
      /* Filtering is a VIEW, never an edit — nothing here reaches the model. */
      if (!matchesFilter(b)) node.hidden = true;
      wrap.appendChild(node);
    });
    root.appendChild(wrap);
    if (!readOnly) root.appendChild(renderAddRow());
    renderBar();
    /* a full re-render resets scroll; restore it so an edit deep in a long
       document does not throw the reader back to the top */
    if (typeof window.scrollTo === 'function' && window.scrollY !== scroll) {
      try { window.scrollTo(0, scroll); } catch (e) { /* unsupported */ }
    }
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
    var directives = (model.style && model.style.directives) || [];
    var active = directives.filter(function (x) { return x.active; }).length;
    var d = el('details', 'la-contract');
    d.open = true;
    /* v1 called this "Style contract" and the first reader's comment was
       "not sure what is this". Say what it does, in the reader's words. */
    d.appendChild(el('summary', null,
      'How this document should be written — ' + active + ' rule' + (active === 1 ? '' : 's')));
    d.appendChild(el('p', 'la-contract-help',
      'Standing instructions for the whole page. Claude applies every rule here each time it '
      + 'rewrites anything, not only the round you added it. Mute a rule instead of removing it '
      + 'if you might want it back.'));
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
      inp.placeholder = 'e.g. lead with the number, not the caveat';
      inp.setAttribute('aria-label', 'New writing rule');
      var add = el('button', 'la-btn primary', 'Add rule');
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
    var body = el('div', 'la-body'), marks = b.marks || [];
    switch (b.type) {
      case 'heading':
        var h = el(b.level === 3 ? 'h3' : 'h2');
        h.id = b.id; h.innerHTML = withMarks(b.text || '', marks);
        body.appendChild(h); break;
      case 'list':
        var list = el(b.ordered ? 'ol' : 'ul');
        (b.items || []).forEach(function (it) {
          var li = el('li'); li.innerHTML = withMarks(it, marks); list.appendChild(li);
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
          r.forEach(function (c) {
            var td = el('td'); td.innerHTML = withMarks(c, marks); row.appendChild(td);
          });
          tb.appendChild(row);
        });
        t.appendChild(tb); w.appendChild(t); body.appendChild(w); break;
      case 'code':
        var pre = el('pre'), cd = el('code', null, b.text || '');
        pre.appendChild(cd); body.appendChild(pre); break;
      case 'callout':
        var c = el('div', 'la-callout');
        if (b.title) c.appendChild(el('span', 'la-callout-t', b.title));
        var cp = el('p'); cp.innerHTML = withMarks(b.text || '', marks); cp.style.margin = '0';
        c.appendChild(cp); body.appendChild(c); break;
      case 'divider':
        body.appendChild(el('hr', 'la-divider')); break;
      default:
        var p = el('p'); p.innerHTML = withMarks(b.text || '', marks); body.appendChild(p);
    }
    return body;
  }

  function renderBlock(b) {
    var wrap = el('div', 'la-block');
    wrap.dataset.blockId = b.id;
    wrap.dataset.type = b.type;
    if (b.touched) wrap.dataset.touched = '1';
    if (drag && drag.id === b.id) wrap.classList.add('la-drag-src');

    if (!readOnly) wrap.appendChild(renderChrome(b));

    if (b.note) {
      var n = el('div', 'la-note');
      n.appendChild(el('b', null, 'note to claude'));
      n.appendChild(document.createTextNode(b.note));
      wrap.appendChild(n);
    }

    if (editing === b.id) {
      wrap.appendChild(renderEditor(b));
    } else {
      var body = renderBody(b);
      if (!readOnly && b.type !== 'divider') {
        /* A click anywhere on the box edits it. A click that ended a text
           selection must NOT — that gesture belongs to tagging. */
        body.onclick = function (e) {
          if (e.target.closest && e.target.closest('a')) return;
          var sel = window.getSelection && window.getSelection();
          if (sel && String(sel).trim().length) return;
          editing = b.id; tagging = null; tagQuote = null; render();
        };
        body.title = 'Click to edit';
      }
      wrap.appendChild(body);
    }

    if ((b.tags && b.tags.length) || (b.marks && b.marks.length)) {
      wrap.appendChild(renderMeta(b));
    }
    return wrap;
  }

  /* Hover chrome: drag handle on the left, actions at the top right. */
  function renderChrome(b) {
    var frag = document.createDocumentFragment();

    var handle = el('button', 'la-handle', '⠿');
    handle.title = 'Drag to reorder (or focus and press up / down)';
    handle.setAttribute('aria-label', 'Reorder block: ' + clip(blockText(b) || b.type, 40));
    handle.addEventListener('pointerdown', function (e) { startDrag(e, b.id); });
    handle.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp') { e.preventDefault(); move(b.id, -1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); move(b.id, 1); }
    });
    frag.appendChild(handle);

    var acts = el('div', 'la-acts');
    function act(label, title, fn, cls) {
      var x = el('button', 'la-act' + (cls ? ' ' + cls : ''), label);
      x.title = title;
      x.setAttribute('aria-label', title);
      x.onclick = function (e) { e.stopPropagation(); fn(x); };
      acts.appendChild(x);
    }
    act('tag', 'Tag this whole block', function (btn) {
      var r = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
      openTagPop(b.id, null, null,
        r && r.width ? { top: r.bottom + window.scrollY + 6, left: r.left + window.scrollX - 150 } : null);
    });
    act('note', b.note ? 'Edit the note to Claude' : 'Pin a note to Claude on this block',
      function () { promptNote(b); });
    act('✕', 'Delete this block', function () { removeBlock(b); }, 'danger');
    frag.appendChild(acts);
    return frag;
  }

  function renderMeta(b) {
    var m = el('div', 'la-meta');
    (b.tags || []).forEach(function (tag) {
      var chip = paint(el('button', 'la-tag' + (INTENTS.test(tag) ? ' intent' : ''), '#' + tag), tag);
      chip.title = readOnly ? tag : 'Remove tag';
      if (!readOnly) chip.onclick = function () {
        b.tags = b.tags.filter(function (t) { return t !== tag; });
        record({ op: 'untag', block: b.id, tag: tag });
        render();
      };
      m.appendChild(chip);
    });
    (b.marks || []).forEach(function (mk) {
      var label = (mk.tag ? '#' + mk.tag + ' ' : '') + '\u201C' + clip(mk.quote, 30) + '\u201D';
      var chip = paint(el('button', 'la-tag ranged'
        + (mk.tag && INTENTS.test(mk.tag) ? ' intent' : ''), label), mk.tag);
      chip.title = readOnly ? (mk.tag || 'highlighted') : 'Remove this highlight';
      if (!readOnly) chip.onclick = function () {
        b.marks = b.marks.filter(function (o) { return o !== mk; });
        record({ op: 'unhighlight', block: b.id, tag: mk.tag, quote: mk.quote });
        render();
      };
      m.appendChild(chip);
    });
    return m;
  }

  /* Three things can be tagged: this block, a highlighted passage inside it,
     or every block a selection spanned. The popover opens where the gesture
     happened — beside the selection, or under the block's own tag button. */
  function closeTagPop() {
    var n = document.getElementById('la-tagpop');
    if (n) n.remove();
    tagging = null; tagQuote = null; tagTargets = null;
  }

  function applyTag(b, v, quote, targets) {
    if (!v) return;
    group(function () {
      if (targets && targets.length > 1) {
        targets.forEach(function (id) {
          var t = getBlock(id);
          if (!t) return;
          t.tags = (t.tags || []).concat([v]);
          record({ op: 'tag', block: id, tag: v, withBlocks: targets.length });
        });
      } else if (quote) {
        var mk = (b.marks || []).filter(function (o) { return o.quote === quote; })[0];
        if (mk) { mk.tag = v; } else { b.marks = (b.marks || []).concat([{ tag: v, quote: quote }]); }
        record({ op: 'tag', block: b.id, tag: v, quote: quote });
      } else {
        b.tags = (b.tags || []).concat([v]);
        record({ op: 'tag', block: b.id, tag: v });
      }
    });
    tagHue(v);
  }

  function openTagPop(blockId, quote, targets, anchor) {
    var b = getBlock(blockId);
    if (!b || readOnly) return false;
    closeTagPop();
    tagging = blockId;
    tagQuote = (quote && quote !== blockText(b)) ? quote : null;
    tagTargets = targets && targets.length > 1 ? targets : null;

    var pop = el('div', 'la-tagpop');
    pop.id = 'la-tagpop';
    if (anchor) { pop.style.top = anchor.top + 'px'; pop.style.left = anchor.left + 'px'; }

    var head = el('div', 'la-tagpop-head');
    head.textContent = tagTargets ? 'Tag ' + tagTargets.length + ' blocks'
      : tagQuote ? '\u201C' + clip(tagQuote, 44) + '\u201D'
        : 'Tag this block';
    pop.appendChild(head);

    var inp = el('input', 'la-taginput');
    inp.placeholder = 'pick one below, or type a new tag';
    inp.setAttribute('aria-label', 'Tag name');
    pop.appendChild(inp);

    var menu = el('div', 'la-tagmenu');
    pop.appendChild(menu);

    function choose(v) {
      applyTag(b, v, tagQuote, tagTargets);
      closeTagPop();
      render();
    }
    /* every tag already used in this document, then the standard intents */
    function renderMenu() {
      var q = inp.value.trim().replace(/^#/, '').toLowerCase();
      var used = Object.keys(allTags()).sort();
      var rest = KNOWN.filter(function (k) { return used.indexOf(k) === -1; });
      menu.textContent = '';
      var any = false;
      [[used, 'used here'], [rest, 'suggested']].forEach(function (pair) {
        var list = pair[0].filter(function (t) { return !q || t.toLowerCase().indexOf(q) !== -1; });
        if (!list.length) return;
        any = true;
        menu.appendChild(el('div', 'la-tagmenu-label', pair[1]));
        list.forEach(function (t) {
          var row = paint(el('button', 'la-tag la-tagmenu-item', '#' + t), t);
          row.onclick = function () { choose(t); };
          menu.appendChild(row);
        });
      });
      if (!any && q) {
        menu.appendChild(el('div', 'la-tagmenu-label', 'press enter to create #' + q));
      }
    }
    inp.oninput = renderMenu;
    inp.onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); choose(inp.value.trim().replace(/^#/, '')); }
      if (e.key === 'Escape') { e.preventDefault(); closeTagPop(); render(); }
    };
    renderMenu();

    var foot = el('div', 'la-tagpop-foot');
    var skip = el('button', 'la-btn', tagQuote ? 'leave it untagged' : 'cancel');
    skip.onclick = function () { closeTagPop(); render(); };
    foot.appendChild(skip);
    pop.appendChild(foot);

    document.body.appendChild(pop);
    setTimeout(function () { inp.focus(); }, 0);
    return true;
  }

  function renderEditor(b) {
    var wrap = el('div'), cancelled = false;
    var ta = el('textarea', 'la-edit');
    ta.value = blockSource(b);
    ta.setAttribute('aria-label', 'Edit block');
    var bar = el('div', 'la-editbar');
    bar.appendChild(el('span', null, 'click outside to keep · esc to discard'));
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
    /* No Apply button: leaving the box keeps the edit, undo takes it back. */
    ta.onblur = function () { if (!cancelled && editing === b.id) apply(); };
    ta.onkeydown = function (e) {
      if (e.key === 'Escape') { cancelled = true; editing = null; render(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); }
    };
    wrap.appendChild(ta); wrap.appendChild(bar);
    setTimeout(function () { ta.focus(); ta.style.height = ta.scrollHeight + 'px'; }, 0);
    return wrap;
  }

  /* Modal dialogs do nothing in a sandboxed artifact frame — always inline. */
  function promptNote(b) {
    var host = document.querySelector('[data-block-id="' + b.id + '"]');
    if (!host || host.querySelector('.la-noteform')) return;
    var form = el('div', 'la-inline la-noteform');
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

  /* -------------------------------------------------------------- reorder */
  function moveTo(id, to) {
    var from = blockIndex(id);
    if (from < 0 || to < 0 || to >= model.blocks.length || to === from) return false;
    model.blocks.splice(to, 0, model.blocks.splice(from, 1)[0]);
    record({ op: 'move', block: id, from: from, to: to });
    return true;
  }
  function move(id, dir) {
    if (moveTo(id, blockIndex(id) + dir)) {
      render();
      var h = document.querySelector('[data-block-id="' + id + '"] .la-handle');
      if (h) h.focus();
    }
  }

  /* Drag the handle. Pointer events rather than HTML5 drag-and-drop — HTML5
     DnD never fires on touch, and this document gets read on an iPad. */
  function startDrag(e, id) {
    if (readOnly || e.button > 0) return;
    e.preventDefault();
    drag = { id: id, to: blockIndex(id) };
    document.body.classList.add('la-dragging');
    var wrap = document.querySelector('[data-block-id="' + id + '"]');
    if (wrap) wrap.classList.add('la-drag-src');
    if (e.target.setPointerCapture && e.pointerId != null) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
    }
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
  }
  function onDragMove(e) {
    if (!drag) return;
    var blocks = [].slice.call(document.querySelectorAll('.la-block')), to = drag.to;
    for (var i = 0; i < blocks.length; i++) {
      var r = blocks[i].getBoundingClientRect();
      if (!r.height) continue;
      if (e.clientY >= r.top && e.clientY <= r.bottom) { to = i; break; }
    }
    if (to !== drag.to) {
      drag.to = to;
      blocks.forEach(function (bl, i) { bl.classList.toggle('la-drop-into', i === to); });
    }
  }
  function endDrag() {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', endDrag);
    document.removeEventListener('pointercancel', endDrag);
    document.body.classList.remove('la-dragging');
    if (!drag) return;
    var d = drag; drag = null;
    if (d.to !== blockIndex(d.id)) moveTo(d.id, d.to);
    render();
  }

  function removeBlock(b) {
    var i = blockIndex(b.id);
    if (i < 0) return;
    model.blocks.splice(i, 1);
    if (editing === b.id) editing = null;
    if (tagging === b.id) { tagging = null; tagQuote = null; }
    /* Deletions are the highest-regret edit: keep the text in the journal so
       Claude reports what left rather than silently losing it. */
    record({ op: 'delete', block: b.id, type: b.type, text: clip(blockSource(b), 1500) });
    render();
  }

  /* --------------------------------------------------- selection -> tagging */
  function offerTag(blockId, quote, targets) {
    return openTagPop(blockId, quote, targets, selAnchor);
  }

  function blockOf(node) {
    var n = node && (node.nodeType === 1 ? node : node.parentNode);
    return n && n.closest ? n.closest('.la-block') : null;
  }
  /* Every block the selection touches, in document order. */
  function spannedBlocks(sel) {
    var a = blockOf(sel.anchorNode), f = blockOf(sel.focusNode);
    if (!a || !f) return [];
    var all = [].slice.call(document.querySelectorAll('.la-block'));
    var i = all.indexOf(a), j = all.indexOf(f);
    if (i < 0 || j < 0) return [];
    return all.slice(Math.min(i, j), Math.max(i, j) + 1)
      .map(function (n) { return n.dataset.blockId; });
  }

  /* A dragged selection lands wherever the pointer did, so real highlights
     arrive mid-word — the first reader's were "ng itself\u2026" and "t witho".
     Nobody means that: grow the quote to whole words before storing it, so the
     mark reads properly on the page and anchors on something meaningful. */
  function snapToWords(text, quote) {
    var i = text.indexOf(quote);
    if (i < 0) return quote;
    var a = i, b = i + quote.length;
    while (a > 0 && /\S/.test(text.charAt(a - 1))) a--;
    while (b < text.length && /\S/.test(text.charAt(b))) b++;
    return text.slice(a, b).trim();
  }

  /* Finishing a highlight creates the highlight straight away and THEN offers a
     tag — the tag is optional, the highlight on its own is already signal. */
  function finishHighlight() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return false;
    var text = String(sel).trim();
    if (text.length < 2) return false;
    var ids = spannedBlocks(sel);
    if (!ids.length) return false;
    try { sel.removeAllRanges(); } catch (e) { /* ignore */ }
    hideSelChip();
    if (ids.length > 1) { offerTag(ids[0], null, ids); return true; }
    var b = getBlock(ids[0]);
    if (!b || blockText(b).indexOf(text) < 0) { offerTag(ids[0], null, null); return true; }
    var quote = snapToWords(blockText(b), text);
    if ((b.marks || []).some(function (m) { return m.quote === quote; })) {
      offerTag(b.id, quote, null);
      return true;
    }
    b.marks = (b.marks || []).concat([{ quote: quote }]);
    record({ op: 'highlight', block: b.id, quote: quote });
    offerTag(b.id, quote, null);
    return true;
  }

  function onSelectionSettled() {
    if (readOnly || editing) return;
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return hideSelChip();
    var text = String(sel).trim();
    if (text.length < 2) return hideSelChip();
    var ids = spannedBlocks(sel);
    if (!ids.length) return hideSelChip();
    showSelChip(ids, text, sel);
  }
  function showSelChip(ids, text, sel) {
    var c = document.getElementById('la-selchip');
    if (!c) {
      c = el('button', 'la-selchip', '+ tag');
      c.id = 'la-selchip';
      document.body.appendChild(c);
    }
    c.textContent = ids.length > 1 ? '+ tag ' + ids.length + ' blocks' : '+ tag';
    c.title = 'Tag the highlighted text';
    c.hidden = false;
    c.onclick = function () { hideSelChip(); finishHighlight(); };
    /* to the right of where the selection ends, not above the block */
    try {
      var rects = sel.getRangeAt(0).getClientRects();
      var last = rects[rects.length - 1];
      if (last && last.width) {
        c.style.top = (last.top + window.scrollY + last.height / 2 - 13) + 'px';
        c.style.left = (last.right + window.scrollX + 8) + 'px';
        selAnchor = { top: last.top + window.scrollY, left: last.right + window.scrollX + 8 };
      }
    } catch (e) { /* no geometry — the chip still works, just parked */ }
  }
  function hideSelChip() {
    var c = document.getElementById('la-selchip');
    if (c) c.hidden = true;
  }

  /* ---------------------------------------------------------------- filter */
  /* Ticking labels hides everything else on the page. This is a VIEW: nothing
     here reaches the model or the journal. The export below is how a filtered
     view becomes something you can hand to someone. */
  function closeFilterMenu() {
    var n = document.getElementById('la-filtermenu');
    if (n) n.remove();
  }
  /* The menu hangs off the Filter button rather than sitting at the screen
     edge: right-aligned to it, directly above it, clamped into the viewport. */
  function placeFilterMenu(menu) {
    var r = filterAnchor && filterAnchor.getBoundingClientRect
      ? filterAnchor.getBoundingClientRect() : null;
    if (!r || !r.width) return;
    var left = Math.max(12, Math.min(r.right - FILTER_W, window.innerWidth - FILTER_W - 12));
    menu.style.left = left + 'px';
    menu.style.right = 'auto';
    menu.style.bottom = Math.max(12, window.innerHeight - r.top + 8) + 'px';
  }
  function toggleFilterMenu(anchor) {
    if (anchor) filterAnchor = anchor;
    if (document.getElementById('la-filtermenu')) return closeFilterMenu();
    var counts = allTags(), names = Object.keys(counts).sort();
    var menu = el('div', 'la-filtermenu');
    menu.id = 'la-filtermenu';
    menu.appendChild(el('div', 'la-tagmenu-label', 'show only blocks labelled'));
    if (!names.length) {
      menu.appendChild(el('div', 'la-filter-count', 'No tags on this document yet.'));
    }
    names.forEach(function (t) {
      var row = el('label', 'la-filterrow');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = filter.indexOf(t) !== -1;
      cb.onchange = function () {
        filter = cb.checked ? filter.concat([t]) : filter.filter(function (x) { return x !== t; });
        render();
        var open = document.getElementById('la-filtermenu');
        if (open) { closeFilterMenu(); toggleFilterMenu(); }  /* keeps the anchor */
      };
      row.appendChild(cb);
      row.appendChild(paint(el('span', 'la-tag', '#' + t), t));
      row.appendChild(el('span', 'la-filter-count', String(counts[t])));
      menu.appendChild(row);
    });
    var foot = el('div', 'la-tagpop-foot');
    if (filter.length) {
      var shown = model.blocks.filter(matchesFilter).length;
      foot.appendChild(el('span', 'la-filter-count',
        shown + ' of ' + model.blocks.length + ' blocks'));
      var clear = el('button', 'la-btn', 'show all');
      clear.onclick = function () { filter = []; closeFilterMenu(); render(); };
      foot.appendChild(clear);
      var exp = el('button', 'la-btn primary', 'Build this version');
      exp.title = 'Rebuild the document with only these labels, as a plain shareable copy';
      exp.onclick = function () { buildFilteredVersion(); };
      foot.appendChild(exp);
    }
    menu.appendChild(foot);
    document.body.appendChild(menu);
    placeFilterMenu(menu);
  }

  /* ---------------------------------------------------------------- export */
  /* A plain document, not a tool: no editor, no model, no db — which is also
     what makes it shareable at all, since a db artifact is org-internal. */
  function buildStatic(blocks, labels) {
    var css = document.getElementById(STYLE_EL).textContent;
    var host = el('div');
    blocks.forEach(function (b) { host.appendChild(renderBody(b)); });
    var note = labels.length
      ? '<p class="la-updated">Labelled ' + labels.map(function (l) { return '#' + esc(l); }).join(', ')
        + ' \u00B7 ' + blocks.length + ' of ' + model.blocks.length + ' sections</p>'
      : '';
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<title>' + esc(model.title) + '</title>\n'
      + '<style>\n' + css + '\n</style>\n</head>\n<body>\n'
      + '<div class="la-shell"><header class="la-head"><h1 class="la-title">'
      + esc(model.title) + '</h1>' + note + '</header><div class="la-blocks">'
      + host.innerHTML + '</div></div>\n</body>\n</html>\n';
  }

  async function buildFilteredVersion() {
    var blocks = model.blocks.filter(matchesFilter);
    var labels = filter.slice();
    var html = buildStatic(blocks, labels);
    var name = (model.docId + '-' + labels.join('-') + '.html').replace(/[^A-Za-z0-9._-]/g, '-');
    closeFilterMenu();

    /* record it so Claude can publish it as its own artifact on request */
    if (caps.db) {
      try {
        await caps.db.doc('docs/' + model.docId + '/exports/' + Date.now()).set({
          at: nowIso(), labels: labels, title: model.title,
          blockIds: blocks.map(function (b) { return b.id; }), filename: name
        });
      } catch (e) { /* the download below is still worth offering */ }
    }
    var dl = null;
    try { dl = await claude.use('downloads'); } catch (e) { /* not granted */ }
    if (dl) {
      try {
        await dl.save({ filename: name, data: html });
        return status('Built ' + blocks.length + ' sections. Ask Claude to publish it as its own link.');
      } catch (e) {
        if (e && e.code === 'cancelled') return status('Export cancelled.');
      }
    }
    status('Export recorded (' + blocks.length + ' sections) — ask Claude to publish it.');
  }

  function renderAddRow() {
    var bar = el('div', 'la-editbar la-addrow');
    bar.appendChild(el('span', null, 'add:'));
    ['para', 'heading', 'list', 'callout', 'code', 'table', 'divider'].forEach(function (t) {
      var x = el('button', 'la-btn', t);
      x.onclick = function () {
        var b = { id: uid('b'), type: t, author: 'viewer', tags: [] };
        if (t === 'heading') { b.text = 'New heading'; b.level = 2; }
        else if (t === 'list') b.items = ['New item'];
        else if (t === 'table') { b.head = ['Column']; b.rows = [['value']]; }
        else if (t === 'callout') { b.title = 'Note'; b.text = 'New callout'; }
        else if (t !== 'divider') b.text = 'New ' + t;
        var at = model.blocks.length;
        model.blocks.push(b);
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
      : (pending.length
        ? pending.length + ' change' + (pending.length > 1 ? 's' : '') + ' — saving shortly…'
        : filter.length
          ? 'Filtered to ' + filter.map(function (t) { return '#' + t; }).join(' ')
            + ' — ' + model.blocks.filter(matchesFilter).length + ' of '
            + model.blocks.length + ' blocks · this is a view, the document is unchanged'
          : 'Saved · rev ' + model.rev
            + ' · click a block to edit, drag the handle to reorder, select text to tag it');
    /* "Save now" sits at the LEFT end, before the flexible status, so it has a
       fixed home and its appearing does not shift the other controls. */
    if (!readOnly && pending.length) {
      var save = el('button', 'la-btn primary', 'Save now');
      save.title = 'Publish this round immediately (cmd+s)';
      save.onclick = function () { doSave(); };
      bar.appendChild(save);
    }
    bar.appendChild(st);
    if (!readOnly) {
      var u = el('button', 'la-btn', '↶ Undo');
      u.title = 'Undo (cmd+z)';
      u.disabled = !undoStack.length;
      u.onclick = undo;
      var r = el('button', 'la-btn', '↷ Redo');
      r.title = 'Redo (shift+cmd+z)';
      r.disabled = !redoStack.length;
      r.onclick = redo;
      var counts = allTags(), nTags = Object.keys(counts).length;
      var f = el('button', 'la-btn' + (filter.length ? ' on' : ''),
        filter.length ? 'Filter · ' + filter.length : 'Filter');
      f.title = 'Show only blocks with the labels you tick';
      f.disabled = !nTags;
      f.onclick = function (e) { e.stopPropagation(); toggleFilterMenu(f); };
      bar.appendChild(u); bar.appendChild(r); bar.appendChild(f);
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
      (b.marks || []).forEach(function (m) { out[m.tag] = (out[m.tag] || 0) + 1; });
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
  function scheduleSave() {
    if (readOnly || !pending.length) return;
    clearTimeout(saveTimer);
    /* One version per call, so never per keystroke — settle first. */
    saveTimer = setTimeout(function () { doSave(); }, SAVE_DEBOUNCE);
  }

  /* The FILES form publishes index.html without reloading this view, which is
     what makes autosave usable at all; the html form reloads every view and is
     the fallback where the files form is not served. The model stays embedded
     in the page either way, so reading the document back is unaffected. */
  async function publishDoc(html) {
    if (filesForm !== false) {
      try {
        await caps.artifact.publish({ 'index.html': html });
        filesForm = true;
        return { reloaded: false };
      } catch (e) {
        var code = e && e.code;
        if (code === 'capability_disabled' || code === 'capability_removed'
          || code === 'read_only_path') {
          filesForm = false;
        } else {
          throw e;
        }
      }
    }
    await caps.artifact.publish(html);
    return { reloaded: true };
  }

  var saving = false;
  async function doSave() {
    clearTimeout(saveTimer);
    if (!pending.length || readOnly) return;
    if (saving) { saveTimer = setTimeout(function () { doSave(); }, 400); return; }
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
      var res = await publishDoc(html);
      saving = false;
      if (!res.reloaded) {
        /* The files form leaves this view running: clear the round by hand. */
        pending = [];
        try { sessionStorage.removeItem('la-stash:' + model.docId); } catch (e2) {}
        render();
        status('Saved · rev ' + model.rev);
        return;
      }
      /* The html form reloads to the new version; nothing after this runs. */
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
      if (code === 'rate_limited') {
        SAVE_DEBOUNCE = Math.min(SAVE_DEBOUNCE * 2, 20000);
        saveTimer = setTimeout(function () { doSave(); }, SAVE_DEBOUNCE);
        return status('Saving too often — slowing down, your changes are still here.', true);
      }
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
    baseline = clone(model);
    render();
    checkStash();

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') { hideSelChip(); closeTagPop(); closeFilterMenu(); }
      /* inside a textarea or input, cmd+z is the browser's, not ours */
      var t = e.target && e.target.tagName;
      if (t === 'TEXTAREA' || t === 'INPUT') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    });
    /* Selecting text already works without a mode: the block's click handler
       bails when the click ended a selection. The v1.3 highlighter button was
       redundant and is gone. */
    document.addEventListener('mouseup', function () { setTimeout(onSelectionSettled, 0); });
    document.addEventListener('pointerdown', function (e) {
      if (!e.target.closest) return;
      if (!e.target.closest('#la-tagpop') && !e.target.closest('#la-selchip')
        && !e.target.closest('.la-act')) { closeTagPop(); }
      if (!e.target.closest('#la-filtermenu') && !e.target.closest('.la-bar')) closeFilterMenu();
    }, true);
    document.addEventListener('keyup', function (e) {
      if (e.shiftKey || /^Arrow/.test(e.key)) setTimeout(onSelectionSettled, 0);
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

  /* Exposed for the headless preflight: geometry-driven drag and native text
     selection cannot be exercised in jsdom, so the same code paths are
     reachable directly. Not part of the document's own behaviour. */
  window.__la = {
    offerTag: function (id, q, targets) { return offerTag(id, q, targets); },
    moveTo: function (id, to) { var r = moveTo(id, to); render(); return r; },
    undo: undo, redo: redo,
    snapToWords: snapToWords,
    finishHighlight: finishHighlight,
    setFilter: function (t) { filter = t; render(); },
    filterMenu: toggleFilterMenu,
    buildStatic: function () { return buildStatic(model.blocks.filter(matchesFilter), filter.slice()); },
    exportNow: buildFilteredVersion,
    tags: allTags,
    flush: function () { return doSave(); },
    debounce: function (ms) { SAVE_DEBOUNCE = ms; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
