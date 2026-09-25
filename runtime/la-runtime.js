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
  /* Two ways of looking at one model. `edit` is the block list with its chrome;
     `read` is the published look, tabs and cards, with no working state on it.
     A reader without write rights only ever gets `read`. A writer starts where
     they left off and switches with one click, so the published look is never
     more than a click away from the thing being edited. */
  var mode = 'read';   /* read | page | preview | outline, see renderRead */
  /* Where the model came from. `file` means a separate model.js next to a
     shared runtime, and a save then rewrites only that file; `inline` is the
     older single-file document, saved whole. */
  var modelSource = 'inline';
  var WIDTHS = ['full', 'half', 'third', 'two-thirds'];
  var WIDTH_LABEL = { full: '1', half: '½', third: '⅓', 'two-thirds': '⅔' };
  var VARIANTS = {
    callout: ['note', 'warning', 'decision', 'design', 'excluded', 'deferred'],
    table: ['plain', 'striped'],
    list: ['bullets', 'checks']
  };
  /* Sticky per session, not per document: a reader who prefers pasting a table
     as text keeps getting the textarea until they ask for the grid back. */
  var editAsText = false;
  /* Folding is a VIEW, like the filter: it never reaches the model or the
     journal. Every section starts closed so the first thing a reader meets is
     the shape of the document rather than its first paragraph. */
  var collapsed = {};
  var statusTimer = null, drag = null;
  var fresh = null;          /* { id, src }: a block just added, still untouched */
  var resize = null, placing = null;
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
  /* ------------------------------------------------------------- citations */
  /* A figure in the text carries how it was obtained. Written `[949
     identities](=m-base)`, where the id names an entry in `model.methods`.
     Marked in place so the reader can see at a glance which numbers are
     sourced, and opened on click, because the method is three lines of
     mechanics nobody wants sitting in the sentence.
     A missing id renders as plain text rather than as a dead marker: an
     unresolved citation should read as an ordinary number, not as a bug. */
  function methodOf(id) {
    return (model && model.methods && model.methods[id]) || null;
  }
  function citeHtml(label, id) {
    var mm = methodOf(id);
    if (!mm) return label;
    /* Inline elements only. A citation sits inside a paragraph, and the parser
       closes that paragraph the moment it meets a dl or an ol, which tears the
       sentence in half and spills the panel into the page. */
    var rows = '';
    function row(k, v) {
      if (!v) return;
      rows += '<span class="la-cite-k">' + esc(k) + '</span>'
        + '<span class="la-cite-v">' + esc(v) + '</span>';
    }
    row('Source', mm.source);
    if (mm.steps && mm.steps.length) {
      rows += '<span class="la-cite-k">Steps</span><span class="la-cite-v">'
        + mm.steps.map(function (s, i) {
            return '<span class="la-cite-step"><i>' + (i + 1) + '</i>' + esc(s) + '</span>';
          }).join('')
        + '</span>';
    }
    row('Fields', mm.fields);
    row('Excluded', mm.excluded);
    row('Measured', mm.date);
    row('Confidence', mm.confidence);
    return '<span class="la-cite-wrap">'
      /* a span, not a button: a button is a box and cannot wrap across lines
         with the sentence it sits in, so a long figure centred itself in its
         own block. role and tabindex keep it a control. */
      + '<span class="la-cite" role="button" tabindex="0" aria-expanded="false" data-m="' + esc(id) + '">'
      + label + '</span>'
      + '<span class="la-cite-pop" hidden>'
      + '<span class="la-cite-h">' + esc(mm.title || 'How this was obtained') + '</span>'
      + '<span class="la-cite-g">' + rows + '</span></span></span>';
  }

  /* Deliberately tiny inline subset. The model stores plain text with these
     markers, so an edit never yields contenteditable HTML soup. */
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      /* before the link rule, so `(=id)` is never read as a URL */
      .replace(/\[([^\]]+)\]\(=([A-Za-z0-9_.-]+)\)/g, function (_, label, id) {
        return citeHtml(label, id);
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  }
  /* Range tags are anchored by QUOTE, not by character offset — an offset
     breaks the moment anything above it is edited. Sentinels go in before
     escaping so they survive it, then become real elements after. */
  function withMarks(text, marks, changes) {
    var all = (marks || []).slice();
    (changes || []).forEach(function (q) { if (q) all.push({ quote: q, chg: true }); });
    if (!all.length) return inline(text);
    var t = String(text == null ? '' : text), hit = false;
    all.forEach(function (m, idx) {
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
        var m = all[Number(n)];
        if (m && m.chg) return '<mark class="la-chg' + (chgOwner === 'viewer' ? ' mine' : '') + '">';
        /* a passage with a note on it says so where it stands, and says whether
           the note has been acted on */
        var noted = m && m.note ? ' has-note' + (m.noteDone ? ' done' : '') : '';
        var title = m && m.note ? ' title="' + esc(m.note + (m.noteDone ? ' \u2192 ' + m.noteDone : '')) + '"' : '';
        return m && m.tag
          ? '<mark class="la-mark' + noted + '" style="--tag-h:' + tagHue(m.tag) + '"' + title + '>'
          : '<mark class="la-mark untagged' + noted + '"' + title + '>';
      })
      .split(EOT).join('</mark>');
  }

  /* What CLAUDE changed in the last round, at word level. `touched.by` is
     already how the model records who moved a block; when it is claude, its
     `spans` are the exact words to mark, and no spans means the whole block
     was written or rewritten. Purple either way — the document's one colour
     for "this is not what you last read". A reader's own marks are replaced
     rather than stacked: seeing their highlight give way to Claude's is how
     they know the note was acted on. */
  var chgOwner = null;   /* who owns the change spans being rendered: claude | viewer */
  function changeSpans(b) {
    var t = b.touched;
    chgOwner = t ? t.by : null;
    if (!t) return null;
    return (t.spans && t.spans.length) ? t.spans : null;
  }
  /* The runs of words in `b` that are not in `a`, verbatim, so the runtime
     can find them again with indexOf. The same LCS as mark-changes.mjs, so
     the reader's amber is as granular as Claude's purple. */
  function wordRuns(a, b) {
    var A = String(a == null ? '' : a).match(/\S+\s*/g) || [], B = String(b == null ? '' : b).match(/\S+\s*/g) || [];
    if (!B.length) return [];
    if (!A.length) return [B.join('').trim()];
    var n = A.length, m = B.length, i, j;
    if (n * m > 250000) return [];   /* a very long block: gutter only */
    var L = [];
    for (i = 0; i <= n; i++) L.push(new Uint16Array(m + 1));
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) {
      L[i][j] = A[i].trim() === B[j].trim() ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    var runs = [], cur = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (A[i].trim() === B[j].trim()) { if (cur.length) { runs.push(cur); cur = []; } i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else { cur.push(B[j]); j++; }
    }
    while (j < m) cur.push(B[j++]);
    if (cur.length) runs.push(cur);
    var out = [];
    runs.forEach(function (r) { var q = r.join('').trim(); if (q.length >= 3 || /\d/.test(q)) out.push(q); });
    return out;
  }
  function viewerSpans(b, before, after, wasTable) {
    if (b.type === 'table' && wasTable) {
      var spans = [];
      (b.head || []).forEach(function (h, ci) {
        wordRuns((wasTable.head || [])[ci], h).forEach(function (q) { spans.push({ cell: 'h' + ci, quote: q }); });
      });
      (b.rows || []).forEach(function (r, ri) {
        r.forEach(function (c, ci) {
          var old = (wasTable.rows[ri] || [])[ci];
          wordRuns(old, c).forEach(function (q) { spans.push({ cell: 'r' + ri + 'c' + ci, quote: q }); });
        });
      });
      return spans;
    }
    return wordRuns(before, after);
  }
  function changedWhole(b) {
    var t = b.touched;
    return !!(t && t.by === 'claude' && !(t.spans && t.spans.length));
  }
  /* ------------------------------------------------------------- role chips */
  /* An owner column reads better as a role than as a person: a name goes stale
     the moment someone changes job, and a reader scanning for "who has to
     answer this" wants the function, not the individual. So a table cell that
     is NOTHING but role names becomes coloured chips, one fixed hue per role
     across every document, which is what makes a column scannable.
     Strictly whole-cell: a sentence that happens to mention Design stays a
     sentence. The only thing allowed in front is one short status word
     ("Not yet.", "Agreed."), because that is how an Agreed-with column reads. */
  var ROLES = ['PM', 'Dev', 'IT', 'Sec', 'Legal', 'Sales', 'CS', 'Design', 'Customer'];
  var ROLE_H = {
    PM: 260, Dev: 214, IT: 188, Sec: 334, Legal: 28,
    Sales: 96, CS: 150, Design: 300, Customer: 8
  };
  var ROLE_SPLIT = /\s*(?:,|\/|&|\+|·|\band\b|\bwith\b|\bthen\b)\s*/;
  function roleCell(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return null;
    var lead = '';
    var m = s.match(/^([A-Z][a-z]+(?:\s[a-z]+)?)\.\s+(\S[\s\S]*)$/);
    if (m && ROLES.indexOf(m[1]) === -1) { lead = m[1] + '.'; s = m[2]; }
    s = s.replace(/\.\s*$/, '').trim();
    if (!s) return null;
    var parts = s.split(ROLE_SPLIT).filter(Boolean);
    if (!parts.length || parts.length > 6) return null;
    for (var i = 0; i < parts.length; i++) {
      if (ROLES.indexOf(parts[i]) === -1) return null;
    }
    return { lead: lead, roles: parts };
  }
  function roleHtml(rc) {
    return (rc.lead ? '<span class="la-rolelead">' + esc(rc.lead) + '</span>' : '')
      + rc.roles.map(function (r) {
        return '<span class="la-tag la-role" style="--tag-h:' + ROLE_H[r] + '">'
          + esc(r) + '</span>';
      }).join('');
  }
  /* Only a column that ASKS who owns something gets chips. A "Who" column in a
     flow table names the actor in a step, and a "Who" column in a permissions
     table is a sentence; painting either would say something the table does
     not mean. The header decides, not the cell. */
  var OWNER_COL = /^(owners?|agreed with|answered by|raised by|decided by|accountable|responsible)$/i;
  function roleColumns(head) {
    var out = {};
    (head || []).forEach(function (h, i) {
      if (OWNER_COL.test(String(h == null ? '' : h).trim())) out[i] = true;
    });
    return out;
  }
  /* A span may be written as a plain quote, which applies wherever it is found,
     or as {cell, quote}, which applies to one cell of one table. Two rows of a
     table often end up saying the same short thing, and marking all of them
     when one was rewritten tells the reader the wrong story. */
  function spansFor(chg, key) {
    if (!chg) return null;
    var out = [];
    chg.forEach(function (q) {
      if (typeof q === 'string') out.push(q);
      else if (q && q.quote && q.cell === key) out.push(q.quote);
    });
    return out.length ? out : null;
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
    /* A shared-runtime document ships its model as model.js, which sets this
       global before the runtime runs. The inline script element is the older
       single-file form and still works. */
    if (window.__laModel && Array.isArray(window.__laModel.blocks)) {
      modelSource = 'file';
      return clone(window.__laModel);
    }
    try { return JSON.parse(document.getElementById(MODEL_EL).textContent); }
    catch (e) { return null; }
  }
  function modelJs() {
    return 'window.__laModel = ' + JSON.stringify(model, null, 1) + ';\n';
  }
  function modeKey() { return 'la-mode:' + (model && model.docId); }
  function setMode(m) {
    mode = m;
    try { localStorage.setItem(modeKey(), m); } catch (e) { /* private mode */ }
    /* the reader stays where they were, so the effect of the switch is the
       thing on screen, not the top of the document */
    render();
  }
  function blockIndex(id) {
    for (var i = 0; i < model.blocks.length; i++) if (model.blocks[i].id === id) return i;
    return -1;
  }
  function getBlock(id) { var i = blockIndex(id); return i < 0 ? null : model.blocks[i]; }
  function blockText(b) {
    if (b.type === 'list') return (b.items || []).join('\n');
    /* A raw block has no text to speak of, so it names itself for the drag
       handle's label instead of offering a wall of markup to a screen reader. */
    if (b.type === 'raw') return b.label || 'embedded markup';
    if (b.type === 'heading' && b.eyebrow) return b.eyebrow + ': ' + (b.text || '');
    if (b.type === 'figure') return b.caption || b.alt || 'figure';
    if (b.type === 'mermaid') return 'diagram';
    return b.text || '';
  }

  /* One reversible pair per type keeps editing plain-text and the model
     structured — the textarea shows exactly what the model holds. */
  function blockSource(b) {
    switch (b.type) {
      case 'list': return (b.items || []).join('\n');
      case 'table': return [(b.head || []).join('\t')]
        .concat((b.rows || []).map(function (r) { return r.join('\t'); })).join('\n');
      case 'callout': return (b.title ? b.title + '\n\n' : '') + (b.text || '');
      /* A heading's second paragraph is what the section is FOR — the ⓘ text.
         Same shape as a callout, so there is one thing to learn, not two. */
      /* Two lines at most: the label, then the heading. `info` is deliberately
         absent. It is the template's own description of the section, fetched
         rather than written, and putting it in the box invites edits to text
         that is not this document's to change. It renders behind the ⓘ and
         survives every edit. */
      case 'heading':
        return (b.eyebrow ? b.eyebrow + '\n' : '') + (b.text || '');
      /* A figure's PICTURE is not editable — only the words baked into it.
         So its source form is those words, one per line, and changing one is
         an instruction to Claude to redraw, not a change to the image. */
      case 'figure':
        var out = ['caption: ' + (b.caption || ''), 'alt: ' + (b.alt || '')];
        Object.keys(b.labels || {}).forEach(function (k) {
          out.push(k + ': ' + b.labels[k]);
        });
        return out.join('\n');
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
      case 'heading':
        /* `badge` and `info` are provenance, not content. Neither is in the box,
           so neither can be lost by an edit to the title or the label. */
        var head = src.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        if (head.length > 1) { b.eyebrow = head.shift(); b.text = head.join(' '); }
        else { delete b.eyebrow; b.text = head[0] || ''; }
        break;
      case 'figure':
        var labels = {};
        src.split('\n').forEach(function (line) {
          var m = line.match(/^\s*([^:]+?)\s*:\s*([\s\S]*)$/);
          if (!m) return;
          var k = m[1].trim(), v = m[2].trim();
          if (k === 'caption') b.caption = v;
          else if (k === 'alt') b.alt = v;
          else if (k) labels[k] = v;
        });
        b.labels = labels;
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

  /* ------------------------------------------------------------- sections */
  /* The model stays flat: a heading owns every block after it until the next
     heading of the same or higher level. Nesting the DOM instead would break
     drag-to-reorder, which walks one flat list of blocks. */
  function headingLevel(b) {
    /* Levels 2 to 4. Anything else reads as 2, so an old model still folds. */
    if (b.type !== 'heading') return 0;
    var l = Number(b.level) || 2;
    return l < 2 ? 2 : l > 4 ? 4 : l;
  }
  /* For each index: the chain of heading ids above it, outermost first. */
  function foldChains() {
    var chain = [], out = [];
    model.blocks.forEach(function (b) {
      var lvl = headingLevel(b);
      if (lvl) {
        while (chain.length && chain[chain.length - 1].level >= lvl) chain.pop();
        out.push(chain.slice());           /* a heading is hidden by its PARENTS */
        chain.push({ id: b.id, level: lvl });
      } else {
        out.push(chain.slice());
      }
    });
    return out;
  }
  function foldHidden(chains, i) {
    return chains[i].some(function (h) { return collapsed[h.id]; });
  }
  /* What a closed section is holding, so nothing important hides silently. */
  function sectionStats(i) {
    var lvl = headingLevel(model.blocks[i]), n = 0, tagged = 0, notes = 0, touched = 0;
    for (var j = i + 1; j < model.blocks.length; j++) {
      var b = model.blocks[j], l = headingLevel(b);
      if (l && l <= lvl) break;
      if (l) continue;                      /* sub-headings are counted as sections */
      n++;
      if ((b.tags && b.tags.length) || (b.marks && b.marks.length)) tagged++;
      if (b.note) notes++;
      if (b.touched) touched++;
    }
    return { blocks: n, tagged: tagged, notes: notes, touched: touched };
  }
  /* A section with no blocks of its own — the reader decides whether to fill it. */
  function sectionEmpty(i) {
    var lvl = headingLevel(model.blocks[i]);
    for (var j = i + 1; j < model.blocks.length; j++) {
      var l = headingLevel(model.blocks[j]);
      if (l && l <= lvl) return true;
      if (!l) return false;
    }
    return true;
  }
  function eachHeading(fn) {
    model.blocks.forEach(function (b) { if (headingLevel(b)) fn(b); });
  }
  function setAllFolded(v) {
    collapsed = {};
    if (v) eachHeading(function (b) { collapsed[b.id] = true; });
  }
  /* Does this heading contain other headings? A section that only holds
     sub-sections has nothing of its own to hide. */
  function hasSubheadings(i) {
    var lvl = headingLevel(model.blocks[i]);
    for (var j = i + 1; j < model.blocks.length; j++) {
      var l = headingLevel(model.blocks[j]);
      if (l && l <= lvl) return false;
      if (l) return true;
    }
    return false;
  }
  /* The opening view: every section NAME visible, no section CONTENT. Folding
     the container sections too would open the document on four words, which is
     a table of contents for a table of contents. Shift-click on "Collapse ▾"
     still gets there in one click for anyone who wants it. */
  function setOutlineFolded() {
    collapsed = {};
    model.blocks.forEach(function (b, i) {
      if (headingLevel(b) && !hasSubheadings(i)) collapsed[b.id] = true;
    });
  }

  /* ---------------------------------------------------------------- render */
  /* A grid or figure editor listens outside itself for the click that ends
     it. render() rebuilds the DOM under that listener, so it is dropped here
     rather than left pointing at nodes that no longer exist. */
  var editorCleanup = null;
  function dropEditorHooks() {
    if (!editorCleanup) return;
    var c = editorCleanup; editorCleanup = null; c();
  }

  function render() {
    dropEditorHooks();
    var root = document.getElementById('la-root');
    if (readOnly || mode !== 'outline') { renderRead(root); return; }
    var scroll = window.scrollY;
    root.textContent = '';
    root.appendChild(renderHead());
    var wrap = el('div', 'la-blocks');
    var chains = foldChains();
    model.blocks.forEach(function (b, i) {
      var node = renderBlock(b, i);
      node.dataset.depth = Math.min(chains[i].length, 3);
      /* Filtering and folding are both VIEWS, never edits — nothing here
         reaches the model. A filter wins over a fold: a block that matches
         must be reachable without hunting for the section holding it. */
      if (!matchesFilter(b)) node.hidden = true;
      else if (!filter.length && foldHidden(chains, i)) node.hidden = true;
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

  /* `forStatic` renders for the export rather than for the page: a mermaid
     block becomes the <pre class="mermaid"> the artifact viewer draws itself,
     because the export carries no runtime to draw it with. */
  function renderBody(b, forStatic) {
    var body = el('div', 'la-body'), marks = b.marks || [];
    /* Never in the shared copy: a change mark and a pinned note are both
       working state, and the copy that leaves the building is the document. */
    var chg = forStatic ? null : changeSpans(b);
    switch (b.type) {
      case 'heading':
        /* The export has no heading row, so the label rides with the heading. */
        if (forStatic && b.eyebrow) body.appendChild(el('span', 'la-eyebrow-sec', b.eyebrow));
        var h = el(headingLevel(b) === 4 ? 'h4' : headingLevel(b) === 3 ? 'h3' : 'h2');
        h.id = b.id; h.innerHTML = withMarks(b.text || '', marks, chg);
        body.appendChild(h); break;
      case 'list':
        var list = el(b.ordered ? 'ol' : 'ul');
        (b.items || []).forEach(function (it) {
          var li = el('li'); li.innerHTML = withMarks(it, marks, chg); list.appendChild(li);
        });
        body.appendChild(list); break;
      case 'table':
        var w = el('div', 'la-tablewrap'), t = el('table'),
          thead = el('thead'), tr = el('tr'), rcols = roleColumns(b.head);
        (b.head || []).forEach(function (c, ci) {
          var th = el('th');
          var hs = el('span'); hs.innerHTML = inline(c); th.appendChild(hs);
          cellNoteUi(th, b, 'h' + ci, forStatic);
          tr.appendChild(th);
        });
        thead.appendChild(tr); t.appendChild(thead);
        var tb = el('tbody');
        (b.rows || []).forEach(function (r, ri) {
          var row = el('tr');
          r.forEach(function (c, ci) {
            var td = el('td');
            var key = 'r' + ri + 'c' + ci;
            var cellChg = spansFor(chg, key);
            var cs = el('span'), rc = rcols[ci] ? roleCell(c) : null;
            if (rc) {
              /* A two-word cell has nothing to mark a single word inside, so a
                 rewritten owner cell is marked whole. */
              var hit = cellChg && cellChg.some(function (q) { return c.indexOf(q) !== -1; });
              cs.innerHTML = hit ? '<mark class="la-chg">' + roleHtml(rc) + '</mark>' : roleHtml(rc);
            } else {
              cs.innerHTML = withMarks(c, marks, cellChg);
            }
            td.appendChild(cs);
            cellNoteUi(td, b, key, forStatic);
            row.appendChild(td);
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
        var cp = el('p'); cp.innerHTML = withMarks(b.text || '', marks, chg); cp.style.margin = '0';
        c.appendChild(cp); body.appendChild(c); break;
      case 'raw':
        /* The one block type whose content the runtime does not own: finished
           markup, dropped in as written. It carries an artefact that IS markup
           — email table layout, a rendered mock — which no plain-text block can
           hold without becoming a description of it instead.
           Claude-authored only. There is no textarea and it is absent from the
           add row, because parsing arbitrary markup back into the model is not
           something this runtime does. Marks do not apply inside it for the
           same reason. The reader still tags, notes, moves and deletes it. */
        var raw = el('div', 'la-raw');
        raw.innerHTML = b.html || '';
        body.appendChild(raw); break;
      case 'mermaid':
        /* The diagram is the view; the text behind it is the truth. Clicking
           opens that text, exactly like every other block — which is why the
           model never stores the drawn SVG, only the source it came from. */
        var mh = el('div', 'la-mermaid');
        if (forStatic) {
          /* The export carries no runtime, so the source goes out as a pre and
             the export's own script draws it where the viewer does not. */
          mh.appendChild(el('pre', 'mermaid', b.text || ''));
        } else {
          var hit = svgCache[b.id];
          if (hit && hit.code === (b.text || '')) mh.innerHTML = hit.svg;
          else { mh.appendChild(el('pre', 'la-mermaid-src', b.text || '')); drawMermaid(mh, b); }
        }
        body.appendChild(mh); break;
      case 'figure':
        /* Claude draws it, the reader corrects the words in it. The picture is
           never editable here: a changed label is a redraw request, recorded
           like any other edit so the next round can act on it. */
        var fig = el('figure', 'la-figure');
        if (b.svg) {
          /* Inline rather than an <img>: a chart drawn this way inherits the
             page's font and `currentColor`, so it follows the document's theme
             instead of being a picture of one. Claude-authored only, same rule
             as `raw`. */
          var sv = el('div', 'la-figure-svg');
          sv.innerHTML = b.svg;
          sv.setAttribute('role', 'img');
          if (b.alt) sv.setAttribute('aria-label', b.alt);
          fig.appendChild(sv);
        } else if (b.src) {
          var img = el('img');
          img.src = b.src; img.alt = b.alt || b.caption || '';
          fig.appendChild(img);
        } else {
          fig.appendChild(el('div', 'la-figure-missing', 'No image on this figure yet.'));
        }
        if (b.caption) {
          var fc = el('figcaption'); fc.innerHTML = withMarks(b.caption, marks, chg);
          fig.appendChild(fc);
        }
        body.appendChild(fig); break;
      case 'divider':
        body.appendChild(el('hr', 'la-divider')); break;
      default:
        var p = el('p'); p.innerHTML = withMarks(b.text || '', marks, chg); body.appendChild(p);
    }
    return body;
  }

  /* ------------------------------------------------------- notes on a cell */
  /* A block note says "this table is wrong". On a six-column table that is not
     enough to act on, so a note can be pinned to ONE cell and is rendered
     inside it: the link between the request and its subject is visible rather
     than described. Anchored by position (`h2`, `r3c1`), which is why the grid
     editor moves them when a row or a column goes. */
  function cellNoteUi(host, b, key, forStatic) {
    if (forStatic) return;
    var note = (b.cellNotes || {})[key], done = (b.cellNotesDone || {})[key];
    if (note) {
      var n = el('div', 'la-cellnote' + (done ? ' done' : ''));
      n.appendChild(el('b', null, done ? 'note handled' : 'note'));
      n.appendChild(document.createTextNode(note));
      if (done) n.appendChild(el('div', 'la-cellnote-a', done));
      n.onclick = function (e) { e.stopPropagation(); };
      host.appendChild(n);
    }
    if (readOnly) return;
    var pin = el('button', 'la-cellpin', note ? '\u270E' : '+');
    pin.title = note ? 'Edit the note on this cell' : 'Pin a note to Claude on this cell';
    pin.setAttribute('aria-label', pin.title);
    pin.onmousedown = function (e) { e.stopPropagation(); };
    pin.onclick = function (e) { e.stopPropagation(); cellNoteForm(host, b, key); };
    host.appendChild(pin);
  }

  function cellNoteForm(host, b, key) {
    if (host.querySelector('.la-cellnoteform')) return;
    var form = el('div', 'la-inline la-cellnoteform');
    var inp = el('input');
    inp.value = (b.cellNotes || {})[key] || '';
    inp.placeholder = 'what should Claude do with this cell?';
    inp.setAttribute('aria-label', 'Note to Claude on this cell');
    var ok = el('button', 'la-btn primary', 'Save note');
    function commit() {
      var v = inp.value.trim();
      b.cellNotes = b.cellNotes || {};
      if (v) b.cellNotes[key] = v; else delete b.cellNotes[key];
      if (b.cellNotesDone) delete b.cellNotesDone[key];
      record({ op: 'note', block: b.id, cell: key, text: v });
      render();
    }
    ok.onclick = function (e) { e.stopPropagation(); commit(); };
    inp.onkeydown = function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { form.remove(); }
    };
    form.onclick = function (e) { e.stopPropagation(); };
    form.onmousedown = function (e) { e.stopPropagation(); };
    form.appendChild(inp); form.appendChild(ok);
    host.appendChild(form);
    inp.focus();
  }

  /* ------------------------------------------------------------- mermaid */
  /* Loaded on demand and only when a document actually holds a diagram, from
     the one CDN an artifact may script from. It is the single external
     dependency in this runtime, so it degrades to the source text rather than
     to a blank: a document with no network still says what the diagram says. */
  var MERMAID_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js';
  var svgCache = {}, mermaidReady = null, mermaidSeq = 0;

  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = new Promise(function (resolve, reject) {
      if (window.mermaid) return resolve(window.mermaid);
      var sc = document.createElement('script');
      sc.src = MERMAID_SRC;
      sc.onload = function () {
        if (!window.mermaid) return reject(new Error('loaded but absent'));
        try {
          window.mermaid.initialize({
            startOnLoad: false, securityLevel: 'strict',
            theme: darkMode() ? 'dark' : 'default',
            fontFamily: getComputedStyle(document.body).fontFamily
          });
        } catch (e) { return reject(e); }
        resolve(window.mermaid);
      };
      sc.onerror = function () { reject(new Error('could not load mermaid')); };
      document.head.appendChild(sc);
    });
    return mermaidReady;
  }
  function darkMode() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function drawMermaid(host, b) {
    var code = b.text || '';
    if (!code.trim()) return;
    loadMermaid().then(function (mm) {
      return mm.render('la-mmd-' + (++mermaidSeq), code);
    }).then(function (res) {
      var svg = res && res.svg ? res.svg : String(res);
      svgCache[b.id] = { code: code, svg: svg };
      /* The reader may have moved on; only patch the node still on screen. */
      var live = document.querySelector('[data-block-id="' + b.id + '"] .la-mermaid');
      if (live) live.innerHTML = svg;
    }).catch(function (e) {
      var live = document.querySelector('[data-block-id="' + b.id + '"] .la-mermaid');
      if (!live) return;
      var why = el('p', 'la-mermaid-why',
        /diagram|parse|syntax|expect/i.test(String(e && e.message))
          ? 'This diagram does not parse — the source is below. Click to fix it.'
          : 'The diagram could not be drawn here; its source is below.');
      live.insertBefore(why, live.firstChild);
    });
  }

  function renderBlock(b, index) {
    var wrap = el('div', 'la-block');
    wrap.dataset.blockId = b.id;
    wrap.dataset.type = b.type;
    if (headingLevel(b)) {
      wrap.dataset.level = headingLevel(b);
      wrap.dataset.open = collapsed[b.id] ? '0' : '1';
    }
    if (b.touched) wrap.dataset.touched = b.touched.by === 'claude' ? 'claude' : 'viewer';
    if (changedWhole(b)) wrap.dataset.changed = 'all';
    if (drag && drag.id === b.id) wrap.classList.add('la-drag-src');

    if (!readOnly) wrap.appendChild(renderChrome(b));

    if (b.note) {
      /* A note that has been acted on keeps its text and says so, so the round
         reads as a conversation rather than as a list that emptied itself. */
      var n = el('div', 'la-note' + (b.noteDone ? ' done' : ''));
      n.appendChild(el('b', null, b.noteDone ? 'note handled' : 'note to claude'));
      n.appendChild(document.createTextNode(b.note));
      if (b.noteDone) n.appendChild(el('div', 'la-note-a', b.noteDone));
      wrap.appendChild(n);
    }

    if (editing === b.id) {
      wrap.appendChild(renderEditor(b));
    } else if (headingLevel(b)) {
      wrap.appendChild(renderHeadingRow(b, index));
    } else {
      var body = renderBody(b);
      if (!readOnly && b.type !== 'divider' && b.type !== 'raw') {
        /* A click anywhere on the box edits it. A click that ended a text
           selection must NOT — that gesture belongs to tagging. */
        body.onclick = function (e) {
          if (e.target.closest && e.target.closest('a, .la-cite, .la-cite-pop')) return;
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

  /* A heading is the handle for its whole section: the caret opens it, the ⓘ
     says what the section is FOR (the wording comes from the template the
     document follows), and the closed state reports what is inside so a tagged
     block or a pinned note never hides behind a fold. */
  function renderHeadingRow(b, index) {
    var host = el('div', 'la-headrow');
    var open = !collapsed[b.id];

    var caret = el('button', 'la-caret', open ? '▾' : '▸');
    caret.setAttribute('aria-expanded', open ? 'true' : 'false');
    caret.setAttribute('aria-label', (open ? 'Collapse' : 'Expand') + ' section: ' + (b.text || ''));
    caret.onclick = function (e) {
      e.stopPropagation();
      if (collapsed[b.id]) delete collapsed[b.id]; else collapsed[b.id] = true;
      render();
    };
    host.appendChild(caret);

    var col = el('div', 'la-headtext');
    if (b.eyebrow) col.appendChild(el('span', 'la-eyebrow-sec', b.eyebrow));
    var body = renderBody(b);
    body.classList.add('la-headbody');
    if (!readOnly) {
      body.onclick = function (e) {
        if (e.target.closest && e.target.closest('a, .la-cite, .la-cite-pop')) return;
        var sel = window.getSelection && window.getSelection();
        if (sel && String(sel).trim().length) return;
        editing = b.id; tagging = null; tagQuote = null; render();
      };
      body.title = 'Click to edit';
    }
    col.appendChild(body);
    host.appendChild(col);

    if (b.badge) {
      var bd = el('span', 'la-badge', b.badge);
      bd.title = 'This section comes from ' + b.badge;
      host.appendChild(bd);
    }
    if (b.info) {
      var i = el('button', 'la-info', 'i');
      i.title = b.info;
      i.setAttribute('aria-label', 'What this section is for');
      i.onclick = function (e) {
        e.stopPropagation();
        var open2 = host.parentNode.querySelector('.la-infobox');
        if (open2) return open2.remove();
        var box = el('div', 'la-infobox');
        box.appendChild(el('b', null, 'What goes here'));
        box.appendChild(document.createTextNode(b.info));
        host.parentNode.insertBefore(box, host.nextSibling);
      };
      host.appendChild(i);
    }

    var st = sectionStats(index);
    if (!open) {
      var bits = [st.blocks + (st.blocks === 1 ? ' block' : ' blocks')];
      if (!st.blocks) bits = ['empty'];
      if (st.touched) bits.push(st.touched + ' changed');
      if (st.tagged) bits.push(st.tagged + ' tagged');
      if (st.notes) bits.push(st.notes + (st.notes === 1 ? ' note' : ' notes'));
      var sum = el('button', 'la-foldsum', bits.join(' · '));
      sum.title = 'Open this section';
      sum.onclick = function (e) { e.stopPropagation(); delete collapsed[b.id]; render(); };
      host.appendChild(sum);
    }

    var frag = document.createDocumentFragment();
    frag.appendChild(host);
    /* An open section with nothing in it says so, and offers to be filled.
       Keeping the empty heading is the point: the template's shape stays
       visible, and leaving a section empty stays a visible decision. */
    if (open && !readOnly && sectionEmpty(index)) {
      var ph = el('button', 'la-empty', '\u003c\u003e');
      ph.title = 'Nothing here yet — click to write this section';
      ph.setAttribute('aria-label', 'Add content to ' + (b.text || 'this section'));
      ph.onclick = function () {
        var nb = { id: uid('b'), type: 'para', author: 'viewer', tags: [], text: '' };
        model.blocks.splice(index + 1, 0, nb);
        record({ op: 'insert', block: nb.id, type: 'para', at: index + 1 });
        editing = nb.id;
        render();
      };
      frag.appendChild(ph);
    } else if (open && readOnly && sectionEmpty(index)) {
      frag.appendChild(el('div', 'la-empty la-empty-ro', '\u003c\u003e'));
    }
    return frag;
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
    /* Width and look stay in the model (`layout.w`, `variant`) for Claude to
       set, and off the chrome: two more buttons on every block bought nothing a
       writer asked for. */
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
        record({ op: 'unhighlight', block: b.id, tag: mk.tag, quote: mk.quote, note: mk.note });
        render();
      };
      m.appendChild(chip);
      if (mk.note) {
        /* the note on a passage, next to the passage's chip, answered or not */
        var n = el('span', 'la-marknote' + (mk.noteDone ? ' done' : ''));
        n.appendChild(el('b', null, mk.noteDone ? 'handled' : 'note'));
        n.appendChild(document.createTextNode(mk.note));
        if (mk.noteDone) n.appendChild(el('i', null, mk.noteDone));
        m.appendChild(n);
      }
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

  /* Every editor — textarea, grid, figure form — ends in the same place: one
     source string, one `edit` op. A new way to edit is a new way to produce
     that string, never a new op, so undo and the read-back never learn about
     it. */
  /* Escape on a block the writer just added and never wrote into: the block
     and its insert op go, as one undo, instead of leaving a "New para" behind.
     Returns true when it did so (and rendered). */
  function discardFresh(b, typed) {
    if (!b || !fresh || fresh.id !== b.id) return false;
    var untouched = blockSource(b) === fresh.src && (typed == null || typed === fresh.src);
    fresh = null;
    if (!untouched || blockIndex(b.id) < 0) return false;
    if (undo()) { status('Empty block removed'); render(); return true; }
    return false;
  }
  function commitSource(b, after, keepOpen) {
    if (fresh && fresh.id === b.id) fresh = null;
    var before = blockSource(b), overflow = null;
    /* A heading box holds a label and a heading, nothing more. Prose typed into
       it is prose the writer meant to put in the section, so it becomes a
       paragraph under the heading rather than being swallowed. Silently keeping
       it inside the heading is how a five-paragraph heading gets written. */
    if (b.type === 'heading') {
      var lines = after.split('\n'), keep = [], rest = [], seen = 0;
      lines.forEach(function (l) {
        if (seen < 2) { if (l.trim()) { keep.push(l); seen++; } }
        else rest.push(l);
      });
      var tail = rest.join('\n').trim();
      if (tail) { after = keep.join('\n'); overflow = tail; }
    }
    editing = keepOpen ? b.id : null;
    if (before !== after) {
      var wasTable = b.type === 'table' ? { head: (b.head || []).slice(), rows: (b.rows || []).map(function (r) { return r.slice(); }) } : null;
      applySource(b, after);
      b.author = 'viewer';
      record({ op: 'edit', block: b.id, before: clip(before, 1500), after: clip(after, 1500) });
      var vs = viewerSpans(b, before, after, wasTable);
      if (vs.length && b.touched) b.touched.spans = vs;
    }
    if (overflow) {
      var at = blockIndex(b.id) + 1;
      var nb = { id: uid('b'), type: 'para', author: 'viewer', tags: [], text: overflow };
      model.blocks.splice(at, 0, nb);
      record({ op: 'insert', block: nb.id, type: 'para', at: at, text: clip(overflow, 1500) });
      status('That went past the heading, so it is a paragraph under it now.');
    }
    render();
  }

  /* Shared ending for the two form editors: a click outside keeps the work,
     esc discards it — the same bargain the textarea makes. */
  function closeOnOutside(wrap, commit) {
    var editingWas = editing;
    function down(e) {
      if (wrap.contains(e.target)) return;
      dropEditorHooks();
      commit();
    }
    document.addEventListener('mousedown', down, true);
    editorCleanup = function () { document.removeEventListener('mousedown', down, true); };
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { dropEditorHooks(); editing = null; if (!discardFresh(getBlock(editingWas))) render(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); dropEditorHooks(); commit(); }
    });
  }

  /* The inline subset, shown where it is used. Nobody should have to remember
     four markers, and a reader who does not know them writes plain text that
     still renders correctly. */
  var SHAPE = {
    heading: 'first line is the section label, the rest is the heading',
    callout: 'first line is the title, then a blank line, then the body',
    list: 'one item per line',
    mermaid: 'mermaid source: flowchart, sequenceDiagram, erDiagram'
  };
  function syntaxRow(b) {
    var row = el('div', 'la-syntax');
    if (SHAPE[b.type]) row.appendChild(el('span', 'la-syntax-shape', SHAPE[b.type]));
    if (b.type !== 'mermaid' && b.type !== 'code') {
      ['**bold**', '*italic*', '`code`', '[text](url)'].forEach(function (x) {
        row.appendChild(el('code', null, x));
      });
    }
    return row;
  }

  function renderEditor(b) {
    if (b.type === 'table' && !editAsText) return renderGridEditor(b);
    if (b.type === 'figure') return renderFigureEditor(b);
    var wrap = el('div'), cancelled = false;
    var ta = el('textarea', 'la-edit');
    ta.value = blockSource(b);
    ta.setAttribute('aria-label', 'Edit block');
    var bar = el('div', 'la-editbar');
    bar.appendChild(el('span', null, 'click outside to keep · esc to discard'));
    if (b.type === 'table') {
      var grid = el('button', 'la-btn', 'as a grid');
      grid.onmousedown = function (e) {
        e.preventDefault();
        cancelled = true; editAsText = false;
        commitSource(b, ta.value, true);
      };
      bar.appendChild(grid);
    }
    function apply() { commitSource(b, ta.value); }
    /* No Apply button: leaving the box keeps the edit, undo takes it back. */
    ta.onblur = function () { if (!cancelled && editing === b.id) apply(); };
    ta.onkeydown = function (e) {
      if (e.key === 'Escape') {
        cancelled = true; editing = null;
        /* a block just added and left empty goes away with its insert */
        if (!discardFresh(b, ta.value)) render();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); }
    };
    wrap.appendChild(ta); wrap.appendChild(bar); wrap.appendChild(syntaxRow(b));
    setTimeout(function () { ta.focus(); ta.style.height = ta.scrollHeight + 'px'; }, 0);
    return wrap;
  }

  /* ------------------------------------------------------- the grid editor */
  /* A table used to be edited as tab-separated text, which asked the reader to
     hold the column alignment in their head. Here the cells are cells. The
     model and the journal are untouched: the grid serialises back to exactly
     the same tab-separated string the textarea produced. */
  function renderGridEditor(b) {
    var wrap = el('div', 'la-grid-edit');
    var head = (b.head || []).slice();
    var rows = (b.rows || []).map(function (r) { return r.slice(); });
    if (!head.length) head = ['Column'];
    var focusCell = null;
    /* Cell notes are anchored by position, so removing a row or a column has to
       move them too, or a note ends up pointing at somebody else's cell. They
       are edited in the read view, never here: this editor is for values. */
    var notes = {}, notesDone = {};
    Object.keys(b.cellNotes || {}).forEach(function (k) { notes[k] = b.cellNotes[k]; });
    Object.keys(b.cellNotesDone || {}).forEach(function (k) { notesDone[k] = b.cellNotesDone[k]; });
    function parseKey(k) {
      var h = k.match(/^h(\d+)$/); if (h) return { head: true, c: Number(h[1]) };
      var m = k.match(/^r(\d+)c(\d+)$/);
      return m ? { head: false, r: Number(m[1]), c: Number(m[2]) } : null;
    }
    function remap(fn) {
      var a = {}, d = {};
      Object.keys(notes).forEach(function (k) { var nk = fn(k); if (nk) a[nk] = notes[k]; });
      Object.keys(notesDone).forEach(function (k) { var nk = fn(k); if (nk) d[nk] = notesDone[k]; });
      notes = a; notesDone = d;
    }
    function dropRow(ri) {
      remap(function (k) {
        var p = parseKey(k); if (!p) return k;
        if (p.head) return k;
        if (p.r === ri) return null;
        return p.r > ri ? 'r' + (p.r - 1) + 'c' + p.c : k;
      });
    }
    function dropCol(ci) {
      remap(function (k) {
        var p = parseKey(k); if (!p) return null;
        if (p.c === ci) return null;
        var c = p.c > ci ? p.c - 1 : p.c;
        return p.head ? 'h' + c : 'r' + p.r + 'c' + c;
      });
    }
    function noteInto(td, key) {
      var cn = notes[key]; if (!cn) return;
      var nb = el('div', 'la-cellnote' + (notesDone[key] ? ' done' : ''));
      nb.appendChild(el('b', null, notesDone[key] ? 'note handled' : 'note'));
      nb.appendChild(document.createTextNode(cn));
      td.appendChild(nb);
    }

    function normalise() {
      rows.forEach(function (r) {
        while (r.length < head.length) r.push('');
        r.length = head.length;
      });
    }
    function source() {
      normalise();
      return [head.join('\t')].concat(rows.map(function (r) { return r.join('\t'); })).join('\n');
    }
    function commit() { b.cellNotes = notes; b.cellNotesDone = notesDone; commitSource(b, source()); }
    function redraw(focus) { focusCell = focus || null; wrap.textContent = ''; build(); }

    function cell(value, onInput, cls, label) {
      var i = el('input', cls);
      i.value = value; i.setAttribute('aria-label', label);
      i.oninput = function () { onInput(i.value); };
      return i;
    }
    /* A body cell is a textarea that grows to its text, so a long cell is read
       whole while it is edited instead of scrolling inside one line. A cell can
       hold no newline: the model serialises rows on newlines, so Enter keeps the
       spreadsheet gesture (down a row) and a pasted newline becomes a space. */
    function fit(t) { t.style.height = 'auto'; t.style.height = (t.scrollHeight || 0) + 'px'; }
    function bodyCell(value, onInput, label) {
      var t = el('textarea', 'la-cellarea');
      t.rows = 1; t.value = value; t.setAttribute('aria-label', label);
      t.oninput = function () {
        if (t.value.indexOf('\n') !== -1) t.value = t.value.replace(/\r?\n/g, ' ');
        onInput(t.value); fit(t);
      };
      setTimeout(function () { fit(t); }, 0);
      return t;
    }
    /* Enter walks down the column the way a spreadsheet does; the last row
       makes a new one, because that is the gesture people already have. */
    function walk(i, col, rowIx) {
      i.onkeydown = function (e) {
        if (e.key !== 'Enter' || e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        if (rowIx + 1 >= rows.length) {
          rows.push(head.map(function () { return ''; }));
        }
        redraw({ r: rowIx + 1, c: col });
      };
    }

    function build() {
      normalise();
      var w = el('div', 'la-tablewrap'), t = el('table', 'la-grid');

      var thead = el('thead'), htr = el('tr');
      head.forEach(function (c, ci) {
        var th = el('th');
        th.appendChild(cell(c, function (v) { head[ci] = v; }, null, 'Column ' + (ci + 1) + ' heading'));
        var x = el('button', 'la-cellx', '×');
        x.title = 'Remove this column';
        x.setAttribute('aria-label', 'Remove column ' + (ci + 1));
        x.onclick = function () {
          if (head.length < 2) return;
          head.splice(ci, 1);
          rows.forEach(function (r) { r.splice(ci, 1); });
          dropCol(ci);
          redraw();
        };
        th.appendChild(x);
        noteInto(th, 'h' + ci);
        htr.appendChild(th);
      });
      htr.appendChild(el('th', 'la-gridgutter'));
      thead.appendChild(htr); t.appendChild(thead);

      var tb = el('tbody');
      rows.forEach(function (r, ri) {
        var tr = el('tr');
        r.forEach(function (c, ci) {
          var td = el('td');
          var inp = bodyCell(c, function (v) { rows[ri][ci] = v; },
            'Row ' + (ri + 1) + ', ' + (head[ci] || 'column ' + (ci + 1)));
          walk(inp, ci, ri);
          td.appendChild(inp);
          noteInto(td, 'r' + ri + 'c' + ci);
          if (focusCell && focusCell.r === ri && focusCell.c === ci) {
            setTimeout(function () { inp.focus(); }, 0);
          }
          tr.appendChild(td);
        });
        var g = el('td', 'la-gridgutter');
        var rx = el('button', 'la-cellx', '×');
        rx.title = 'Remove this row';
        rx.setAttribute('aria-label', 'Remove row ' + (ri + 1));
        rx.onclick = function () { rows.splice(ri, 1); dropRow(ri); redraw(); };
        g.appendChild(rx); tr.appendChild(g);
        tb.appendChild(tr);
      });
      t.appendChild(tb); w.appendChild(t); wrap.appendChild(w);

      var bar = el('div', 'la-editbar');
      bar.appendChild(el('span', null, 'click outside to keep · esc to discard'));
      var addR = el('button', 'la-btn', '+ row');
      addR.onclick = function () {
        rows.push(head.map(function () { return ''; }));
        redraw({ r: rows.length - 1, c: 0 });
      };
      var addC = el('button', 'la-btn', '+ column');
      addC.onclick = function () {
        head.push('Column ' + (head.length + 1));
        rows.forEach(function (r) { r.push(''); });
        redraw();
      };
      var asText = el('button', 'la-btn', 'as text');
      asText.title = 'Edit the whole table as tab-separated text — easier for pasting one in';
      asText.onclick = function () { editAsText = true; commitSource(b, source(), true); };
      bar.appendChild(addR); bar.appendChild(addC); bar.appendChild(asText);
      wrap.appendChild(bar); wrap.appendChild(syntaxRow(b));
    }

    build();
    closeOnOutside(wrap, commit);
    setTimeout(function () {
      var first = wrap.querySelector('tbody input');
      if (first && !focusCell) first.focus();
    }, 0);
    return wrap;
  }

  /* ----------------------------------------------------- the figure editor */
  /* The picture is Claude's and stays put. What the reader owns is every word
     printed on it — title, axes, legend — plus the caption under it. Changing
     one is recorded as an ordinary edit, which is how the next round knows to
     redraw. */
  function renderFigureEditor(b) {
    var wrap = el('div', 'la-figure-edit');
    var caption = b.caption || '', alt = b.alt || '';
    var keys = Object.keys(b.labels || {});
    var vals = {}; keys.forEach(function (k) { vals[k] = b.labels[k]; });

    function source() {
      var out = ['caption: ' + caption, 'alt: ' + alt];
      keys.forEach(function (k) { out.push(k + ': ' + vals[k]); });
      return out.join('\n');
    }
    function commit() { commitSource(b, source()); }
    function redraw() { wrap.textContent = ''; build(); }

    function field(label, value, onInput, hint) {
      var row = el('div', 'la-field');
      var l = el('label', null, label);
      var i = el('input');
      i.value = value; i.oninput = function () { onInput(i.value); };
      l.appendChild(i); row.appendChild(l);
      if (hint) row.appendChild(el('span', 'la-hint', hint));
      return { row: row, input: i };
    }

    function build() {
      if (b.svg || b.src) {
        var prev = el('div', 'la-figure-prev');
        if (b.svg) prev.innerHTML = b.svg;
        else { var img = el('img'); img.src = b.src; img.alt = ''; prev.appendChild(img); }
        wrap.appendChild(prev);
      }
      wrap.appendChild(el('p', 'la-hint',
        'The picture itself is not editable here. Correct the words on it and Claude redraws it '
        + 'from these — the image does not change until then.'));

      wrap.appendChild(field('Caption', caption, function (v) { caption = v; }).row);
      wrap.appendChild(field('Alt text', alt, function (v) { alt = v; },
        'read aloud in place of the picture').row);

      /* Both halves are the reader's: what the label IS ("y axis") and what it
         SAYS ("Revenue, share of total"). Naming it is how Claude knows where
         on the picture the words go. */
      keys.forEach(function (k, i) {
        var row = el('div', 'la-field la-field-pair');
        var kn = el('input', 'la-key');
        kn.value = k; kn.setAttribute('aria-label', 'Name of label ' + (i + 1));
        kn.placeholder = 'where on the picture';
        kn.onchange = function () {
          var nk = kn.value.trim();
          if (!nk || nk === k) { kn.value = k; return; }
          if (vals[nk] !== undefined) { kn.value = k; return; }
          vals[nk] = vals[k]; delete vals[k]; keys[i] = nk; redraw();
        };
        var v = el('input');
        v.value = vals[k]; v.setAttribute('aria-label', 'Text of label ' + k);
        v.placeholder = 'what it says';
        v.oninput = function () { vals[keys[i]] = v.value; };
        var x = el('button', 'la-cellx', '×');
        x.title = 'Remove this label';
        x.setAttribute('aria-label', 'Remove label ' + k);
        x.onclick = function () { delete vals[keys[i]]; keys.splice(i, 1); redraw(); };
        row.appendChild(kn); row.appendChild(v); row.appendChild(x);
        wrap.appendChild(row);
      });

      var bar = el('div', 'la-editbar');
      bar.appendChild(el('span', null, 'click outside to keep · esc to discard'));
      var add = el('button', 'la-btn', '+ label');
      add.onclick = function () {
        var n = 'label ' + (keys.length + 1);
        while (vals[n] !== undefined) n = n + '.';
        keys.push(n); vals[n] = '';
        redraw();
      };
      add.title = 'A word printed on the picture: a title, an axis, a legend entry';
      bar.appendChild(add);
      wrap.appendChild(bar); wrap.appendChild(syntaxRow(b));
    }

    build();
    closeOnOutside(wrap, commit);
    setTimeout(function () {
      var first = wrap.querySelector('input');
      if (first) first.focus();
    }, 0);
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
      delete b.noteDone;          /* re-asking reopens it */
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
  /* A heading owns every block after it until the next heading of the same or
     a higher level, so moving a heading moves its section, and moving a card
     moves what is in the card. Anything else is a range of one. */
  function rangeOf(id) {
    var i = blockIndex(id); if (i < 0) return null;
    var lvl = headingLevel(model.blocks[i]);
    /* a tab heading owns the rest of the document, which has nowhere to go, so
       it moves alone; a section or a card moves with its contents */
    if (!lvl || lvl === 2) return [i, i + 1];
    var j = i + 1;
    while (j < model.blocks.length) {
      var l = headingLevel(model.blocks[j]);
      if (l && l <= lvl) break;
      j++;
    }
    return [i, j];
  }
  /* `to` is where the range's first block ends up. */
  function moveTo(id, to) {
    var r = rangeOf(id); if (!r) return false;
    var from = r[0], n = r[1] - r[0];
    if (to === from || to < 0 || to > model.blocks.length - n) return false;
    var taken = model.blocks.splice(from, n);
    var args = [to, 0].concat(taken);
    model.blocks.splice.apply(model.blocks, args);
    record({ op: 'move', block: id, from: from, to: to, count: n });
    return true;
  }
  function move(id, dir) {
    var r = rangeOf(id); if (!r) return;
    /* one step over the neighbouring range, not one index, so a section hops
       past a section and a card past a card */
    var to, n = r[1] - r[0];
    if (dir < 0) { var p = r[0] - 1; if (p < 0) return; var pr = rangeOfIndex(p); to = pr[0]; }
    else { var nx = r[1]; if (nx >= model.blocks.length) return; var nr = rangeOf(model.blocks[nx].id); to = nr[1] - n; }
    if (moveTo(id, to)) {
      render();
      var h = document.querySelector('[data-block-id="' + id + '"] .la-handle');
      if (h) h.focus();
    }
  }

  function rangeOfIndex(p) {
    /* the smallest range ending at p+1: the block itself, or the section a
       heading at p starts */
    var b = model.blocks[p];
    if (headingLevel(b)) return rangeOf(b.id);
    /* a plain block just above may be the tail of a section; moving over it
       one block at a time is what a reader expects */
    return [p, p + 1];
  }

  /* Drag the handle. Pointer events rather than HTML5 drag-and-drop — HTML5
     DnD never fires on touch, and this document gets read on an iPad. */
  function startDrag(e, id) {
    if (readOnly || e.button > 0) return;
    e.preventDefault();
    drag = { id: id, to: blockIndex(id), toId: null, after: false, axisX: false, nodes: [], ghost: null, dx: 0, dy: 0 };
    document.body.classList.add('la-dragging');
    var wrap = document.querySelector('[data-block-id="' + id + '"]');
    if (wrap) wrap.classList.add('la-drag-src');
    if (mode !== 'outline' && wrap) {
      /* In the page the move is previewed live: the blocks being moved travel
         to where they would land, faded, and a translucent copy follows the
         pointer. A section heading brings the wrappers of the blocks it owns. */
      var r0 = rangeOf(id) || [blockIndex(id), blockIndex(id) + 1], ids = {};
      model.blocks.slice(r0[0], r0[1]).forEach(function (b) { ids[b.id] = 1; });
      drag.nodes = [].slice.call(document.querySelectorAll('.la-blk')).filter(function (n) {
        if (!ids[n.dataset.blockId]) return false;
        var p = n.parentElement && n.parentElement.closest ? n.parentElement.closest('.la-blk') : null;
        return !(p && ids[p.dataset.blockId]);
      });
      drag.nodes.forEach(function (n) { n.classList.add('la-drag-src', 'la-drag-hidden'); });
      var rc = wrap.getBoundingClientRect();
      /* the place it came from stays empty until the drop, at the same size */
      var hole = el('div', 'la-hole');
      var wm = /(?:^|\s)(blk w-[\w-]+)/.exec(wrap.className);
      if (wm) hole.className += ' ' + wm[1];
      if (rc.height) hole.style.minHeight = rc.height + 'px';
      wrap.parentNode.insertBefore(hole, wrap);
      drag.hole = hole;
      if (rc.width) {
        var g = wrap.cloneNode(true);
        g.className = 'la-ghost'; g.removeAttribute('data-block-id');
        g.style.width = rc.width + 'px'; g.style.left = rc.left + 'px'; g.style.top = rc.top + 'px';
        document.body.appendChild(g);
        drag.ghost = g; drag.dx = e.clientX - rc.left; drag.dy = e.clientY - rc.top;
      }
    }
    if (e.target.setPointerCapture && e.pointerId != null) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
    }
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
  }
  function onDragMove(e) {
    if (!drag) return;
    if (mode === 'outline') {
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
      return;
    }
    /* In the page the DOM order is not the model order, so the target is the
       innermost block under the pointer, and the move is to a model index. */
    if (drag.ghost) { drag.ghost.style.left = (e.clientX - drag.dx) + 'px'; drag.ghost.style.top = (e.clientY - drag.dy) + 'px'; }
    var t = dropTargetAt(e.clientX, e.clientY, drag.nodes);
    if (!t) return;
    if (t.id !== drag.toId || t.zone !== drag.zone) {
      drag.toId = t.id; drag.zone = t.zone;
      markDrop(t);
      drag.dest = destIndexFor(t, getBlock(drag.id), drag.id);
      /* a plain block dropped beside a card becomes a card of its own */
      drag.asCard = t.node.classList.contains('la-cardblk') && t.zone !== 'into' && !headingLevel(getBlock(drag.id));
      drag.cardLevel = drag.asCard ? headingLevel(getBlock(t.id)) : 0;
      drag.nodes.forEach(function (n) { n.classList.remove('la-drag-hidden'); });
      drag.host = previewAtIndex(drag.nodes, drag.dest, getBlock(drag.id), drag.id, drag.asCard);
      /* previewed in its own row, the faded card stands for the hole */
      if (drag.hole) drag.hole.classList.toggle('la-drag-hidden', !!drag.host && drag.host === drag.hole.parentNode);
    }
  }
  /* The block under the pointer and the zone of it: for a card, its left and
     right quarters mean beside it and the middle means inside it; for a
     section heading, below its middle means first in the section; for any
     other block, past its middle (right of it, for a block sharing a row)
     means after it. Blocks being moved, and the ghost, do not count. */
  function dropTargetAt(x, y, exclude) {
    var blks = [].slice.call(document.querySelectorAll('.la-blk')), hit = null;
    exclude = exclude || [];
    blks.forEach(function (bl) {
      if (bl.closest('.la-ghost')) return;
      for (var i = 0; i < exclude.length; i++) if (exclude[i] === bl || exclude[i].contains(bl)) return;
      var r = bl.getBoundingClientRect();
      if (!r.height) return;
      if (y >= r.top && y <= r.bottom && x >= r.left && x <= r.right) hit = bl;
    });
    if (!hit) return null;
    /* inside a card the blocks fill it edge to edge, so the card's own left
       and right quarters are read on the card, whatever block is under them */
    var card = hit.classList.contains('la-cardblk') ? null : hit.closest('.la-cardblk');
    if (card) {
      var cr = card.getBoundingClientRect(), cfx = (x - cr.left) / (cr.width || 1);
      var excluded = false;
      for (var k = 0; k < exclude.length; k++) if (exclude[k] === card || exclude[k].contains(card)) excluded = true;
      if (!excluded && (cfx < 0.25 || cfx > 0.75)) hit = card;
    }
    var hr = hit.getBoundingClientRect(), pr = hit.parentElement ? hit.parentElement.getBoundingClientRect() : hr;
    var zone, axisX = false;
    if (hit.classList.contains('la-cardblk')) {
      var fx = (x - hr.left) / (hr.width || 1);
      zone = fx < 0.25 ? 'before' : fx > 0.75 ? 'after' : 'into';
      axisX = true;
    } else if (hit.classList.contains('la-sechead')) {
      zone = y > hr.top + hr.height / 2 ? 'into' : 'before';
    } else {
      axisX = !!(pr.width && hr.width < pr.width * 0.7);
      zone = (axisX ? x > hr.left + hr.width / 2 : y > hr.top + hr.height / 2) ? 'after' : 'before';
    }
    return { id: hit.dataset.blockId, node: hit, zone: zone, axisX: axisX };
  }
  function clearDropMarks() {
    [].slice.call(document.querySelectorAll('.la-drop-before, .la-drop-after, .la-drop-left, .la-drop-right, .la-drop-into')).forEach(function (n) {
      n.classList.remove('la-drop-before', 'la-drop-after', 'la-drop-left', 'la-drop-right', 'la-drop-into');
    });
  }
  function markDrop(t) {
    clearDropMarks();
    if (!t) return;
    var cls = t.zone === 'into' ? 'la-drop-into'
      : t.zone === 'after' ? (t.axisX ? 'la-drop-right' : 'la-drop-after')
        : (t.axisX ? 'la-drop-left' : 'la-drop-before');
    t.node.classList.add(cls);
  }
  /* Where the model index of the drop is: before a block is its index, after
     it is the end of what it owns, inside a card is that same end, inside a
     section is right after its heading. */
  function destIndexFor(t, moving, movingId) {
    var tr = rangeOf(t.id); if (!tr) return null;
    var dest = t.zone === 'before' ? tr[0]
      : (t.zone === 'into' && t.node.classList.contains('la-sechead')) ? tr[0] + 1
        : tr[1];
    /* A heading owns everything up to the next heading of its rank, so a card
       dropped between two paragraphs would swallow the ones after it. It lands
       at the next boundary instead: before the next card or section heading,
       which is where the preview shows it. */
    var lvl = moving ? headingLevel(moving) : 0;
    if (lvl) {
      var sr = movingId ? rangeOf(movingId) : null;
      var k = dest;
      while (k < model.blocks.length) {
        if (sr && k >= sr[0] && k < sr[1]) { k = sr[1]; continue; }
        var l = headingLevel(model.blocks[k]);
        if (l && l <= lvl) break;
        k++;
      }
      dest = k;
    }
    return dest;
  }
  /* A block set beside cards becomes a card: a heading of the neighbours'
     level goes in front of it, titled for the writer to rename. A table takes
     its first column head as the title. */
  function newCardAround(id, level) {
    var i = blockIndex(id); if (i < 0) return null;
    var b = model.blocks[i];
    var title = b.type === 'table' && b.head && String(b.head[0]).trim() ? String(b.head[0]).trim()
      : b.type === 'figure' && b.caption ? clip(b.caption, 40) : 'New card';
    var h = { id: uid('b'), type: 'heading', level: level || 4, text: title, author: 'viewer', tags: [] };
    model.blocks.splice(i, 0, h);
    record({ op: 'insert', block: h.id, type: 'heading', at: i, text: title });
    return h.id;
  }
  function wrapperOf(id) { return document.querySelector('.la-blk[data-block-id="' + id + '"]'); }
  function outerWrap(w) { var p; while (w.parentElement && (p = w.parentElement.closest('.la-blk'))) w = p; return w; }
  /* Show the result before it happens. The place in the page is derived from
     the model index, not from the pointer, so the preview tells the truth: a
     paragraph dropped on the right edge of a card cannot stand between two
     cards (every block after a card heading belongs to that card), so it is
     shown where the model will put it, last in that card. A card dropped
     there lands beside it. Pure DOM: render() undoes it. */
  function previewAtIndex(nodes, dest, moving, movingId, asCard) {
    if (!nodes.length || dest == null) return null;
    unfitRows();
    var sr = movingId ? rangeOf(movingId) : null, n = sr ? sr[1] - sr[0] : 0;
    var ids = model.blocks.map(function (b) { return b.id; });
    if (sr) ids.splice(sr[0], n);
    var at = sr && dest > sr[0] ? dest - n : dest;
    var prevId = at > 0 ? ids[at - 1] : null, nextId = at < ids.length ? ids[at] : null;
    var lvl = moving ? headingLevel(moving) : 0;
    var prevW = prevId ? wrapperOf(prevId) : null, nextW = nextId ? wrapperOf(nextId) : null;
    var parent, ref;
    if (lvl || asCard) {
      /* a heading brings a card or a section: it lands between wrappers of its
         own kind, and after the last card of a strip it stays in the strip */
      var pw = prevW ? outerWrap(prevW) : null, nw = nextW ? outerWrap(nextW) : null;
      if (pw && pw.classList.contains('la-cardblk')) { parent = pw.parentNode; ref = pw.nextSibling; }
      else if (nw) { parent = nw.parentNode; ref = nw; }
      else if (pw) { parent = pw.parentNode; ref = pw.nextSibling; }
      else return null;
    } else if (prevW) {
      var prevB = getBlock(prevId);
      if (headingLevel(prevB) && (prevW.classList.contains('la-cardblk') || prevW.classList.contains('la-sechead'))) {
        /* right after a heading: first inside what it owns */
        var into = prevW.classList.contains('la-cardblk') ? prevW.querySelector('.card')
          : (prevW.nextElementSibling && prevW.nextElementSibling.classList.contains('blocks') ? prevW.nextElementSibling : null);
        if (!into) return null;
        parent = into; ref = into.firstChild;
        if (prevW.classList.contains('la-cardblk')) {
          var kids = [].slice.call(into.children), h3 = null;
          kids.forEach(function (k) { if (k.tagName === 'H3') h3 = k; });
          if (h3) ref = h3.nextSibling;
        }
      } else { parent = prevW.parentNode; ref = prevW.nextSibling; }
    } else if (nextW) { parent = nextW.parentNode; ref = nextW; }
    else return null;
    nodes.forEach(function (nd) { parent.insertBefore(nd, ref); });
    fitRow(parent);
    return parent;
  }
  /* A row of cards keeps to the page width: dropping a card into a full row
     narrows the cards already there and the newcomer alike, previewed while
     the pointer is still down. Only the card grids do this; the section grid
     wraps instead, since a paragraph under a half-width table is what its
     author meant. */
  var COLS = { quarter: 3, third: 4, half: 6, 'two-thirds': 8, full: 12 };
  var CARD_DEFAULT = { 'context-strip': 4, 'grid-2': 6 };
  var fitted = [];
  function isCardGrid(c) { return !!(c && c.classList && (c.classList.contains('context-strip') || c.classList.contains('grid-2'))); }
  function widthOf(node, dflt) {
    var m = /(?:^|\s)w-(quarter|third|half|two-thirds|full)(?:\s|$)/.exec(node.className || '');
    return m ? COLS[m[1]] : dflt;
  }
  function fitWidthFor(n) { return n <= 1 ? 'full' : n === 2 ? 'half' : n === 3 ? 'third' : 'quarter'; }
  function rowFit(container) {
    if (!isCardGrid(container)) return null;
    var kids = [].slice.call(container.children).filter(function (k) { return k.classList && (k.classList.contains('la-blk') || k.classList.contains('la-placeholder')); });
    var dflt = container.classList.contains('context-strip') ? CARD_DEFAULT['context-strip'] : CARD_DEFAULT['grid-2'];
    var sum = 0; kids.forEach(function (k) { sum += widthOf(k, dflt); });
    if (sum <= 12) return null;
    return { kids: kids, w: fitWidthFor(kids.length) };
  }
  function fitRow(container) {
    var f = rowFit(container); if (!f) return;
    f.kids.forEach(function (k) { fitted.push({ node: k, cls: k.className }); applyWidthClass(k, f.w); });
  }
  function unfitRows() {
    fitted.forEach(function (x) { x.node.className = x.cls; });
    fitted = [];
  }
  /* After the model changed, make the fit real: every card of that row takes
     the width the preview showed. Recorded as layout ops in the same undo. */
  function applyRowFit(container) {
    /* measured on the real widths, never on the preview's: a move within a
       row must leave the other cards as they were */
    unfitRows();
    var f = rowFit(container);
    if (!f) return;
    var w = f.w;
    f.kids.forEach(function (k) {
      var b = k.dataset && k.dataset.blockId ? getBlock(k.dataset.blockId) : null;
      if (!b) return;
      if (((b.layout && b.layout.w) || null) === w) return;
      b.layout = b.layout || {}; b.layout.w = w;
      record({ op: 'layout', block: b.id, w: w });
    });
  }
  function endDrag() {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', endDrag);
    document.removeEventListener('pointercancel', endDrag);
    document.body.classList.remove('la-dragging');
    if (!drag) return;
    var d = drag; drag = null;
    if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
    if (d.hole && d.hole.parentNode) d.hole.parentNode.removeChild(d.hole);
    d.nodes.forEach(function (n) { n.classList.remove('la-drag-hidden'); });
    unfitRows();
    if (mode === 'outline') { if (d.to !== blockIndex(d.id)) moveTo(d.id, d.to); }
    else if (d.toId && d.toId !== d.id && d.dest != null) {
      var sr = rangeOf(d.id), dest = d.dest;
      /* the moved range lands at the index the preview showed; a drop inside
         what is being moved is a no-op */
      if (sr && !(dest > sr[0] && dest < sr[1])) {
        var n2 = sr[1] - sr[0], at = dest > sr[0] ? dest - n2 : dest;
        group(function () {
          moveTo(d.id, at);
          if (d.asCard) newCardAround(d.id, d.cardLevel);
          if (d.host) applyRowFit(d.host);
        });
      }
    }
    unfitRows();
    render();
  }

  /* ---------------------------------------------------------- resizing */
  /* The right edge of a block in the section grid drags to one of the four
     widths the design system knows. Snapping is by thirds and halves; a
     width the content cannot fit in (a table, a long code line) is refused
     and the next one up is taken. Nothing else about the look is on offer. */
  var WIDTHS = ['quarter', 'third', 'half', 'two-thirds', 'full'];
  /* the containers laid out on the 12-column grid, where a width applies */
  var GRIDS = ['blocks', 'context-strip', 'grid-2'];
  function inGrid(node) {
    var p = node.parentElement;
    return !!(p && GRIDS.some(function (c) { return p.classList.contains(c); }));
  }
  function snapWidth(frac) {
    if (frac < 0.29) return 'quarter';
    if (frac < 0.417) return 'third';
    if (frac < 0.583) return 'half';
    if (frac < 0.833) return 'two-thirds';
    return 'full';
  }
  function applyWidthClass(node, w) {
    node.classList.remove('blk', 'w-quarter', 'w-half', 'w-third', 'w-two-thirds', 'w-full');
    if (w) { node.classList.add('blk', 'w-' + w); }
  }
  function startResize(e, b, node) {
    if (readOnly || e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    var grid = node.parentElement;
    resize = { b: b, node: node, grid: grid, w0: (b.layout && b.layout.w) || 'full', w: (b.layout && b.layout.w) || 'full' };
    document.body.classList.add('la-resizing');
    node.classList.add('la-resize-src');
    if (e.target.setPointerCapture && e.pointerId != null) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
    }
    document.addEventListener('pointermove', onResizeMove);
    document.addEventListener('pointerup', endResize);
    document.addEventListener('pointercancel', endResize);
  }
  function onResizeMove(e) {
    if (!resize) return;
    var gr = resize.grid.getBoundingClientRect(), nr = resize.node.getBoundingClientRect();
    if (!gr.width) return;
    var w = snapWidth((e.clientX - nr.left) / gr.width);
    if (w !== resize.w) { resize.w = w; applyWidthClass(resize.node, w); }
  }
  function endResize() {
    document.removeEventListener('pointermove', onResizeMove);
    document.removeEventListener('pointerup', endResize);
    document.removeEventListener('pointercancel', endResize);
    document.body.classList.remove('la-resizing');
    if (!resize) return;
    var r = resize; resize = null;
    r.node.classList.remove('la-resize-src');
    setWidth(r.b, r.w, r.node, r.w0);
  }
  /* Set a width, widening until the content fits. `node` is the live wrapper
     used to measure; without one (a request from the bar or from Claude) the
     width is taken as asked. */
  function setWidth(b, w, node, w0) {
    var i = WIDTHS.indexOf(w); if (i < 0) return false;
    var cur = (b.layout && b.layout.w) || 'full';
    /* No refusal: text wraps and grows downward, tables scroll inside their
       frame, figures scale with the block (CSS). A check on overflow used to
       refuse every narrowing, because the resize edge itself overflows. */
    if (node) applyWidthClass(node, w);
    if (w === cur) return false;
    b.layout = b.layout || {}; b.layout.w = w;
    /* in a card grid a card's natural width is narrower, so `full` is kept */
    if (w === 'full' && !(node && node.parentElement && !node.parentElement.classList.contains('blocks'))) delete b.layout.w;
    if (!Object.keys(b.layout).length) delete b.layout;
    record({ op: 'layout', block: b.id, w: w });
    render();
    return true;
  }

  /* --------------------------------------------------- adding, by placing */
  /* `+ Add` in the bar names a type; the writer then carries a placeholder
     across the page and clicks where it goes, inside a card or between any two
     blocks. The same drop rule as a move: the side of the block under the
     pointer decides, and "after" a card or a heading means inside it, last. */
  var BLOCK_TYPES = ['para', 'heading', 'list', 'callout', 'table', 'mermaid', 'figure', 'divider'];
  function startPlacing(t) {
    cancelPlacing();
    var ph = el('div', 'la-placeholder', 'the new ' + t + ' goes here');
    var g = el('div', 'la-ghost la-ghost-new', '+ ' + t + ' \u00B7 click where it goes \u00B7 esc cancels');
    document.body.appendChild(g);
    placing = { type: t, ph: ph, ghost: g, toId: null, after: false };
    document.body.classList.add('la-placing');
    document.addEventListener('pointermove', onPlaceMove);
    document.addEventListener('click', onPlaceClick, true);
    status('Click where the new ' + t + ' should go');
  }
  function onPlaceMove(e) {
    if (!placing) return;
    placing.ghost.style.left = (e.clientX + 14) + 'px'; placing.ghost.style.top = (e.clientY + 14) + 'px';
    var t = dropTargetAt(e.clientX, e.clientY, [placing.ph]);
    if (!t || (t.id === placing.toId && t.zone === placing.zone)) return;
    placing.toId = t.id; placing.zone = t.zone;
    markDrop(t);
    placing.dest = destIndexFor(t, placing.type === 'heading' ? { type: 'heading', level: 4 } : null, null);
    placing.asCard = t.node.classList.contains('la-cardblk') && t.zone !== 'into' && placing.type !== 'heading';
    placing.cardLevel = placing.asCard ? headingLevel(getBlock(t.id)) : 0;
    placing.host = previewAtIndex([placing.ph], placing.dest, placing.type === 'heading' ? { type: 'heading', level: 4 } : { type: placing.type }, null, placing.asCard);
  }
  function onPlaceClick(e) {
    if (!placing) return;
    if (e.target.closest && e.target.closest('#la-bar, .la-addmenu')) return;
    e.preventDefault(); e.stopPropagation();
    var p = placing;
    if (!p.toId || p.dest == null) return;
    /* the fit the placeholder previewed applies to the row it lands in,
       measured on the real widths */
    unfitRows();
    var fit = p.host ? rowFit(p.host) : null;
    var fitIds = fit ? fit.kids.map(function (k) { return k.dataset ? k.dataset.blockId : null; }) : null;
    cancelPlacing();
    group(function () {
      var id = placeBlock(p.type, p.dest);
      if (id && p.asCard) { newCardAround(id, p.cardLevel); render(); }
      if (fit && id) {
        fitIds.concat([id]).forEach(function (bid) {
          var b = bid && getBlock(bid); if (!b) return;
          if (((b.layout && b.layout.w) || null) === fit.w) return;
          b.layout = b.layout || {}; b.layout.w = fit.w;
          record({ op: 'layout', block: b.id, w: fit.w });
        });
        render();
      }
    });
  }
  function cancelPlacing() {
    if (!placing) return;
    document.removeEventListener('pointermove', onPlaceMove);
    document.removeEventListener('click', onPlaceClick, true);
    document.body.classList.remove('la-placing');
    if (placing.ghost.parentNode) placing.ghost.parentNode.removeChild(placing.ghost);
    if (placing.ph.parentNode) placing.ph.parentNode.removeChild(placing.ph);
    unfitRows();
    clearDropMarks();
    placing = null;
  }
  function placeBlock(t, at) {
    if (at == null || at < 0 || at > model.blocks.length) return null;
    var nb = newBlock(t);
    if (t === 'heading') nb.level = 4;
    model.blocks.splice(at, 0, nb);
    record({ op: 'insert', block: nb.id, type: t, at: at });
    editing = t === 'divider' ? null : nb.id;
    fresh = t === 'divider' ? null : { id: nb.id, src: blockSource(nb) };
    render();
    return nb.id;
  }
  function toggleAddMenu(anchor) {
    var open = document.getElementById('la-addmenu');
    if (open) { open.remove(); return; }
    var menu = el('div', 'la-addmenu'); menu.id = 'la-addmenu';
    menu.appendChild(el('div', 'la-tagmenu-label', 'add, then click where it goes'));
    BLOCK_TYPES.forEach(function (t) {
      var x = el('button', 'la-btn', t);
      x.onclick = function (e) { e.stopPropagation(); menu.remove(); startPlacing(t); };
      menu.appendChild(x);
    });
    menu.onclick = function (e) { e.stopPropagation(); };
    document.body.appendChild(menu);
    var r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, r.left) + 'px';
  }

  function removeBlock(b) {
    var i = blockIndex(b.id);
    if (i < 0) return;
    if (fresh && fresh.id === b.id) fresh = null;
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
  /* A selected passage can take a note as well as a tag. The note sits on the
     mark, so it is pinned to those words and nothing else: a cell, a sentence
     in a card, one field of a scenario. */
  function noteOnSelection() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return false;
    var text = String(sel).trim();
    var ids = spannedBlocks(sel);
    if (text.length < 2 || ids.length !== 1) return false;
    var b = getBlock(ids[0]);
    if (!b || blockText(b).indexOf(text) < 0) return false;
    var quote = snapToWords(blockText(b), text);
    try { sel.removeAllRanges(); } catch (e) { /* ignore */ }
    hideSelChip();
    var mk = (b.marks || []).filter(function (o) { return o.quote === quote; })[0];
    if (!mk) { mk = { quote: quote }; b.marks = (b.marks || []).concat([mk]); }
    var host = document.querySelector('[data-block-id="' + b.id + '"]');
    if (!host || host.querySelector('.la-noteform')) return true;
    var form = el('div', 'la-inline la-noteform');
    var inp = el('input');
    inp.value = mk.note || '';
    inp.placeholder = 'note on \u201C' + clip(quote, 40) + '\u201D';
    inp.setAttribute('aria-label', 'Note to Claude on this passage');
    var ok = el('button', 'la-btn primary', 'Save note');
    function commit() {
      var v = inp.value.trim();
      if (v) mk.note = v; else delete mk.note;
      delete mk.noteDone;
      record({ op: 'note', block: b.id, quote: quote, text: v });
      render();
    }
    ok.onclick = function (e) { e.stopPropagation(); commit(); };
    inp.onkeydown = function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { form.remove(); render(); }
    };
    form.onclick = function (e) { e.stopPropagation(); };
    form.appendChild(inp); form.appendChild(ok);
    host.appendChild(form);
    inp.focus();
    return true;
  }
  function showSelChip(ids, text, sel) {
    var c = document.getElementById('la-selchip');
    if (!c) {
      c = el('div', 'la-selchip');
      c.id = 'la-selchip';
      document.body.appendChild(c);
    }
    c.textContent = '';
    var tagB = el('button', 'la-selbtn', ids.length > 1 ? '+ tag ' + ids.length + ' blocks' : '+ tag');
    tagB.title = 'Tag the highlighted text';
    tagB.onclick = function () { hideSelChip(); finishHighlight(); };
    c.appendChild(tagB);
    if (ids.length === 1) {
      var noteB = el('button', 'la-selbtn', '+ note');
      noteB.title = 'Pin a note to Claude on these words';
      noteB.onclick = function () { noteOnSelection(); };
      c.appendChild(noteB);
    }
    c.hidden = false;
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
        /* Filtering and folding are both views and they must not fight: asking
           to see something opens the document and leaves it open, so clearing
           the filter never hides what was just found. */
        if (filter.length) setAllFolded(false);
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

  /* ------------------------------------------------------------- read mode */
  /* The published look, drawn from the same model in the same page, and for a
     writer the place where editing happens: hover a block for its handle and
     actions, click it to edit in place, drag it to move it, add one at the end
     of any section. A reader gets the same layout with nothing to click and
     nothing that is working state on it.
     This is a port of the PRD exporter: the same house class names, so the
     house stylesheet is the one stylesheet for the published look, and the same
     component conventions (a "Step | Who | What happens" table is a flow, a
     level-4 heading under Purpose a context card, a paragraph opening with a
     bold line a scenario). */
  var pageEdit = false;      /* true while a writer edits in the house layout */
  var noWrap = false;        /* set while rendering the footer, which repeats blocks */
  var activeTab = null;      /* the open tab survives a re-render */
  function rSlug(t) {
    var x = String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return x || 's';
  }
  function rHas(b, tag) { return (b.tags || []).indexOf(tag) !== -1; }
  var R_BOLD_TITLE = /^\*\*([^*\n]+)\*\*\s*\n\s*\n([\s\S]+)$/;
  var R_FIELD = /^\*\*([^*:]+):\*\*\s*([\s\S]*)$/;
  var R_WHO = [['new', 't1'], ['existing', 'ex'], ['later', 'rm'], ['deferred', 'rm']];
  var R_PILL = { high: 'high', medium: 'medium', 'medium-high': 'medium', low: 'low',
    'low to medium': 'medium', it: 'it', engineering: 'it', cs: 'cs', pm: 'pm', product: 'pm' };

  /* Text with the writer's working state on it, or clean for a reader. */
  function rText(b, t, cellKey) {
    if (!pageEdit) return inline(t);
    var chg = changeSpans(b);
    if (cellKey) chg = spansFor(chg, cellKey);
    return withMarks(t, b.marks, chg);
  }
  /* Every block a writer can act on is wrapped and addressable. A reader's
     page carries no wrappers at all. */
  function wrapBlk(b, html, extra) {
    if (!pageEdit || noWrap || !html) {
      var w0 = b.layout && b.layout.w;
      return (w0 && html && !noWrap) ? '<div class="blk w-' + esc(w0) + '">' + html + '</div>' : html;
    }
    var w = b.layout && b.layout.w;
    var cls = 'la-blk' + (w ? ' blk w-' + esc(w) : '') + (extra ? ' ' + extra : '');
    return '<div class="' + cls + '" data-block-id="' + esc(b.id) + '" data-type="' + esc(b.type) + '">' + html + '</div>';
  }
  function rCell(b, text, asRole, key) {
    var t = String(text == null ? '' : text).trim();
    if (asRole) { var rc = roleCell(t); if (rc) return roleHtml(rc).replace(/la-tag la-role/g, 'pill role').replace(/--tag-h:/g, '--role-h:').replace(/la-rolelead/g, 'role-lead'); }
    var k = t.toLowerCase().replace(/\.$/, '');
    if (R_PILL[k]) return '<span class="pill ' + R_PILL[k] + '">' + esc(t) + '</span>';
    return rText(b, t, key);
  }
  function rTableInner(b) {
    var head = b.head || [], rows = b.rows || [], rcols = roleColumns(head);
    var out = '<div class="tbl-wrap' + (b.variant === 'striped' ? ' striped' : '') + '"><table>';
    if (head.some(function (h) { return String(h).trim(); })) {
      out += '<thead><tr>' + head.map(function (h) { return '<th>' + inline(h) + '</th>'; }).join('') + '</tr></thead>';
    }
    out += '<tbody>' + rows.map(function (r, ri) {
      return '<tr>' + r.map(function (c, ci) { return '<td>' + rCell(b, c, !!rcols[ci], 'r' + ri + 'c' + ci) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
    return out;
  }
  function rTable(b) { return wrapBlk(b, rTableInner(b)); }
  function rNarrow(b) {
    if ((b.head || []).length > 2) return false;
    var longest = 0;
    (b.rows || []).forEach(function (r) { r.forEach(function (c) { longest = Math.max(longest, String(c || '').length); }); });
    return longest <= 160;
  }
  function rScenario(b, title, body) {
    var rows = [], loose = [];
    body.split('\n').forEach(function (line) {
      line = line.trim(); if (!line) return;
      var m = line.match(R_FIELD);
      if (m && !loose.length) rows.push([m[1].trim(), m[2].trim()]); else loose.push(line);
    });
    var out = '<div class="scenario"><h4>' + rText(b, title) + '</h4>';
    if (rows.length) {
      out += '<dl class="fields">' + rows.map(function (kv) {
        return '<dt>' + esc(kv[0]) + '</dt><dd>' + rText(b, kv[1]) + '</dd>';
      }).join('') + '</dl>';
    }
    loose.forEach(function (l) { out += '<p>' + rText(b, l) + '</p>'; });
    return out + '</div>';
  }
  function rParaInner(b) {
    var t = String(b.text || '');
    var m = t.trim().match(R_BOLD_TITLE);
    if (m) return rScenario(b, m[1].trim(), m[2]);
    if (t.indexOf('> ') === 0) {
      var lines = t.slice(2).split('\n');
      var quote = lines.length > 1 ? lines.slice(0, -1).join('\n') : lines[0];
      var cite = lines.length > 1 ? '<cite>' + rText(b, lines[lines.length - 1]) + '</cite>' : '';
      return '<blockquote>\u201C' + rText(b, quote) + '\u201D' + cite + '</blockquote>';
    }
    if (/^Sources?:/.test(t)) return '<p class="src">' + rText(b, t) + '</p>';
    return '<p>' + rText(b, t).replace(/\n/g, '<br>') + '</p>';
  }
  function rBlockInner(b) {
    switch (b.type) {
      case 'para': return rParaInner(b);
      case 'list': {
        var tag = b.ordered ? 'ol' : 'ul';
        var cls = tag === 'ul' ? ' class="list' + (b.variant === 'checks' ? ' checks' : '') + '"' : '';
        return '<' + tag + cls + '>' + (b.items || []).map(function (i) { return '<li>' + rText(b, i) + '</li>'; }).join('') + '</' + tag + '>';
      }
      case 'table': return rTableInner(b);
      case 'callout':
        return '<div class="deferred" data-variant="' + esc(b.variant || 'note') + '"><span class="tag">'
          + esc(b.title || 'Note') + '</span><div>' + rText(b, b.text || '').replace(/\n/g, '<br>') + '</div></div>';
      case 'code': return '<pre class="json"><code>' + esc(b.text || '') + '</code></pre>';
      case 'mermaid': return '<div class="diagram-wrap"><figure><pre class="mermaid">' + esc(b.text || '') + '</pre></figure></div>';
      case 'figure': {
        var fc = b.caption ? '<figcaption>' + rText(b, b.caption) + '</figcaption>' : '';
        if (b.svg) return '<div class="diagram-wrap"><figure>' + b.svg.replace(/<svg /, '<svg role="img" aria-label="' + esc(b.alt || '') + '" ') + fc + '</figure></div>';
        if (b.src) return '<div class="diagram-wrap"><figure><img src="' + esc(b.src) + '" alt="' + esc(b.alt || '') + '" style="max-width:100%">' + fc + '</figure></div>';
        return '<div class="diagram-wrap"><figure><p class="muted">Figure to be redrawn: ' + esc((b.labels || {}).title || b.caption || 'this figure') + '.</p>' + fc + '</figure></div>';
      }
      case 'raw': return b.html || '';
      case 'divider': return pageEdit ? '<hr class="la-divider">' : '';
      case 'heading': return '<div class="sub-head" id="' + esc(b.id) + '"><h3>' + rText(b, b.text || '') + '</h3></div>';
      default: return '<p>' + rText(b, b.text || '') + '</p>';
    }
  }
  function rBlock(b) { return wrapBlk(b, rBlockInner(b)); }
  function rSplit(blocks) {
    var hero = [], tabs = [], tab = null, sec = null;
    blocks.forEach(function (b) {
      if (b.type === 'heading' && headingLevel(b) === 2) {
        tab = { label: (b.text || '').trim(), id: rSlug(b.text), bid: b.id, block: b, sections: [] };
        tabs.push(tab); sec = null; return;
      }
      if (!tab) { hero.push(b); return; }
      if (b.type === 'heading' && headingLevel(b) === 3) {
        sec = { eyebrow: (b.eyebrow || '').trim(), claim: (b.text || '').trim(), id: rSlug(b.eyebrow || b.text),
                bid: b.id, block: b, blocks: [], internal: rHas(b, 'internal') };
        tab.sections.push(sec); return;
      }
      if (!sec) { sec = { eyebrow: '', claim: '', id: rSlug(tab.label) + '-intro', bid: null, block: null, blocks: [], internal: false }; tab.sections.push(sec); }
      sec.blocks.push(b);
    });
    return { hero: hero, tabs: tabs };
  }
  function rGroups(blocks) {
    var lead = [], groups = [], cur = null;
    blocks.forEach(function (b) {
      if (b.type === 'heading') { cur = [b, []]; groups.push(cur); }
      else if (!cur) lead.push(b);
      else cur[1].push(b);
    });
    return { lead: lead, groups: groups };
  }
  function rIsSteps(b) {
    var h = (b.head || []).map(function (x) { return String(x).trim().toLowerCase(); });
    return b.type === 'table' && h.length >= 3 && h[0] === 'step' && h[1] === 'who';
  }
  function rSteps(tbl) {
    var rows = tbl.rows || [], n = rows.length, size = n <= 4 ? 'four' : n === 5 ? 'five' : 'six';
    return wrapBlk(tbl, '<div class="steps ' + size + '">' + rows.map(function (r, ri) {
      var step = r[0] || '', who = r[1] || '', what = r[2] || '';
      var cls = 'ai';
      for (var i = 0; i < R_WHO.length; i++) if (who.trim().toLowerCase().indexOf(R_WHO[i][0]) === 0) { cls = R_WHO[i][1]; break; }
      return '<div class="step ' + cls + '" data-cell="r' + ri + 'c2"><span class="who ' + cls + '">' + esc(who) + '</span><h4>' + rText(tbl, step, 'r' + ri + 'c0') + '</h4><p>' + rText(tbl, what, 'r' + ri + 'c2') + '</p></div>';
    }).join('') + '</div>');
  }
  var R_LEGEND = '<div class="legend"><span class="l-t1">New behaviour</span><span class="l-ex">Existing behaviour</span><span class="l-ai">User step</span><span class="l-rm">Later phase</span></div>';
  function rCardGroup(h, blocks, kicker) {
    var text = h.text || '', kick = '';
    if (kicker && text.indexOf(' \u00B7 ') !== -1) {
      var parts = text.split(' \u00B7 '); kick = '<div class="kicker">' + esc(parts.shift()) + '</div>'; text = parts.join(' \u00B7 ');
    }
    return wrapBlk(h, '<div class="card">' + kick + '<h3>' + rText(h, text) + '</h3>' + blocks.map(rBlock).join('') + '</div>', 'la-cardblk');
  }
  function rSubHead(b) {
    var info = b.info ? '<p>' + inline(b.info) + '</p>' : '';
    return wrapBlk(b, '<div class="sub-head" id="' + esc(b.id) + '"><h3>' + rText(b, b.text || '') + '</h3>' + info + '</div>');
  }
  function rSectionBody(sec) {
    var eb = sec.eyebrow.toLowerCase(), blocks = sec.blocks, out = [], g;
    if (eb.indexOf('purpose') === 0) {
      g = rGroups(blocks); out = g.lead.map(rBlock);
      if (g.groups.length) out.push('<div class="context-strip">' + g.groups.map(function (x) { return rCardGroup(x[0], x[1], true); }).join('') + '</div>');
      return out;
    }
    if (eb.indexOf('problem') === 0) {
      g = rGroups(blocks); out = g.lead.map(rBlock);
      if (g.groups.length) {
        var cards = g.groups.map(function (x) { return rCardGroup(x[0], x[1], false); });
        if (cards.length % 2 === 1) cards[cards.length - 1] = cards[cards.length - 1].replace(/^<div class="([^"]*)"/, '<div class="$1" style="grid-column: 1 / -1"');
        out.push('<div class="grid-2">' + cards.join('') + '</div>');
      }
      return out;
    }
    if (eb.indexOf('scope') === 0) {
      blocks.forEach(function (b) {
        if (b.type === 'table' && String((b.head || [''])[0]).trim().toLowerCase().indexOf('in') === 0) {
          var head = b.head, rows = b.rows || [];
          var cols = head.map(function (h, i) {
            var items = [];
            rows.forEach(function (r, ri) { if (i < r.length && String(r[i]).trim()) items.push('<li data-cell="r' + ri + 'c' + i + '">' + rText(b, r[i], 'r' + ri + 'c' + i) + '</li>'); });
            return '<div class="card ' + (i === 0 ? 'in' : 'out') + '"><h3>' + inline(h) + '</h3><ul>' + items.join('') + '</ul></div>';
          });
          var style = head.length !== 2 ? ' style="grid-template-columns: repeat(' + head.length + ', 1fr)"' : '';
          out.push(wrapBlk(b, '<div class="scope"' + style + '>' + cols.join('') + '</div>'));
        } else if (b.type === 'heading') out.push(rSubHead(b));
        else out.push(rBlock(b));
      });
      return out;
    }
    if (eb.indexOf('user flows') === 0 || eb.indexOf('go to market') === 0) {
      g = rGroups(blocks); out = g.lead.map(rBlock); var any = false;
      g.groups.forEach(function (x) {
        var h = x[0], bs = x[1];
        var intro = bs.filter(function (b) { return !rIsSteps(b); }), steps = bs.filter(rIsSteps);
        var first = intro.length && intro[0].type === 'para' ? intro[0] : null;
        out.push(wrapBlk(h, '<div class="sub-head" id="' + esc(h.id) + '"><h3>' + rText(h, h.text || '') + '</h3></div>'));
        if (first) out.push(wrapBlk(first, '<p class="flow-who">' + rText(first, first.text) + '</p>'));
        steps.forEach(function (st) { out.push(rSteps(st)); any = true; });
        intro.forEach(function (b) { if (b !== first) out.push(rBlock(b)); });
      });
      if (any) out.push(R_LEGEND);
      return out;
    }
    if (eb.indexOf('success measurement') === 0) {
      blocks.forEach(function (b) {
        if (b.type === 'table') {
          var head = b.head || [], ms = [];
          (b.rows || []).forEach(function (r, ri) {
            var how = [];
            for (var i = 1; i < Math.min(head.length, r.length); i++) if (String(r[i]).trim()) how.push(head[i] + ': ' + r[i]);
            ms.push('<div class="metric" data-cell="r' + ri + 'c0"><span class="name">' + rText(b, r[0], 'r' + ri + 'c0') + '</span><span class="how">' + inline(how.join(' \u00B7 ')) + '</span></div>');
          });
          out.push(wrapBlk(b, ms.join('')));
        } else if (b.type === 'para' && /^baseline/i.test(b.text || '')) {
          var t = b.text, k = t.split(':')[0], rest = t.slice(k.length + 1);
          out.push(wrapBlk(b, '<div class="baseline"><b>' + esc(k) + '</b>' + rText(b, rest.trim()) + '</div>'));
        } else if (b.type === 'heading') out.push(rSubHead(b));
        else out.push(rBlock(b));
      });
      return out;
    }
    if (eb.indexOf('unknowns') === 0) {
      var tables = blocks.filter(function (b) { return b.type === 'table'; });
      var pair = tables.length >= 2 && rNarrow(tables[0]) && rNarrow(tables[1]) ? tables.slice(0, 2) : [];
      var i = 0;
      while (i < blocks.length) {
        var b = blocks[i];
        if (pair.length && b === pair[0]) {
          var j = blocks.indexOf(pair[1]);
          out.push('<div class="grid-2">' + rTable(pair[0]) + rTable(pair[1]) + '</div>');
          blocks.slice(i + 1, j).forEach(function (x) { if (x.type !== 'heading') out.push(rBlock(x)); });
          i = j + 1; continue;
        }
        out.push(b.type === 'heading' ? rSubHead(b) : rBlock(b));
        i++;
      }
      return out;
    }
    blocks.forEach(function (b) { out.push(b.type === 'heading' ? rSubHead(b) : rBlock(b)); });
    return out;
  }
  function rSection(sec, tabId) {
    if (sec.internal && !pageEdit) return '';
    var body = rSectionBody(sec);
    if (!body.some(function (x) { return x.trim(); }) && !sec.claim && !pageEdit) return '';
    var head = '';
    if (sec.eyebrow || sec.claim) {
      var inner = '<div class="sec-head">' + (sec.eyebrow ? '<div class="eyebrow">' + esc(sec.eyebrow) + '</div>' : '')
        + (sec.claim ? '<h2>' + (sec.block ? rText(sec.block, sec.claim) : inline(sec.claim)) + '</h2>' : '') + '</div>';
      head = sec.block ? wrapBlk(sec.block, inner, 'la-sechead' + (sec.internal ? ' la-internal' : '')) : inner;
    }
    var bid = sec.bid ? '<span id="' + esc(sec.bid) + '"></span>' : '';
    return '<section id="' + esc(tabId + '-' + sec.id) + '"' + (sec.internal ? ' class="la-internal-sec"' : '') + '><div class="wrap">' + bid + head
      + '<div class="blocks">' + body.join('\n') + '</div></div></section>';
  }
  function rTab(tab, first) {
    var secs = tab.sections.filter(function (s) { return !s.internal || pageEdit; });
    var subnav = secs.filter(function (s) { return s.eyebrow || s.claim; }).map(function (s) {
      return '<a href="#' + esc(tab.id + '-' + s.id) + '">' + esc(s.eyebrow || s.claim) + '</a>';
    }).join('');
    return '<div class="tabpanel" id="' + esc(tab.id) + '" role="tabpanel" aria-labelledby="tab-' + esc(tab.id) + '"' + (first ? '' : ' hidden') + '>'
      + '<span id="' + esc(tab.bid) + '"></span><div class="subnav"><div class="wrap">' + subnav + '</div></div>'
      + tab.sections.map(function (s) { return rSection(s, tab.id); }).join('\n') + '</div>';
  }
  function rHero(hero) {
    var thesis = null, meta = null, needs = null, io = null;
    hero.forEach(function (b) {
      if (!thesis && b.type === 'para') thesis = b;
      if (!meta && b.type === 'table' && String((b.head || [''])[0]).toLowerCase() === 'owner') meta = b;
      if (!needs && b.type === 'callout' && /^the needs/i.test(b.title || '')) needs = b;
      if (!io && b.type === 'table' && (b.head || []).slice(0, 2).map(function (x) { return String(x).toLowerCase(); }).join('|') === 'today|after') io = b;
    });
    var metaRow = '';
    if (meta) {
      var pairs = [[meta.head[0], meta.head[1], 'h1']].concat((meta.rows || []).filter(function (r) { return r.length > 1; }).map(function (r, ri) { return [r[0], r[1], 'r' + ri + 'c1']; }));
      metaRow = wrapBlk(meta, '<div class="meta-row">' + pairs.map(function (kv) { return '<span><b>' + esc(kv[0]) + '</b> ' + rText(meta, kv[1], kv[2]) + '</span>'; }).join('') + '</div>');
    }
    var aside = '';
    if (needs || io || pageEdit) {
      var parts = ['<aside class="question-card">'];
      if (needs) parts.push(wrapBlk(needs, '<div class="label">' + esc(needs.title) + '</div><ul class="qs">' + (needs.text || '').split('\n').filter(function (l) { return l.trim(); }).map(function (l) { return '<li>' + rText(needs, l) + '</li>'; }).join('') + '</ul>'));
      if (io && io.rows && io.rows.length) {
        var r = io.rows[0];
        parts.push(wrapBlk(io, '<div class="io"><div class="box in"><div class="t">Today</div>' + rText(io, r[0], 'r0c0') + '</div><div class="arrow">\u2192</div><div class="box out"><div class="t">After</div>' + rText(io, r[1] || '', 'r0c1') + '</div></div>'));
      }
      hero.forEach(function (b) {
        if (b === thesis || b === meta || b === needs || b === io) return;
        if (b.type === 'para') parts.push(wrapBlk(b, '<p class="note">' + rText(b, b.text) + '</p>'));
        else parts.push(rBlock(b));
      });
      parts.push('</aside>'); aside = parts.join('');
    }
    var date = (model.updated || '').split('\u00B7').pop().trim() || prettyDate();
    return '<header class="hero"><div class="wrap hero-grid"><div>'
      + '<div class="eyebrow">' + esc(model.component || 'Document') + ' \u00B7 ' + esc(date) + '</div>'
      + '<h1>' + esc(model.title) + '<span class="mark" aria-hidden="true"></span></h1>'
      + (thesis ? wrapBlk(thesis, '<p class="thesis">' + rText(thesis, thesis.text) + '</p>') : '') + metaRow + '</div>' + aside + '</div></header>';
  }
  function rFooter(tabs) {
    var annex = null;
    tabs.forEach(function (t) { if (!annex && /^annex/i.test(t.label)) annex = t; });
    if (!annex) return '';
    var cols = [];
    noWrap = true;
    ['decision', 'source'].forEach(function (name) {
      for (var i = 0; i < annex.sections.length; i++) {
        var s = annex.sections[i];
        if ((s.eyebrow + ' ' + s.claim).toLowerCase().indexOf(name) !== -1) {
          cols.push('<div><h4>' + esc(s.eyebrow || s.claim) + '</h4>' + s.blocks.filter(function (b) { return b.type !== 'heading'; }).map(rBlock).join('') + '</div>');
          break;
        }
      }
    });
    noWrap = false;
    return cols.length ? '<footer><div class="wrap cols">' + cols.join('') + '</div></footer>' : '';
  }
  /* ---------------------------------------------------- desk-research */
  /* A second read-mode layout, selected by `template: "desk-research"`: one
     long page, no tabs. Level-2 headings are groups (a rule with a label and
     a nav entry), level-3 headings are sections with an eyebrow over a claim,
     a run of level-4 headings becomes a card grid. Table variants draw stat
     tiles (`stats`), bar rows (`bars`), a numbered ladder (`tiers`) and a
     donut (`donut`); a plain table gets a frozen header, group rows (a row
     whose only text is in its first cell) and pills read off the header. A
     `decision` callout parses its own conventions: "D-1 · question. Open."
     as title, an "**Options:** (a) … (b) …" paragraph, a "**Recommendation:**
     (a) …" paragraph. Everything degrades to plain text when the reader edits
     it into another shape. */
  /* the wordmark, from vpage-triage-package/design/verbolia-logo.png (1415×180); inverted for dark by CSS */
  var DK_LOGO = 'data:image/png;base64,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';
  var DK_TONE = { ok: 'ok', good: 'ok', green: 'ok', yes: 'ok', cheap: 'ok', part: 'part', partial: 'part', yellow: 'part', dear: 'part', no: 'no', bad: 'no', red: 'no', hot: 'hot', orange: 'hot', time: 'hot', mute: 'mute', grey: 'mute', gray: 'mute' };
  function dkTone(s) { return DK_TONE[String(s || '').trim().toLowerCase()] || ''; }
  function dkParas(b, text) {
    return String(text || '').split(/\n\s*\n/).filter(function (x) { return x.trim(); })
      .map(function (x) { return '<p>' + rText(b, x.trim()).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  function dkStats(b) {
    return '<div class="counts">' + (b.rows || []).map(function (r, ri) {
      return '<div class="count ' + dkTone(r[2]) + '" data-cell="r' + ri + 'c0"><b>' + rText(b, r[0] || '', 'r' + ri + 'c0') + '</b><span>' + rText(b, r[1] || '', 'r' + ri + 'c1') + '</span></div>';
    }).join('') + '</div>';
  }
  function dkNum(s) { var m = String(s || '').replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 0; }
  function dkBars(b) {
    var rows = b.rows || [], max = 0;
    rows.forEach(function (r) { max = Math.max(max, dkNum(r[1])); });
    return '<div class="funnel">' + rows.map(function (r, ri) {
      var pct = max ? Math.max(2, Math.round(dkNum(r[1]) / max * 100)) : 0;
      return '<div class="frow" data-cell="r' + ri + 'c0"><div class="fl">' + rText(b, r[0] || '', 'r' + ri + 'c0') + '</div>'
        + '<div class="ft"><i class="' + dkTone(r[3]) + '" style="width:' + pct + '%"></i></div>'
        + '<div class="fn">' + rText(b, r[1] || '', 'r' + ri + 'c1') + '</div>'
        + (r[2] ? '<div class="fsub">' + rText(b, r[2], 'r' + ri + 'c2') + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function dkTiers(b) {
    return '<div class="ladder">' + (b.rows || []).map(function (r, ri) {
      return '<div class="rung ' + dkTone(r[5]) + '" data-cell="r' + ri + 'c1"><div class="t-n">' + rText(b, r[0] || '', 'r' + ri + 'c0') + '</div>'
        + '<div><h3>' + rText(b, r[1] || '', 'r' + ri + 'c1') + '</h3><div class="t-d">' + rText(b, r[2] || '', 'r' + ri + 'c2') + '</div>'
        + (r[6] ? '<div class="bar"><i class="' + dkTone(r[5]) + '" style="width:' + Math.max(0, Math.min(100, dkNum(r[6]))) + '%"></i></div>' : '') + '</div>'
        + '<div class="t-cost">' + rText(b, r[3] || '', 'r' + ri + 'c3') + (r[4] ? '<em>' + rText(b, r[4], 'r' + ri + 'c4') + '</em>' : '') + '</div></div>';
    }).join('') + '</div>';
  }
  var DK_PALETTE = ['ok', 'part', 'no', 'hot', 'mute'];
  function dkDonut(b) {
    var rows = b.rows || [], total = 0;
    rows.forEach(function (r) { total += dkNum(r[1]); });
    var R = 60, C = 2 * Math.PI * R, off = 0, segs = '';
    rows.forEach(function (r, i) {
      var v = total ? dkNum(r[1]) / total : 0, len = v * C;
      var tone = dkTone(r[2]) || DK_PALETTE[i % DK_PALETTE.length];
      segs += '<circle class="c-' + tone + '" cx="85" cy="85" r="' + R + '" fill="none" stroke="currentColor" stroke-width="18" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 85 85)"></circle>';
      off += len;
    });
    var lead = rows.length ? rows[0] : null;
    var centre = lead ? '<text class="big" x="85" y="82" text-anchor="middle">' + esc(total ? Math.round(dkNum(lead[1]) / total * 100) + '%' : '') + '</text><text class="small" x="85" y="100" text-anchor="middle">' + esc(String(lead[0] || '').slice(0, 22)) + '</text>' : '';
    return '<div class="donut"><svg viewBox="0 0 170 170" role="img" aria-label="' + esc(rows.map(function (r) { return r[0] + ' ' + r[1]; }).join(', ')) + '">' + segs + centre + '</svg><ul>'
      + rows.map(function (r, i) {
        var tone = dkTone(r[2]) || DK_PALETTE[i % DK_PALETTE.length];
        return '<li data-cell="r' + i + 'c0"><i class="c-' + tone + '"></i><b>' + rText(b, r[1] || '', 'r' + i + 'c1') + '</b><span>' + rText(b, r[0] || '', 'r' + i + 'c0') + '</span></li>';
      }).join('') + '</ul></div>';
  }
  var DK_OK = /^(now|wired today|high\b|yes|done|decided|live)/i;
  var DK_PART = /^(partial|conditional|interim|by inference|approximable|elsewhere|site-level|unknown|platform (yes|likely)|likely|probably|needs checking|automatable|medium|low to medium|medium to low)/i;
  var DK_NO = /^(not measurable|not from|customer|low\b|blocked|no capability|outside)/i;
  function dkCellHtml(b, head, ci, text, key) {
    var t = String(text == null ? '' : text).trim(), hd = String(head[ci] || '').trim().toLowerCase();
    if (!t) return '';
    if (hd === 'in skill / code' || hd === 'in skill/code') {
      return t.replace(/✓/g, '<span class="yes">✓</span>').replace(/✗/g, '<span class="nope">✗</span>').replace(/≠/g, '<span class="pill part">≠</span>');
    }
    if (hd === 'tier' && t.length <= 4) return '<span class="pill tier">' + esc(t) + '</span>';
    if (hd === 'surface' || hd === 'answers') return t.split(/\s*[·,]\s*/).map(function (x) { return '<span class="pill tier">' + esc(x) + '</span>'; }).join('');
    if (hd === 'effort') return t.split(/\s*\/\s*/).map(function (x) { return '<span class="pill tier">' + esc(x) + '</span>'; }).join('');
    if (hd === 'detectable' || hd === 'actually' || hd === 'reversibility' || hd === 'confidence' || hd === 'status') {
      var cls = DK_OK.test(t) ? 'ok' : DK_PART.test(t) ? 'part' : DK_NO.test(t) ? 'no' : '';
      if (t === 'No change' || t === '—') cls = 'tier';
      if (cls && t.length <= 42) return '<span class="pill ' + cls + '">' + esc(t) + '</span>';
      if (cls) { var cut = t.indexOf(':'); if (cut > 0 && cut < 40) return '<span class="pill ' + cls + '">' + esc(t.slice(0, cut)) + '</span> ' + rText(b, t.slice(cut + 1).trim(), key); }
    }
    return rText(b, t, key);
  }
  function dkCellClass(head, ci, text) {
    var hd = String(head[ci] || '').trim().toLowerCase(), t = String(text || '');
    if (ci === 0 && /^[A-Z][A-Z0-9_]+(\s*\/\s*[A-Z][A-Z0-9_ ]+)?$/.test(t.trim())) return 'flag';
    if (/^(what it is|what it does|reading|meaning|how counted|question|what changed)$/.test(hd)) return 'what';
    if (/^(signal|endpoint|threshold)$/.test(hd)) return 'sig';
    if (hd === 'in skill / code' || hd === 'in skill/code') return 'impl';
    return '';
  }
  function dkGrid(b) {
    var head = b.head || [], rows = b.rows || [], rcols = roleColumns(head), n = head.length;
    var wide = n >= 6, tall = rows.length > 12;
    var out = '<div class="tablewrap' + (wide ? ' wide' : '') + (tall ? '' : ' short') + '"><table>';
    if (head.some(function (h) { return String(h).trim(); })) out += '<thead><tr>' + head.map(function (h) { return '<th>' + inline(h) + '</th>'; }).join('') + '</tr></thead>';
    out += '<tbody>' + rows.map(function (r, ri) {
      var group = n >= 3 && String(r[0] || '').trim() && r.slice(1).every(function (c) { return !String(c || '').trim(); });
      if (group) return '<tr class="grouprow"><td colspan="' + n + '" data-cell="r' + ri + 'c0">' + rText(b, r[0], 'r' + ri + 'c0') + '</td></tr>';
      return '<tr>' + r.map(function (c, ci) {
        var cls = dkCellClass(head, ci, c);
        var html = rcols[ci] ? rCell(b, c, true, 'r' + ri + 'c' + ci) : dkCellHtml(b, head, ci, c, 'r' + ri + 'c' + ci);
        return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + html + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
    return out;
  }
  /* A timeline whose rows stay an editable grid. Columns:
     Lane | Item | Detail | From | To | State | Status | Note
     From/To are week numbers (fractions allowed); an empty To means the item
     carries no end date and is drawn open-ended. State is ok/plan/wait/est.
     Note becomes an ⓘ beside the item, so detail rides with the row it
     describes instead of in a second table. Axis labels come from b.axis. */
  var GT_STATE = { ok: 'ok', done: 'ok', plan: 'plan', scheduled: 'plan', wait: 'wait', blocked: 'wait', est: 'est', open: 'est' };
  function gtState(s) { return GT_STATE[String(s || '').trim().toLowerCase()] || 'plan'; }
  function dkGantt(b) {
    var rows = b.rows || [], ax = b.axis || {}, labels = ax.labels || [];
    var w0 = dkNum(ax.start || 0), n = labels.length || 1;
    function pc(w) { return Math.max(0, Math.min(100, (dkNum(w) - w0) / n * 100)); }
    var lanes = [], seen = {};
    rows.forEach(function (r) { var L = String(r[0] || '').trim(); if (L && !seen[L]) { seen[L] = 1; lanes.push(L); } });
    var head = '<div class="gt-axis">' + labels.map(function (L) {
      return '<div class="gt-w"><b>' + esc(L[0] || '') + '</b><span>' + esc(L[1] || '') + '</span></div>';
    }).join('') + '</div>';
    var today = ax.today != null ? '<i class="gt-today" style="left:' + pc(ax.today).toFixed(2) + '%"><em>today</em></i>' : '';
    var body = lanes.map(function (L) {
      var rs = '';
      rows.forEach(function (r, ri) {
        if (String(r[0] || '').trim() !== L) return;
        var st = gtState(r[5]), open = !String(r[4] || '').trim();
        var a = pc(r[3]), z = open ? 100 : pc(r[4]), wd = Math.max(1.2, z - a);
        var note = String(r[7] || '').trim();
        rs += '<div class="gt-row" data-cell="r' + ri + 'c1">'
          + '<div class="gt-lab"><b>' + rText(b, r[1] || '', 'r' + ri + 'c1')
          + (note ? '<i class="gt-i" tabindex="0" role="button" aria-label="More about ' + esc(r[1] || '') + '">i<span class="gt-pop">' + rText(b, note, 'r' + ri + 'c7') + '</span></i>' : '')
          + '</b><span>' + rText(b, r[2] || '', 'r' + ri + 'c2') + '</span></div>'
          + '<div class="gt-track">'
          + '<div class="gt-bar ' + st + (open ? ' open' : '') + '" style="left:' + a.toFixed(2) + '%;width:' + wd.toFixed(2) + '%"></div>'
          + '<span class="gt-st ' + st + '" style="left:' + (open ? a + 1.4 : z).toFixed(2) + '%">' + rText(b, r[6] || '', 'r' + ri + 'c6') + '</span>'
          + '</div></div>';
      });
      return '<div class="gt-lane"><h4>' + esc(L) + '</h4>' + rs + '</div>';
    }).join('');
    return '<div class="gt">' + head + '<div class="gt-body">'
      + '<div class="gt-grid">' + labels.map(function () { return '<i></i>'; }).join('') + today + '</div>'
      + body + '</div></div>';
  }
  function dkTable(b) {
    switch (b.variant) {
      case 'gantt': return dkGantt(b);
      case 'stats': return dkStats(b);
      case 'bars': return dkBars(b);
      case 'tiers': return dkTiers(b);
      case 'donut': return dkDonut(b);
      default: return dkGrid(b);
    }
  }
  function dkDecision(b) {
    var title = String(b.title || ''), m = title.match(/^([A-Z]{1,2}-\d+)\s*[·:]\s*([\s\S]*)$/), id = m ? m[1] : '', q = m ? m[2] : title;
    var status = /\b(decided|answered|closed)\b/i.test(q) ? 'ok' : /\bopen\b/i.test(q) ? 'part' : '';
    var label = status === 'ok' ? (/answered/i.test(q) ? 'Answered' : 'Decided') : status === 'part' ? 'Open' : '';
    q = q.replace(/\s*\b(Open|Decided|Answered|Closed)\b[^.]*\.?\s*$/i, '').replace(/\s*\.\s*$/, '');
    var paras = String(b.text || '').split(/\n\s*\n/).filter(function (x) { return x.trim(); }), body = '', opts = '', rec = '';
    paras.forEach(function (ptxt) {
      var s = ptxt.trim();
      if (/^\*\*Options:?\*\*/i.test(s)) {
        var rest = s.replace(/^\*\*Options:?\*\*\s*/i, ''), parts = rest.split(/\s*\(([a-z])\)\s*/).slice(1), items = [];
        for (var i = 0; i + 1 < parts.length; i += 2) items.push([parts[i], parts[i + 1].replace(/[;.]\s*$/, '')]);
        opts = items;
      } else if (/^\*\*Recommendation:?\*\*/i.test(s)) rec = s.replace(/^\*\*Recommendation:?\*\*\s*/i, '');
      else body += '<p>' + rText(b, s).replace(/\n/g, '<br>') + '</p>';
    });
    var recLetter = (rec.match(/\(([a-z])\)/) || [])[1];
    var html = '<div class="decision' + (status === 'ok' ? ' decided' : '') + '"><div class="q">' + (id ? '<b>' + esc(id) + '</b>' : '') + '<span>' + rText(b, q) + '</span>' + (label ? '<span class="pill ' + status + '">' + label + '</span>' : '') + '</div>' + body;
    if (opts && opts.length) html += '<div class="opts">' + opts.map(function (o) { return '<span class="opt' + (o[0] === recLetter ? ' rec' : '') + '"><b>' + esc(o[0]) + '</b>' + rText(b, o[1]) + '</span>'; }).join('') + '</div>';
    if (rec) html += '<p class="recline"><b>Recommendation</b> ' + rText(b, rec) + '</p>';
    return html + '</div>';
  }
  function dkCallout(b) {
    var v = b.variant || 'note', title = b.title || '';
    if (v === 'decision') return dkDecision(b);
    if (v === 'warning' || v === 'excluded') return '<div class="blind"><h3>' + rText(b, title) + '</h3>' + dkParas(b, b.text) + '</div>';
    if (/not part of/i.test(title) || /^round/i.test(title)) return '<div class="roundnote"><h3>' + rText(b, title) + '</h3>' + dkParas(b, b.text) + '</div>';
    return '<div class="notebox">' + (title ? '<h3>' + rText(b, title) + '</h3>' : '') + dkParas(b, b.text) + '</div>';
  }
  function dkBlock(b, eb) {
    if (b.type === 'table') return wrapBlk(b, dkTable(b));
    if (b.type === 'callout') return wrapBlk(b, dkCallout(b));
    if (b.type === 'list' && b.ordered && eb.indexOf('recommendation') === 0) return wrapBlk(b, '<div class="rec-box">' + rBlockInner(b) + '</div>');
    if (b.type === 'list' && eb.indexOf('source') === 0) return wrapBlk(b, '<div class="foot">' + rBlockInner(b) + '</div>');
    if (b.type === 'heading') return wrapBlk(b, '<div class="sub-head" id="' + esc(b.id) + '"><h3>' + rText(b, b.text || '') + '</h3></div>');
    if (b.type === 'para' && /^\*\*[^*]+\*\*/.test(String(b.text || '')) && eb.indexOf('legend') === -1 && /^\*\*(tier|effort|in skill)/i.test(String(b.text || ''))) return wrapBlk(b, '<p class="legend">' + rText(b, b.text) + '</p>');
    return rBlock(b);
  }
  function dkBody(sec) {
    var eb = (sec.eyebrow || '').toLowerCase(), g = rGroups(sec.blocks);
    var out = g.lead.map(function (b) { return dkBlock(b, eb); });
    if (g.groups.length >= 2 && g.groups.every(function (x) { return headingLevel(x[0]) === 4; })) {
      out.push('<div class="gaps">' + g.groups.map(function (x) {
        return wrapBlk(x[0], '<div class="gcard"><h3>' + rText(x[0], x[0].text || '') + '</h3>' + x[1].map(function (b) { return dkBlock(b, eb); }).join('') + '</div>', 'la-cardblk');
      }).join('') + '</div>');
      return out;
    }
    g.groups.forEach(function (x) { out.push(dkBlock(x[0], eb)); x[1].forEach(function (b) { out.push(dkBlock(b, eb)); }); });
    return out;
  }
  function dkSection(sec, tabId) {
    if (sec.internal && !pageEdit) return '';
    var head = '';
    if (sec.eyebrow || sec.claim) {
      var hot = /added|corrected|round|new in/i.test(sec.eyebrow) ? ' hot' : '';
      var info = sec.block && sec.block.info ? '<p class="note">' + inline(sec.block.info) + '</p>' : '';
      head = wrapBlk(sec.block, '<div class="sec-head">' + (sec.eyebrow ? '<p class="eyebrow' + hot + '">' + esc(sec.eyebrow) + '</p>' : '') + (sec.claim ? '<h2>' + rText(sec.block, sec.claim) + '</h2>' : '') + info + '</div>', 'la-sechead');
    }
    return '<section id="' + esc(tabId + '-' + sec.id) + '">' + (sec.bid ? '<span id="' + esc(sec.bid) + '"></span>' : '') + head + dkBody(sec).join('\n') + '</section>';
  }
  function readHtmlDesk() {
    var split = rSplit(model.blocks), tabs = split.tabs, hero = split.hero;
    var date = (model.updated || '').split('·').pop().trim() || prettyDate();
    var thesis = null, meta = null, needs = null, rest = [];
    hero.forEach(function (b) {
      if (!thesis && b.type === 'para') thesis = b;
      else if (!meta && b.type === 'table' && String((b.head || [''])[0]).toLowerCase() === 'owner') meta = b;
      else if (!needs && b.type === 'callout' && /^the needs/i.test(b.title || '')) needs = b;
      else rest.push(b);
    });
    var h = '<header class="top"><img class="logo" src="' + DK_LOGO + '" alt="Verbolia">'
      + '<p class="eyebrow">' + esc(model.component || 'Document') + ' · ' + esc(date) + '</p><h1>' + esc(model.title) + '</h1>'
      + (thesis ? wrapBlk(thesis, '<p class="lede">' + rText(thesis, thesis.text) + '</p>') : '');
    if (meta) {
      var pairs = [[meta.head[0], meta.head[1], 'h1']].concat((meta.rows || []).filter(function (r) { return r.length > 1; }).map(function (r, ri) { return [r[0], r[1], 'r' + ri + 'c1']; }));
      h += wrapBlk(meta, '<div class="meta-row">' + pairs.map(function (kv) { return '<span><b>' + esc(kv[0]) + '</b> ' + rText(meta, kv[1], kv[2]) + '</span>'; }).join('') + '</div>');
    }
    if (needs) h += wrapBlk(needs, '<div class="needs"><span class="eyebrow">' + esc(needs.title) + '</span><ul>' + (needs.text || '').split('\n').filter(function (l) { return l.trim(); }).map(function (l) { return '<li>' + rText(needs, l) + '</li>'; }).join('') + '</ul></div>');
    rest.forEach(function (b) { h += dkBlock(b, ''); });
    h += '</header>';
    var nav = tabs.map(function (t) { var first = t.sections[0]; return '<a href="#' + esc(first ? t.id + '-' + first.id : t.id) + '">' + esc(t.label) + '</a>'; }).join('');
    var top = '<div class="topbar"><div class="wrap"><div class="brand"><span class="dot"></span>Verbolia <span class="sep">/</span> <span class="doc">' + esc(model.component || 'Document') + '</span></div><nav class="sections">' + nav + '</nav></div></div>';
    var body = tabs.map(function (t) {
      return '<div class="group" id="' + esc(t.id) + '">' + wrapBlk(t.block, '<div class="group-head"><span id="' + esc(t.bid) + '"></span>' + rText(t.block, t.label) + '</div>')
        + t.sections.map(function (s) { return dkSection(s, t.id); }).join('\n') + '</div>';
    }).join('\n');
    return top + '<div class="wrap">' + h + body + '</div>';
  }
  function readHtml() {
    if (model.template === 'desk-research') return readHtmlDesk();
    var split = rSplit(model.blocks), tabs = split.tabs;
    var tabBtns = tabs.map(function (t, i) {
      return '<button type="button" role="tab" id="tab-' + esc(t.id) + '" aria-controls="' + esc(t.id) + '" aria-selected="' + (i === 0 ? 'true' : 'false') + '"' + (i === 0 ? '' : ' tabindex="-1"') + '>' + esc(t.label) + '</button>';
    }).join('');
    var html = '<div class="topbar"><div class="wrap"><div class="brand"><span class="dot"></span>Verbolia <span class="sep">/</span> <span class="doc">' + esc(model.component || 'Document') + '</span></div>'
      + '<div class="tabs" role="tablist" aria-label="Document tabs">' + tabBtns + '</div></div></div>'
      + rHero(split.hero)
      + tabs.map(function (t, i) { return rTab(t, i === 0); }).join('\n')
      + rFooter(tabs);
    /* a link into a section this view does not show is unwrapped to its words */
    var ids = {};
    html.replace(/id="([^"]+)"/g, function (_, id) { ids[id] = 1; return _; });
    html = html.replace(/<a href="#([^"]+)">([\s\S]*?)<\/a>/g, function (m0, id, text) { return ids[id] ? m0 : text; });
    return html;
  }

  /* --- editing in the page --------------------------------------------- */
  function rBlkNode(id) { return document.querySelector('.la-blk[data-block-id="' + id + '"]'); }
  /* the same chrome and the same editors as the outline, attached to the
     rendered blocks after the fact */
  function dressBlocks(house) {
    var blks = [].slice.call(house.querySelectorAll('.la-blk'));
    blks.forEach(function (node) {
      var b = getBlock(node.dataset.blockId); if (!b) return;
      if (b.touched) node.dataset.touched = b.touched.by === 'claude' ? 'claude' : 'viewer';
      if (changedWhole(b)) node.dataset.changed = 'all';
      node.insertBefore(renderChrome(b), node.firstChild);
      if (b.note) {
        var n = el('div', 'la-note' + (b.noteDone ? ' done' : ''));
        n.appendChild(el('b', null, b.noteDone ? 'note handled' : 'note to claude'));
        n.appendChild(document.createTextNode(b.note));
        if (b.noteDone) n.appendChild(el('div', 'la-note-a', b.noteDone));
        node.insertBefore(n, node.children[1] || null);
      }
      if (editing === b.id) {
        /* the editor takes the block's place; chrome and note stay above it */
        [].slice.call(node.children).forEach(function (c) {
          if (!c.classList || !(c.classList.contains('la-handle') || c.classList.contains('la-acts') || c.classList.contains('la-note'))) node.removeChild(c);
        });
        node.appendChild(renderEditor(b));
        node.classList.add('la-editing');
        return;
      }
      if (b.type === 'table') {
        /* a flow step, a scope item, a metric row: cells drawn as something
           other than a table still take a note each */
        [].slice.call(node.querySelectorAll('[data-cell]')).forEach(function (cellNode) {
          if (cellNode.closest('.la-blk') !== node) return;
          cellNode.style.position = 'relative';
          cellNoteUi(cellNode, b, cellNode.dataset.cell, false);
        });
        var tbl = node.querySelector('table');
        if (tbl) {
          [].slice.call(tbl.querySelectorAll('thead th')).forEach(function (th, ci) { cellNoteUi(th, b, 'h' + ci, false); });
          [].slice.call(tbl.querySelectorAll('tbody tr')).forEach(function (tr, ri) {
            [].slice.call(tr.children).forEach(function (td, ci) { cellNoteUi(td, b, 'r' + ri + 'c' + ci, false); });
          });
        }
      }
      if ((b.tags && b.tags.length) || (b.marks && b.marks.length)) node.appendChild(renderMeta(b));
      if (inGrid(node) && b.type !== 'divider') {
        var rz = el('button', 'la-resize');
        rz.title = 'Drag to resize: a quarter, a third, a half, two thirds or the full width';
        rz.setAttribute('aria-label', rz.title);
        rz.addEventListener('pointerdown', function (e) { startResize(e, b, node); });
        rz.addEventListener('click', function (e) { e.stopPropagation(); });
        rz.addEventListener('keydown', function (e) {
          var cur = WIDTHS.indexOf((b.layout && b.layout.w) || 'full');
          if (e.key === 'ArrowLeft' && cur > 0) { e.preventDefault(); setWidth(b, WIDTHS[cur - 1], node, WIDTHS[cur]); }
          if (e.key === 'ArrowRight' && cur < WIDTHS.length - 1) { e.preventDefault(); setWidth(b, WIDTHS[cur + 1], node, WIDTHS[cur]); }
        });
        node.appendChild(rz);
      }
      if (b.type !== 'divider' && b.type !== 'raw') {
        node.title = '';
        node.addEventListener('click', function (e) {
          if (!e.target.closest) return;
          if (e.target.closest('a, .la-cite, .la-cite-pop, .la-handle, .la-acts, .la-resize, .la-note, .la-cellpin, .la-cellnote, .la-cellnoteform, .la-meta, .la-addhouse, [role="tab"]')) return;
          if (placing) return;
          /* a click inside a nested block belongs to that block */
          if (e.target.closest('.la-blk') !== node) return;
          var sel = window.getSelection && window.getSelection();
          if (sel && String(sel).trim().length) return;
          editing = b.id; tagging = null; tagQuote = null; render();
        });
      }
      if (!matchesFilter(b)) node.hidden = true;
    });
  }
  function newBlock(t) {
    var b = { id: uid('b'), type: t, author: 'viewer', tags: [] };
    if (t === 'heading') { b.text = 'New heading'; b.level = 2; }
    else if (t === 'list') b.items = ['New item'];
    else if (t === 'table') { b.head = ['Column']; b.rows = [['value']]; }
    else if (t === 'callout') { b.title = 'Note'; b.text = 'New callout'; }
    else if (t === 'mermaid') b.text = 'flowchart LR\n  A[Start] --> B[Next]';
    else if (t === 'figure') { b.caption = 'What this figure should show'; b.labels = {}; }
    else if (t !== 'divider') b.text = 'New ' + t;
    return b;
  }

  function renderRead(root) {
    pageEdit = !readOnly && mode === 'page';
    var scroll = window.scrollY;
    root.textContent = '';
    var house = el('div', 'house' + (model.template === 'desk-research' ? ' desk' : '') + (pageEdit ? ' la-page' : ''));
    house.innerHTML = readHtml();
    root.appendChild(house);
    if (pageEdit) dressBlocks(house);
    wireRead(house);
    var pill = document.getElementById('la-modepill'); if (pill) pill.remove();
    if (!readOnly) renderBar();
    else { var bar = document.getElementById('la-bar'); if (bar) bar.remove(); }
    /* diagrams: drawn by the same loader the outline uses */
    [].forEach.call(house.querySelectorAll('pre.mermaid'), function (pre) {
      var code = pre.textContent;
      loadMermaid().then(function (mm) { return mm.render('la-rd-' + (++mermaidSeq), code); })
        .then(function (res) { var svg = res && res.svg ? res.svg : String(res); pre.outerHTML = svg; })
        .catch(function () { /* the source stays readable */ });
    });
    if (typeof window.scrollTo === 'function' && window.scrollY !== scroll) {
      try { window.scrollTo(0, scroll); } catch (e) { /* unsupported */ }
    }
  }
  function wireRead(house) {
    var tabs = [].slice.call(house.querySelectorAll('[role="tab"]'));
    var panels = [].slice.call(house.querySelectorAll('[role="tabpanel"]'));
    /* `byUser` gates the hash. Writing a fragment while the page is still
       loading makes the browser scroll to it as part of load, which opened
       every document scrolled a screen down with the hero out of sight. The
       hash is written only for a click, never for the opening render. */
    function select(id, byUser) {
      var found = false;
      panels.forEach(function (p) { var on = p.id === id; p.hidden = !on; if (on) found = true; });
      tabs.forEach(function (t) {
        var on = t.getAttribute('aria-controls') === id;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) t.removeAttribute('tabindex'); else t.setAttribute('tabindex', '-1');
      });
      if (found) activeTab = id;
      if (found && byUser && history.replaceState) history.replaceState(null, '', '#' + id);
      spy();
      return found;
    }
    function goTo(hash, byUser) {
      var id = String(hash || '').replace(/^#/, ''); if (!id) return false;
      if (panels.some(function (p) { return p.id === id; })) { select(id, byUser); return true; }
      var target = house.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/([^\w-])/g, '\\$1')));
      if (!target) return false;
      var panel = target.closest('[role="tabpanel"]');
      if (panel && panel.hidden) select(panel.id, byUser);
      if (byUser && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(tab.getAttribute('aria-controls'), true); });
      tab.addEventListener('keydown', function (e) {
        var step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!step) return;
        e.preventDefault(); var next = tabs[(i + step + tabs.length) % tabs.length]; next.focus(); next.click();
      });
    });
    house.addEventListener('click', function (e) {
      var link = e.target.closest && e.target.closest('a[href^="#"]');
      if (!link) return;
      if (goTo(link.getAttribute('href'), true)) e.preventDefault();
    });
    var ticking = false;
    function offsetTop() {
      var bar = house.querySelector('.topbar'), nav = house.querySelector('[role="tabpanel"]:not([hidden]) .subnav');
      return (bar ? bar.offsetHeight : 0) + (nav ? nav.offsetHeight : 0) + 8;
    }
    function spy() {
      ticking = false;
      var panel = null; panels.forEach(function (p) { if (!panel && !p.hidden) panel = p; });
      var links = panel ? [].slice.call(panel.querySelectorAll('.subnav a[href^="#"]'))
        : [].slice.call(house.querySelectorAll('.topbar nav.sections a[href^="#"]'));
      if (!links.length) return;
      var y = window.pageYOffset + offsetTop(), active = null, prog = 0;
      links.forEach(function (a, i) {
        var s = house.querySelector('#' + a.getAttribute('href').slice(1).replace(/([^\w-])/g, '\\$1')); if (!s) return;
        var top = s.getBoundingClientRect().top + window.pageYOffset, h = s.offsetHeight || 1;
        if (top <= y) { active = i; prog = Math.max(0, Math.min(1, (y - top) / h)); }
      });
      if (active === null) { active = 0; prog = 0; }
      links.forEach(function (a, i) {
        var on = i === active;
        a.classList.toggle('active', on);
        a.style.setProperty('--p', on ? prog.toFixed(3) : (i < active ? '1' : '0'));
        a.classList.toggle('passed', i < active);
      });
    }
    function schedule() { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    /* the tab that was open stays open across a re-render */
    if (activeTab && panels.some(function (p) { return p.id === activeTab; })) select(activeTab, false);
    else if (!goTo(location.hash, false) && panels.length) select(panels[0].id, false);
  }

  /* ---------------------------------------------------------------- export */
  /* A plain document, not a tool: no editor, no model, no db — which is also
     what makes it shareable at all, since a db artifact is org-internal. */
  /* The shareable copy is read, not driven, so it is laid out as tabs: one per
     top-level section, only one open at a time. Folding earns its place in the
     living document because a reader is hunting for one section to edit; a
     reader of the export wants a short page per subject. Anchors inside a
     hidden tab still work: the script opens the tab that holds the target. */
  function prettyDate() {
    var M = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
             'August', 'September', 'October', 'November', 'December'];
    var d = new Date();
    return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear();
  }

  function staticTabs(blocks) {
    var tabs = [], cur = null;
    blocks.forEach(function (b) {
      if (headingLevel(b) === 2) {
        cur = { id: b.id, title: b.text || 'Section', blocks: [] };
        tabs.push(cur);
      } else {
        if (!cur) { cur = { id: 'front', title: 'Summary', blocks: [] }; tabs.push(cur); }
        cur.blocks.push(b);
      }
    });
    return tabs.filter(function (t) { return t.blocks.length; });
  }

  /* In the export a sub-section is a card, because the page is read rather than
     edited: cards give a scan order that a column of prose does not. A card
     holding nothing but short text may share a row; anything with a table, a
     figure or a diagram takes the full width, because those break when squeezed. */
  /* Each tab opens with a row of jump links, one per sub-section, named by the
     section's label where it has one. The claim makes a poor pill: it is a
     sentence. That is what the label is for. */
  function staticSubnav(blocks) {
    var links = blocks.filter(function (b) { return b.type === 'heading'; })
      .map(function (b) {
        return '<a href="#' + esc(b.id) + '">' + esc(b.eyebrow || b.text || 'Section') + '</a>';
      });
    return links.length > 1 ? '<nav class="la-subnav">' + links.join('') + '</nav>' : '';
  }

  function staticCards(blocks) {
    var groups = [], cur = null;
    blocks.forEach(function (b) {
      if (b.type === 'heading') { cur = { head: b, blocks: [] }; groups.push(cur); }
      else {
        if (!cur) { cur = { head: null, blocks: [] }; groups.push(cur); }
        cur.blocks.push(b);
      }
    });
    var WIDE = { table: 1, figure: 1, mermaid: 1, code: 1, raw: 1 };
    return '<div class="la-cards">' + groups.map(function (g) {
      var host = el('div');
      if (g.head) host.appendChild(renderBody(g.head, true));
      var chars = 0, wide = false;
      g.blocks.forEach(function (b) {
        if (WIDE[b.type]) wide = true;
        chars += (b.text || '').length + (b.items || []).join(' ').length;
        host.appendChild(renderBody(b, true));
      });
      var half = !wide && chars < 420 && g.head;
      return '<div class="la-card' + (half ? ' half' : '') + '">' + host.innerHTML + '</div>';
    }).join('') + '</div>';
  }

  function buildStatic(blocks, labels) {
    var css = document.getElementById(STYLE_EL).textContent;
    var tabs = staticTabs(blocks);
    var note = labels.length
      ? '<p class="la-updated">Labelled ' + labels.map(function (l) { return '#' + esc(l); }).join(', ')
        + ' \u00B7 ' + blocks.length + ' of ' + model.blocks.length + ' sections</p>'
      : '';
    var bar = '', panels = '';
    tabs.forEach(function (t, i) {
      var pid = 'p-' + t.id, tid = 't-' + t.id;
      bar += '<button role="tab" id="' + esc(tid) + '" aria-controls="' + esc(pid) + '"'
        + ' aria-selected="' + (i === 0 ? 'true' : 'false') + '">' + esc(t.title) + '</button>';
      panels += '<section role="tabpanel" id="' + esc(pid) + '" aria-labelledby="' + esc(tid) + '"'
        + (i === 0 ? '' : ' hidden') + '><h2 class="la-tabtitle">' + esc(t.title) + '</h2>'
        + staticSubnav(t.blocks) + staticCards(t.blocks) + '</section>';
    });
    var js = 'var bs=[].slice.call(document.querySelectorAll(\'[role=tab]\'));'
      + 'function open(id){bs.forEach(function(b){var on=b.id===id;'
      + 'b.setAttribute("aria-selected",on?"true":"false");'
      + 'document.getElementById(b.getAttribute("aria-controls")).hidden=!on;});'
      + 'if(history.replaceState)history.replaceState(null,"","#"+id.slice(2));}'
      + 'bs.forEach(function(b,i){b.onclick=function(){open(b.id);};'
      + 'b.onkeydown=function(e){var d=e.key==="ArrowRight"?1:e.key==="ArrowLeft"?-1:0;'
      + 'if(!d)return;e.preventDefault();var n=bs[(i+d+bs.length)%bs.length];n.focus();open(n.id);};});'
      /* a link into a closed tab opens that tab first */
      + 'document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest(\'a[href^="#"]\');'
      + 'if(!a)return;var id=a.getAttribute("href").slice(1);'
      + 'var t=document.getElementById(id);if(!t)return;'
      /* every in-page link is handled here, so the scroll is smooth whether or
         not the target was already on screen */
      + 'e.preventDefault();goto(id,true);history.replaceState(null,"","#"+id);});'
      /* Measured, never assumed: the tab bar wraps on a narrow window and any
         hardcoded offset then drops the target under it. */
      + 'function bars(){var tb=document.querySelector(".la-tabbar");'
      + 'var sn=document.querySelector("[role=tabpanel]:not([hidden]) .la-subnav");'
      + 'var t=tb?tb.getBoundingClientRect().height:0;'
      + 'var n=sn?sn.getBoundingClientRect().height:0;'
      + 'document.documentElement.style.setProperty("--tabbar-h",t+"px");'
      + 'document.documentElement.style.setProperty("--sticky-h",(t+n)+"px");}'
      + 'bars();window.addEventListener("resize",bars);'
      /* A link may name a tab or a section inside one. Either way, open the
         panel that holds it before trying to scroll to it. */
      + 'function goto(id,smooth){var el=document.getElementById(id);'
      + 'var tb=document.getElementById("t-"+id);'
      + 'if(tb){open(tb.id);bars();return true;}'
      + 'if(!el)return false;var p=el.closest("[role=tabpanel]");'
      + 'if(p&&p.hidden)open(p.getAttribute("aria-labelledby"));'
      /* Instant on arrival, smooth when a reader clicks: animating a page the
         reader has only just opened is motion they did not ask for, and it
         lands them mid-flight when the document is long. */
      + 'bars();if(el.scrollIntoView)el.scrollIntoView(smooth?{behavior:"smooth"}:{behavior:"auto"});'
      + 'return true;}'
      + 'if(location.hash)goto(location.hash.slice(1));'
      /* which section the reader is in. Observed rather than computed on scroll,
         and the topmost heading still above the fold line wins, so the mark does
         not flicker between two headings sharing the viewport. */
      + 'var links=[].slice.call(document.querySelectorAll(".la-subnav a"));'
      + 'var byId={};links.forEach(function(a){byId[a.getAttribute("href").slice(1)]=a;});'
      + 'var seen={};'
      + 'if(window.IntersectionObserver){'
      + 'var io=new IntersectionObserver(function(es){'
      + 'es.forEach(function(e){seen[e.target.id]=e.isIntersecting?e.boundingClientRect.top:null;});'
      + 'var best=null,bt=1e9;'
      + 'Object.keys(seen).forEach(function(k){var v=seen[k];'
      + 'if(v!==null&&v<bt&&byId[k]&&byId[k].offsetParent){bt=v;best=k;}});'
      + 'links.forEach(function(a){a.classList.remove("here");});'
      + 'if(best&&byId[best])byId[best].classList.add("here");'
      + '},{rootMargin:"-120px 0px -70% 0px"});'
      + 'links.forEach(function(a){var t=document.getElementById(a.getAttribute("href").slice(1));'
      + 'if(t)io.observe(t);});}'
      /* clicking a link marks it at once, before any scrolling happens */
      + 'links.forEach(function(a){a.addEventListener("click",function(){'
      + 'links.forEach(function(x){x.classList.remove("here");});a.classList.add("here");});});'
      /* Some artifact surfaces draw a mermaid source block themselves and some
         leave it as text, and a shared copy is read in whichever one the reader
         opens. So load mermaid a beat after the page, and draw only the blocks
         still sitting there as source: where the surface already drew them this
         finds nothing, and where the script cannot load the source stays
         readable, which is why the block is a pre in the first place. */
      + 'function md(){var ns=[].slice.call(document.querySelectorAll("pre.mermaid"))'
      + '.filter(function(n){return !n.dataset.drawn&&!n.querySelector("svg");});'
      + 'if(!ns.length||!window.mermaid)return;'
      + 'var t=document.documentElement.getAttribute("data-theme");'
      + 'var dk=t?t==="dark":!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);'
      + 'try{window.mermaid.initialize({startOnLoad:false,securityLevel:"strict",'
      + 'theme:dk?"dark":"default",fontFamily:getComputedStyle(document.body).fontFamily});'
      + 'ns.forEach(function(n){n.dataset.drawn="1";});window.mermaid.run({nodes:ns});}catch(e){}}'
      + 'if(document.querySelector("pre.mermaid")){setTimeout(function(){'
      + 'var s=document.createElement("script");'
      + 's.src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js";'
      + 's.onload=md;document.head.appendChild(s);},400);}';
    var S = '<' + 'script', E = '<' + '/' + 'script>';
    /* Its own name in the gallery: a share copy sitting there under the same
       title as the living document is indistinguishable from it, and the one
       that can be edited is the one that must be easy to find. */
    var shareTitle = model.title + (labels.length
      ? ', ' + labels.map(function (l) { return '#' + l; }).join(' ')
      : ', shared copy');
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<title>' + esc(shareTitle) + '</title>\n'
      + '<style>\n' + css + '\n</style>\n</head>\n<body>\n'
      + '<div class="la-shell la-export"><header class="la-head"><p class="la-kicker">'
      /* the reader of a shared copy needs what it is and when it was cut, not
         the working note about which round produced it */
      + esc(model.component || 'Document') + ' \u00B7 ' + esc(prettyDate()) + '</p>'
      + '<h1 class="la-title">' + esc(model.title) + '</h1>' + note + '</header>'
      + '<nav class="la-tabbar" role="tablist">' + bar + '</nav>'
      + '<div class="la-blocks">' + panels + '</div></div>\n'
      + S + '>' + js + E + '\n</body>\n</html>\n';
  }

  /* The whole living document, editor and all, straight to disk. Distinct from
     buildFilteredVersion(), which strips the editor for sharing. This one is
     the no-lock-in escape hatch: a complete self-contained copy, any time, with
     no session and no platform in the path. */
  async function downloadDocument() {
    var html;
    if (modelSource === 'file') {
      /* The document IS the model. The runtime that draws it lives in the
         design system, and in git. */
      var dlm = null;
      try { dlm = await claude.use('downloads'); } catch (e) { /* not granted */ }
      if (!dlm) return status('Downloading is not available in this view.', true);
      try {
        await dlm.save({ filename: model.docId + '-rev' + model.rev + '.model.js', data: modelJs() });
        return status('Saved the model of rev ' + model.rev + ' to your disk.');
      } catch (e) {
        if (e && e.code === 'cancelled') return status('Download cancelled.');
        return status('Download failed (' + ((e && e.code) || 'unknown') + ').', true);
      }
    }
    try { html = buildDocument(); }
    catch (e) { return status('Could not build the document: ' + e.message, true); }
    var dl = null;
    try { dl = await claude.use('downloads'); } catch (e) { /* not granted */ }
    if (!dl) return status('Downloading is not available in this view.', true);
    try {
      await dl.save({ filename: model.docId + '-rev' + model.rev + '.html', data: html });
      status('Saved a full copy of rev ' + model.rev + ' to your disk.');
    } catch (e) {
      if (e && e.code === 'cancelled') return status('Download cancelled.');
      status('Download failed (' + ((e && e.code) || 'unknown') + ').', true);
    }
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
    ['para', 'heading', 'list', 'callout', 'code', 'table', 'mermaid', 'figure', 'divider']
      .forEach(function (t) {
      var x = el('button', 'la-btn', t);
      x.onclick = function () {
        var b = { id: uid('b'), type: t, author: 'viewer', tags: [] };
        if (t === 'heading') { b.text = 'New heading'; b.level = 2; }
        if (t === 'heading') delete collapsed[b.id];
        else if (t === 'list') b.items = ['New item'];
        else if (t === 'table') { b.head = ['Column']; b.rows = [['value']]; }
        else if (t === 'callout') { b.title = 'Note'; b.text = 'New callout'; }
        else if (t === 'mermaid') b.text = 'flowchart LR\n  A[Start] --> B[Next]';
        /* A figure with no picture is a legitimate thing to add: it is how the
           reader asks for one, with the caption saying what it should show. */
        else if (t === 'figure') { b.caption = 'What this figure should show'; b.labels = {}; }
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
    if (!readOnly && mode === 'preview') {
      /* previewing: the same bar, reduced to the toggle and the download */
      st.textContent = 'Previewing · this is the page a reader gets';
      bar.appendChild(modeToggle());
      var dlp = el('button', 'la-btn', '⤓');
      dlp.title = 'Download the full editable document to your disk';
      dlp.onclick = function () { downloadDocument(); };
      bar.appendChild(dlp);
      return;
    }
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
      /* Expand and Collapse walk the hierarchy one level at a time: Expand opens
         the shallowest level that still has a closed section, Collapse closes the
         deepest level that still has an open one. Shift-click does everything at
         once. Folding stays a view: none of this reaches the model. */
      var levels = {}, anyHead = false;
      model.blocks.forEach(function (b) {
        var l = headingLevel(b); if (!l) return;
        anyHead = true;
        var st = levels[l] || (levels[l] = { open: 0, closed: 0 });
        if (collapsed[b.id]) st.closed++; else st.open++;
      });
      var lv = Object.keys(levels).map(Number).sort();
      var nextOpen = lv.filter(function (l) { return levels[l].closed; })[0];
      var nextClose = lv.filter(function (l) { return levels[l].open; }).slice(-1)[0];
      var exp = null, col = null;
      if (anyHead) {
        exp = el('button', 'la-btn', 'Expand ▸');
        exp.title = nextOpen ? 'Open the next level (level ' + nextOpen + '). Shift-click opens everything' : 'Everything is open';
        exp.disabled = !nextOpen;
        exp.onclick = function (e) {
          if (e.shiftKey) setAllFolded(false);
          else eachHeading(function (b) { if (headingLevel(b) === nextOpen) delete collapsed[b.id]; });
          render();
        };
        col = el('button', 'la-btn', 'Collapse ▾');
        col.title = nextClose ? 'Close the deepest open level (level ' + nextClose + '). Shift-click closes everything' : 'Everything is closed';
        col.disabled = !nextClose;
        col.onclick = function (e) {
          if (e.shiftKey) setAllFolded(true);
          else eachHeading(function (b) { if (headingLevel(b) === nextClose) collapsed[b.id] = true; });
          render();
        };
      }
      /* Three ways to look at the same model. Page is where editing happens,
         in the published layout. Outline is the flat block list, for folding
         and moving whole sections. Preview is the page with nothing on it. */
      var view = el('button', 'la-btn', mode === 'outline' ? 'Page' : 'Outline');
      view.title = mode === 'outline'
        ? 'Edit in the published layout'
        : 'The flat block list: fold sections, move blocks across the whole document';
      view.onclick = function () { setMode(mode === 'outline' ? 'page' : 'outline'); };
      var dlb = el('button', 'la-btn', '⤓');
      dlb.title = 'Download the full editable document to your disk';
      dlb.setAttribute('aria-label', 'Download this document');
      dlb.onclick = function () { downloadDocument(); };
      bar.appendChild(u); bar.appendChild(r); bar.appendChild(f);
      if (exp && mode === 'outline') { bar.appendChild(exp); bar.appendChild(col); }
      bar.appendChild(view);
      if (mode !== 'outline') {
        var add = el('button', 'la-btn', '+ Add');
        add.title = 'Add a block: pick a type, then click where it goes';
        add.onclick = function (e) { e.stopPropagation(); closeFilterMenu(); toggleAddMenu(add); };
        bar.appendChild(add);
        bar.appendChild(modeToggle());
      }
      bar.appendChild(dlb);
    }
  }

  /* Edit | Preview as one control, the same buttons as the rest of the bar,
     the active side lit. */
  function modeToggle() {
    var g = el('span', 'la-seg');
    [['page', 'Edit', 'Edit in the page'], ['preview', 'Preview', 'The page exactly as a reader gets it']].forEach(function (o) {
      var b = el('button', 'la-btn' + (mode === o[0] ? ' on' : ''), o[1]);
      b.title = o[2];
      b.setAttribute('aria-pressed', mode === o[0] ? 'true' : 'false');
      b.onclick = function () { if (mode !== o[0]) setMode(o[0]); };
      g.appendChild(b);
    });
    return g;
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
    /* A shared-runtime document saves its model file and nothing else: the
       runtime and the stylesheet are carried over untouched, which is what
       makes them shared. */
    if (modelSource === 'file') {
      await caps.artifact.publish({ 'model.js': modelJs() });
      return { reloaded: false };
    }
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

    /* Marks survive saves, the reader's as much as Claude's: amber is
       everything the reader changed since Claude's last round, purple that
       round itself, and only a rebuild clears either. Saves used to wipe the
       reader's previous marks, so amber never showed for longer than one save. */
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

    /* A shared-runtime document has no inline stylesheet or runtime to
       re-emit, and needs none: its save is the model file alone. */
    var html = null;
    if (modelSource !== 'file') {
      try { html = buildDocument(); }
      catch (e) { saving = false; return status('Could not build the document: ' + e.message, true); }
    }

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
    /* Closed to start: the first thing on screen is the shape of the document,
       not its first paragraph. Opening one section at a time is the reading
       order this was asked for. */
    setOutlineFolded();
    render();
    checkStash();

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') { hideSelChip(); closeTagPop(); closeFilterMenu(); cancelPlacing(); var am = document.getElementById('la-addmenu'); if (am) am.remove(); }
      /* inside a textarea or input, cmd+z is the browser's, not ours */
      var t = e.target && e.target.tagName;
      if (t === 'TEXTAREA' || t === 'INPUT') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    });
    /* A citation opens its method and closes every other one. Clicking the
       page anywhere else closes them all, so the popovers never stack up. */
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.la-cite')) {
        e.preventDefault(); e.target.click();
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var btn = e.target.closest('.la-cite');
      var inPop = e.target.closest('.la-cite-pop');
      [].forEach.call(document.querySelectorAll('.la-cite[aria-expanded="true"]'), function (b) {
        if (b === btn) return;
        b.setAttribute('aria-expanded', 'false');
        if (b.nextElementSibling) b.nextElementSibling.hidden = true;
      });
      if (!btn || inPop) return;
      e.preventDefault(); e.stopPropagation();
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (btn.nextElementSibling) btn.nextElementSibling.hidden = open;
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
      if (caps.artifact) {
        readOnly = false;
        var stored = null;
        try { stored = localStorage.getItem(modeKey()); } catch (e) { /* private mode */ }
        mode = stored === 'outline' ? 'outline' : 'page';
        render();
      } else {
        mode = 'read';
        render();
      }
    });
  }

  /* Exposed for the headless preflight: geometry-driven drag and native text
     selection cannot be exercised in jsdom, so the same code paths are
     reachable directly. Not part of the document's own behaviour. */
  window.__la = {
    offerTag: function (id, q, targets) { return offerTag(id, q, targets); },
    moveTo: function (id, to) { var r = moveTo(id, to); render(); return r; },
    snapWidth: snapWidth,
    fitWidthFor: fitWidthFor,
    rowFit: rowFit,
    place: function (t, toId, after) { var tr = rangeOf(toId); return tr ? placeBlock(t, after ? tr[1] : tr[0]) : null; },
    startPlacing: startPlacing,
    cancelPlacing: cancelPlacing,
    dropTargetAt: dropTargetAt,
    setWidth: function (id, w) { var b = getBlock(id); return b ? setWidth(b, w, null) : false; },
    destIndexFor: function (t, movingId) { return destIndexFor(t, movingId ? getBlock(movingId) : null, movingId); },
    moveBeside: function (id, cardId, after) {
      var tr = rangeOf(cardId), sr = rangeOf(id); if (!tr || !sr) return false;
      var dest = after ? tr[1] : tr[0], n = sr[1] - sr[0], lvl = headingLevel(getBlock(cardId));
      group(function () { moveTo(id, dest > sr[0] ? dest - n : dest); if (!headingLevel(getBlock(id))) newCardAround(id, lvl); });
      render(); return true;
    },
    wordRuns: wordRuns,
    undo: undo, redo: redo,
    snapToWords: snapToWords,
    finishHighlight: finishHighlight,
    setFilter: function (t) { filter = t; render(); },
    filterMenu: toggleFilterMenu,
    buildStatic: function () { return buildStatic(model.blocks.filter(matchesFilter), filter.slice()); },
    /* the export's own count: the DOM count would report folded blocks as absent */
    count: function () { return model.blocks.filter(matchesFilter).length; },
    exportNow: buildFilteredVersion,
    download: downloadDocument,
    tags: allTags,
    flush: function () { return doSave(); },
    setMode: setMode,
    mode: function () { return mode; },
    rangeOf: rangeOf,
    /* a note on a passage, driven without a real selection */
    noteOn: function (id, quote, text) {
      var b = getBlock(id); if (!b) return false;
      var mk = (b.marks || []).filter(function (o) { return o.quote === quote; })[0];
      if (!mk) { mk = { quote: quote }; b.marks = (b.marks || []).concat([mk]); }
      if (text) mk.note = text; else delete mk.note;
      delete mk.noteDone;
      record({ op: 'note', block: id, quote: quote, text: text || '' });
      render();
      return true;
    },
    debounce: function (ms) { SAVE_DEBOUNCE = ms; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
