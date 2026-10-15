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
  var mode = 'read';   /* read | page | preview, see renderRead */
  var rulesOpen = false;   /* the writing-rules panel, open from the bar */
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
      /* `[D8, roles removed](#b-h-d "D8: remove every role, then sign in")`:
         a reference to another section carries its summary on hover, so a
         case id never sends the reader away to learn what it was. */
      .replace(/\[([^\]]+)\]\(([^)\s]+) &quot;([^&]*?)&quot;\)/g, '<a href="$2" class="la-ref" data-tip="$3" rel="noopener">$1</a>')
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
        var noted = m && m.note ? ' has-note' + (m.noteDone ? doneCls(m.noteDoneRev) : '') : '';
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
  /* Claude's latest round is the highest rev it marked; a note answered in
     that round is recent (purple), an older answer is settled (green). */
  function latestClaudeRev() {
    var r = 0;
    model.blocks.forEach(function (b) { if (b.touched && b.touched.by === 'claude' && b.touched.rev > r) r = b.touched.rev; });
    return r;
  }
  function doneCls(rev) { return ' done' + (rev != null && rev >= latestClaudeRev() ? ' recent' : ''); }
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
  /* What a closed section is holding, so nothing important hides silently. */
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
  /* Does this heading contain other headings? A section that only holds
     sub-sections has nothing of its own to hide. */
  /* The opening view: every section NAME visible, no section CONTENT. Folding
     the container sections too would open the document on four words, which is
     a table of contents for a table of contents. Shift-click on "Collapse ▾"
     still gets there in one click for anyone who wants it. */

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
    renderRead(document.getElementById('la-root'));
  }


  function renderContract() {
    var directives = (model.style && model.style.directives) || [];
    var active = directives.filter(function (x) { return x.active; }).length;
    var d = el('details', 'la-contract');
    d.open = true;
    d.setAttribute('role', 'region');
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
      inp.onkeydown = function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); rulesOpen = false; render(); }
      };
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
      var n = el('div', 'la-cellnote' + (done ? doneCls(((b.cellNotesDoneRev || {})[key])) : ''));
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
    var committed = false;
    function commit() {
      if (committed) return; committed = true;
      var v = inp.value.trim();
      b.cellNotes = b.cellNotes || {};
      if (v) b.cellNotes[key] = v; else delete b.cellNotes[key];
      if (b.cellNotesDone) delete b.cellNotesDone[key];
      record({ op: 'note', block: b.id, cell: key, text: v });
      render();
    }
    function discard() { committed = true; dropEditorHooks(); form.remove(); }
    var inp = noteField(form, (b.cellNotes || {})[key],
      'what should Claude do with this cell?', 'Note to Claude on this cell',
      commit, discard);
    var ok = el('button', 'la-btn primary', 'Save note');
    ok.onclick = function (e) { e.stopPropagation(); commit(); };
    form.onclick = function (e) { e.stopPropagation(); };
    form.appendChild(ok);
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


  /* A heading is the handle for its whole section: the caret opens it, the ⓘ
     says what the section is FOR (the wording comes from the template the
     document follows), and the closed state reports what is inside so a tagged
     block or a pinned note never hides behind a fold. */

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
        var n = el('span', 'la-marknote' + (mk.noteDone ? doneCls(mk.noteDoneRev) : ''));
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
    var committed = false;
    function commit() {
      if (committed) return; committed = true;
      var v = inp.value.trim();
      b.note = v || undefined;
      delete b.noteDone;          /* re-asking reopens it */
      record({ op: 'note', block: b.id, text: v });
      render();
    }
    function discard() { committed = true; dropEditorHooks(); form.remove(); }
    var inp = noteField(form, b.note, 'what should Claude do here?',
      'Note to Claude', commit, discard);
    var ok = el('button', 'la-btn primary', 'Save note');
    ok.onclick = commit;
    form.appendChild(ok);
    host.appendChild(form);
    inp.focus();
  }


  /* ------------------------------------------------------------ note field */
  /* One field for all three kinds of note: on a block, on a table cell, on a
     selected passage. A textarea rather than an input, because a note is
     usually a sentence or two and a single line showed only its tail while it
     was being written. It grows with its content to a ceiling, Enter makes a
     new line and never submits, Cmd or Ctrl with Enter commits, clicking
     outside commits — the same bargain the block editor already makes — and
     Escape discards. */
  function noteField(form, value, placeholder, aria, commit, discard) {
    var ta = el('textarea', 'la-noteinput');
    ta.value = value || '';
    ta.placeholder = placeholder;
    ta.setAttribute('aria-label', aria);
    ta.rows = 1;
    function grow() {
      /* jsdom has no layout, so scrollHeight is 0 there; leave the height alone
         rather than collapsing the field to nothing under the test harness. */
      if (!ta.scrollHeight) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
    }
    ta.oninput = grow;
    ta.onkeydown = function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); discard(); }
    };
    var away = function (e) { if (!form.contains(e.target)) commit(); };
    /* armed on the next tick, or the click that opened the form closes it */
    setTimeout(function () { document.addEventListener('mousedown', away, true); }, 0);
    dropEditorHooks();
    editorCleanup = function () { document.removeEventListener('mousedown', away, true); };
    form.appendChild(ta);
    setTimeout(grow, 0);
    return ta;
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
    if (wrap) {
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
    if (d.toId && d.toId !== d.id && d.dest != null) {
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
    var committed = false;
    function commit() {
      if (committed) return; committed = true;
      var v = inp.value.trim();
      if (v) mk.note = v; else delete mk.note;
      delete mk.noteDone;
      record({ op: 'note', block: b.id, quote: quote, text: v });
      render();
    }
    function discard() { committed = true; dropEditorHooks(); form.remove(); render(); }
    var inp = noteField(form, mk.note,
      'note on \u201C' + clip(quote, 40) + '\u201D',
      'Note to Claude on this passage', commit, discard);
    var ok = el('button', 'la-btn primary', 'Save note');
    ok.onclick = function (e) { e.stopPropagation(); commit(); };
    form.onclick = function (e) { e.stopPropagation(); };
    form.appendChild(ok);
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
    /* a shared copy may carry Claude's change marks for its readers
       (`model.publicMarks`): the words, never the notes or tags */
    if (!pageEdit && !model.publicMarks) return inline(t);
    var chg = changeSpans(b);
    if (cellKey) chg = spansFor(chg, cellKey);
    return withMarks(t, pageEdit ? b.marks : null, chg);
  }
  /* Every block a writer can act on is wrapped and addressable. A reader's
     page carries no wrappers at all. */
  function wrapBlk(b, html, extra) {
    if (!pageEdit || noWrap || !html) {
      var w0 = b.layout && b.layout.w;
      var cls0 = (w0 ? 'blk w-' + esc(w0) : '') + (model.publicMarks && changedWhole(b) ? ' chg-new' : '');
      cls0 = cls0.trim();
      /* In a published copy a changed block is also a link target, so the
         changelog at the top can point at it. The anchor only exists where the
         marks do, so it never appears on an ordinary reader's page. */
      var anchor = (model.publicMarks && b.touched) ? ' id="chg-' + esc(b.id) + '"' : '';
      if (!html || noWrap) return html;
      return (cls0 || anchor) ? '<div class="' + cls0 + '"' + anchor + '>' + html + '</div>' : html;
    }
    var w = b.layout && b.layout.w;
    var cls = 'la-blk' + (w ? ' blk w-' + esc(w) : '') + (extra ? ' ' + extra : '');
    return '<div class="' + cls + '" data-block-id="' + esc(b.id) + '" data-type="' + esc(b.type) + '">' + html + '</div>';
  }
  function rCell(b, text, asRole, key) {
    var t = String(text == null ? '' : text).trim();
    if (asRole) {
      var rc = roleCell(t);
      if (rc) {
        var chips = roleHtml(rc).replace(/la-tag la-role/g, 'pill role')
          .replace(/--tag-h:/g, '--role-h:').replace(/la-rolelead/g, 'role-lead');
        /* A role cell renders as chips rather than as words, so the word-level
           diff has nothing to wrap. Mark the whole cell instead: a rewritten
           owner is exactly the change a reader scans this column for, and
           returning the chips bare dropped it silently. */
        return cellChanged(b, key) ? '<mark class="la-chg' + (chgOwner === 'viewer' ? ' mine' : '') + '">' + chips + '</mark>' : chips;
      }
    }
    var k = t.toLowerCase().replace(/\.$/, '');
    if (R_PILL[k]) {
      var pill = '<span class="pill ' + R_PILL[k] + '">' + esc(t) + '</span>';
      return cellChanged(b, key) ? '<mark class="la-chg' + (chgOwner === 'viewer' ? ' mine' : '') + '">' + pill + '</mark>' : pill;
    }
    return rText(b, t, key);
  }
  /* Did this round change this cell? Reads the same touched spans the word-level
     marker uses, for the cells whose content is drawn rather than written out. */
  function cellChanged(b, key) {
    if (!key) return false;
    var t = b.touched;
    if (!t || (!pageEdit && !model.publicMarks)) return false;
    chgOwner = t.by;
    if (!t.spans) return true;             /* the whole block was rewritten */
    return t.spans.some(function (sp) { return sp && sp.cell === key; });
  }
  function rTableInner(b) {
    var head = b.head || [], rows = b.rows || [], rcols = roleColumns(head);
    var out = '<div class="tbl-wrap' + (b.variant === 'striped' ? ' striped' : '') + '"><table>';
    if (head.some(function (h) { return String(h).trim(); })) {
      out += '<thead><tr>' + head.map(function (h, hi) { return '<th>' + inline(h) + thInfo(b, h, hi) + '</th>'; }).join('') + '</tr></thead>';
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
    var badge = b.badge ? '<span class="la-badge" title="This section comes from ' + esc(b.badge) + '">' + esc(b.badge) + '</span>' : '';
    return wrapBlk(b, '<div class="sub-head" id="' + esc(b.id) + '"><h3>' + rText(b, b.text || '') + badge + '</h3>' + info + '</div>');
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
      /* The section's `info` is the template's own description of what the
         section is for. It is rendered by all three layouts; the house was the
         last to get it, because the flat block list used to carry it instead. */
      var sinfo = (sec.block && sec.block.info) ? '<p>' + inline(sec.block.info) + '</p>' : '';
      /* `badge` says which sections a template demands, so a reader can tell
         them from the ones this document added. */
      var sbadge = (sec.block && sec.block.badge)
        ? '<span class="la-badge" title="This section comes from ' + esc(sec.block.badge) + '">'
          + esc(sec.block.badge) + '</span>' : '';
      var inner = '<div class="sec-head">' + (sec.eyebrow ? '<div class="eyebrow">' + esc(sec.eyebrow) + '</div>' : '')
        + (sec.claim ? '<h2>' + (sec.block ? rText(sec.block, sec.claim) : inline(sec.claim)) + sbadge + '</h2>' : '') + sinfo + '</div>';
      head = sec.block ? wrapBlk(sec.block, inner, 'la-sechead' + (sec.internal ? ' la-internal' : '')) : inner;
    }
    var bid = sec.bid ? '<span id="' + esc(sec.bid) + '"></span>' : '';
    /* An empty section stays visible and says so. A template carries sections
       this document has nothing for yet, and a missing one is forgotten while
       an empty one is a decision somebody has to make. The outline showed this
       as `<>`; the page has to as well, or dropping the outline drops it. */
    var empty = '';
    if (pageEdit && !body.some(function (x) { return x.trim(); }) && sec.block) {
      empty = '<button type="button" class="la-empty" data-empty-after="' + esc(sec.block.id)
        + '" title="Nothing here yet \u2014 click to start writing this section">\u003c\u003e</button>';
    }
    return '<section id="' + esc(tabId + '-' + sec.id) + '"' + (sec.internal ? ' class="la-internal-sec"' : '') + '><div class="wrap">' + bid + head
      + '<div class="blocks">' + body.join('\n') + empty + '</div></div></section>';
  }
  /* `plain` drops the tab semantics: in the brief layout a band is not a tab
     panel, nothing is hidden, and leaving role="tabpanel" on it made wireRead
     hide every band but the first on load. */
  function rTab(tab, first, plain) {
    var secs = tab.sections.filter(function (s) { return !s.internal || pageEdit; });
    var subnav = secs.filter(function (s) { return s.eyebrow || s.claim; }).map(function (s) {
      return '<a href="#' + esc(tab.id + '-' + s.id) + '">' + esc(s.eyebrow || s.claim) + '</a>';
    }).join('');
    var shell = plain
      ? '<div class="tabpanel plain" id="' + esc(tab.id) + '">'
      : '<div class="tabpanel" id="' + esc(tab.id) + '" role="tabpanel" aria-labelledby="tab-' + esc(tab.id) + '"' + (first ? '' : ' hidden') + '>';
    var inner = tab.sections.map(function (s) { return rSection(s, tab.id); }).join('\n');
    if (pageEdit && !inner.trim() && tab.block) {
      inner = '<section><div class="wrap"><div class="blocks"><button type="button" class="la-empty"'
        + ' data-empty-after="' + esc(tab.block.id) + '"'
        + ' title="Nothing here yet \u2014 click to start writing this section">\u003c\u003e</button></div></div></section>';
    }
    return shell
      + '<span id="' + esc(tab.bid) + '"></span><div class="subnav"><div class="wrap">' + subnav + '</div></div>'
      + inner + '</div>';
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
  /* The wordmark. Both constants are REWRITTEN by `build.mjs brand` from the
     design system's own logos/svg — do not edit them by hand. Black for a
     light page, white for a dark one, so no filter has to fake it. */
  var DK_LOGO = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20463.36%2056.57%22%3E%3Cpath%20d%3D%22M26.33%2C55.72h0c2.21%2C0%2C4.22-1.3%2C5.13-3.32L51%2C8.95c1.71-3.8-1.07-8.09-5.23-8.09h0c-2.25%2C0-4.29%2C1.33-5.2%2C3.38l-19.33%2C43.65c-1.63%2C3.68%2C1.07%2C7.83%2C5.1%2C7.83Z%22%2F%3E%3Cpath%20d%3D%22M67.81.86s-.04.02-.04.04v54.79s.02.04.04.04h38.06s.04-.02.04-.04v-9.34s-.02-.04-.04-.04h-26.46s-.04-.02-.04-.04v-13.62s.02-.04.04-.04h24.59s.04-.02.04-.04v-9.42s-.02-.04-.04-.04h-24.59s-.04-.02-.04-.04v-12.77s.02-.04.04-.04h26.46s.04-.02.04-.04V.89s-.02-.04-.04-.04h-38.06Z%22%2F%3E%3Cpath%20d%3D%22M159.08%2C34.08c-.68-.47-1.41-.84-2.17-1.13-.03-.01-.03-.06%2C0-.07.78-.25%2C1.53-.54%2C2.25-.87%2C2.83-1.32%2C5.01-3.22%2C6.54-5.68%2C1.53-2.46%2C2.3-5.41%2C2.3-8.83%2C0-5.24-1.69-9.32-5.06-12.26-3.37-2.93-8.15-4.4-14.32-4.4h-24.86s-.04.02-.04.04v54.79s.02.04.04.04h12.07s.04-.02.04-.04V10.31s.02-.04.04-.04h10.62c3.16%2C0%2C5.58.64%2C7.24%2C1.91%2C1.66%2C1.27%2C2.49%2C3.18%2C2.49%2C5.72s-.83%2C4.46-2.49%2C5.76c-1.66%2C1.3-4.07%2C1.95-7.24%2C1.95h-.7c-2.41%2C0-4.36%2C1.95-4.36%2C4.36s1.95%2C4.36%2C4.36%2C4.36c2.1%2C0%2C2.95%2C2.04%2C3.89%2C3.74l8.47%2C17.64s.02.02.03.02h13.3s.05-.03.03-.05l-8.14-16.37c-1.14-2.28-2.58-4.02-4.32-5.21Z%22%2F%3E%3Cpath%20d%3D%22M223.82%2C27.34s-.04-.05%2C0-.07c2.24-.87%2C4.09-2.15%2C5.54-3.85%2C1.95-2.28%2C2.92-5.06%2C2.92-8.33%2C0-4.41-1.63-7.89-4.9-10.43-3.27-2.54-7.91-3.81-13.93-3.81h-25.25s-.04.02-.04.04v54.79s.02.04.04.04h26.11c6.07%2C0%2C10.83-1.36%2C14.28-4.09%2C3.45-2.72%2C5.17-6.52%2C5.17-11.4%2C0-3.68-1.08-6.68-3.23-8.99-1.68-1.8-3.92-3.1-6.7-3.91ZM219.74%2C44.98c-1.61%2C1.14-3.92%2C1.71-6.93%2C1.71h-13.04s-.04-.02-.04-.04V9.84s.02-.04.04-.04h11.48c3.16%2C0%2C5.5.57%2C7%2C1.71%2C1.5%2C1.14%2C2.26%2C2.83%2C2.26%2C5.06s-.75%2C3.99-2.26%2C5.14c-1.51%2C1.14-3.84%2C1.71-7%2C1.71h-1.42c-2.47%2C0-4.47%2C2-4.47%2C4.47s2%2C4.47%2C4.47%2C4.47h2.98c3.01%2C0%2C5.32.56%2C6.93%2C1.67%2C1.61%2C1.12%2C2.41%2C2.95%2C2.41%2C5.49s-.8%2C4.31-2.41%2C5.45Z%22%2F%3E%3Cpath%20d%3D%22M291.34%2C3.5C287.29%2C1.17%2C282.49%2C0%2C276.94%2C0s-10.35%2C1.17-14.4%2C3.5c-4.05%2C2.33-7.15%2C5.62-9.3%2C9.84-2.15%2C4.23-3.23%2C9.2-3.23%2C14.9s1.09%2C10.61%2C3.27%2C14.86c2.18%2C4.25%2C5.28%2C7.56%2C9.3%2C9.92%2C4.02%2C2.36%2C8.81%2C3.54%2C14.36%2C3.54s10.35-1.18%2C14.4-3.54c4.05-2.36%2C7.17-5.65%2C9.38-9.88%2C2.2-4.23%2C3.31-9.22%2C3.31-14.98s-1.1-10.59-3.31-14.82c-2.21-4.23-5.33-7.51-9.38-9.84ZM287.6%2C41.51c-2.44%2C3.19-5.99%2C4.79-10.66%2C4.79s-8.34-1.6-10.7-4.79c-2.36-3.19-3.54-7.61-3.54-13.27s1.18-10.13%2C3.54-13.27c2.36-3.14%2C5.93-4.71%2C10.7-4.71s8.29%2C1.57%2C10.7%2C4.71c2.41%2C3.14%2C3.62%2C7.56%2C3.62%2C13.27s-1.22%2C10.08-3.66%2C13.27Z%22%2F%3E%3Cpath%20d%3D%22M335.03%2C45.52s-.04-.02-.04-.04V.89s-.02-.04-.04-.04h-12.07s-.04.02-.04.04v54.79s.02.04.04.04h36.81s.04-.02.04-.04v-10.12s-.02-.04-.04-.04h-24.67Z%22%2F%3E%3Cpath%20d%3D%22M376.5.86s-.04.02-.04.04v54.79s.02.04.04.04h12.07s.04-.02.04-.04V.89s-.02-.04-.04-.04h-12.07Z%22%2F%3E%3Cpath%20d%3D%22M439.97%2C5.39c-1.29-2.77-4.06-4.54-7.12-4.54s-5.85%2C1.79-7.13%2C4.57l-23.09%2C50.24s0%2C.05.03.05h12.14s.02-.01.03-.02l17.97-42.08h.31l8.97%2C20.8s0%2C.05-.03.05h-9.56c-2.58%2C0-4.67%2C2.09-4.67%2C4.67s2.09%2C4.67%2C4.67%2C4.67h13.41s.03%2C0%2C.03.02l5.14%2C11.86s.02.02.03.02h12.21s.04-.03.03-.05l-23.39-50.27Z%22%2F%3E%3Cpath%20d%3D%22M30.56.86c-2.6%2C0-4.71%2C2.11-4.71%2C4.71s2.11%2C4.71%2C4.71%2C4.71%2C4.71-2.11%2C4.71-4.71-2.11-4.71-4.71-4.71Z%22%2F%3E%3Cpath%20d%3D%22M17.62%2C29.75c-2.6%2C0-4.71%2C2.11-4.71%2C4.71s2.11%2C4.71%2C4.71%2C4.71%2C4.71-2.11%2C4.71-4.71-2.11-4.71-4.71-4.71Z%22%2F%3E%3Cpath%20d%3D%22M24.13%2C15.3h-12.98c-2.6%2C0-4.71%2C2.11-4.71%2C4.71v.04c0%2C2.58%2C2.09%2C4.67%2C4.67%2C4.67h13.02c2.6%2C0%2C4.71-2.11%2C4.71-4.71s-2.11-4.71-4.71-4.71Z%22%2F%3E%3Cpath%20d%3D%22M22.4%2C5.56c0-2.6-2.11-4.71-4.71-4.71H4.71c-2.6%2C0-4.71%2C2.11-4.71%2C4.71v.04c0%2C2.58%2C2.09%2C4.67%2C4.67%2C4.67h13.02c2.6%2C0%2C4.71-2.11%2C4.71-4.71Z%22%2F%3E%3C%2Fsvg%3E';
  var DK_LOGO_WHITE = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20463.36%2056.57%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M26.33%2C55.72h0c2.21%2C0%2C4.22-1.3%2C5.13-3.32L51%2C8.95c1.71-3.8-1.07-8.09-5.23-8.09h0c-2.25%2C0-4.29%2C1.33-5.2%2C3.38l-19.33%2C43.65c-1.63%2C3.68%2C1.07%2C7.83%2C5.1%2C7.83Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M67.81.86s-.04.02-.04.04v54.79s.02.04.04.04h38.06s.04-.02.04-.04v-9.34s-.02-.04-.04-.04h-26.46s-.04-.02-.04-.04v-13.62s.02-.04.04-.04h24.59s.04-.02.04-.04v-9.42s-.02-.04-.04-.04h-24.59s-.04-.02-.04-.04v-12.77s.02-.04.04-.04h26.46s.04-.02.04-.04V.89s-.02-.04-.04-.04h-38.06Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M159.08%2C34.08c-.68-.47-1.41-.84-2.17-1.13-.03-.01-.03-.06%2C0-.07.78-.25%2C1.53-.54%2C2.25-.87%2C2.83-1.32%2C5.01-3.22%2C6.54-5.68%2C1.53-2.46%2C2.3-5.41%2C2.3-8.83%2C0-5.24-1.69-9.32-5.06-12.26-3.37-2.93-8.15-4.4-14.32-4.4h-24.86s-.04.02-.04.04v54.79s.02.04.04.04h12.07s.04-.02.04-.04V10.31s.02-.04.04-.04h10.62c3.16%2C0%2C5.58.64%2C7.24%2C1.91%2C1.66%2C1.27%2C2.49%2C3.18%2C2.49%2C5.72s-.83%2C4.46-2.49%2C5.76c-1.66%2C1.3-4.07%2C1.95-7.24%2C1.95h-.7c-2.41%2C0-4.36%2C1.95-4.36%2C4.36s1.95%2C4.36%2C4.36%2C4.36c2.1%2C0%2C2.95%2C2.04%2C3.89%2C3.74l8.47%2C17.64s.02.02.03.02h13.3s.05-.03.03-.05l-8.14-16.37c-1.14-2.28-2.58-4.02-4.32-5.21Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M223.82%2C27.34s-.04-.05%2C0-.07c2.24-.87%2C4.09-2.15%2C5.54-3.85%2C1.95-2.28%2C2.92-5.06%2C2.92-8.33%2C0-4.41-1.63-7.89-4.9-10.43-3.27-2.54-7.91-3.81-13.93-3.81h-25.25s-.04.02-.04.04v54.79s.02.04.04.04h26.11c6.07%2C0%2C10.83-1.36%2C14.28-4.09%2C3.45-2.72%2C5.17-6.52%2C5.17-11.4%2C0-3.68-1.08-6.68-3.23-8.99-1.68-1.8-3.92-3.1-6.7-3.91ZM219.74%2C44.98c-1.61%2C1.14-3.92%2C1.71-6.93%2C1.71h-13.04s-.04-.02-.04-.04V9.84s.02-.04.04-.04h11.48c3.16%2C0%2C5.5.57%2C7%2C1.71%2C1.5%2C1.14%2C2.26%2C2.83%2C2.26%2C5.06s-.75%2C3.99-2.26%2C5.14c-1.51%2C1.14-3.84%2C1.71-7%2C1.71h-1.42c-2.47%2C0-4.47%2C2-4.47%2C4.47s2%2C4.47%2C4.47%2C4.47h2.98c3.01%2C0%2C5.32.56%2C6.93%2C1.67%2C1.61%2C1.12%2C2.41%2C2.95%2C2.41%2C5.49s-.8%2C4.31-2.41%2C5.45Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M291.34%2C3.5C287.29%2C1.17%2C282.49%2C0%2C276.94%2C0s-10.35%2C1.17-14.4%2C3.5c-4.05%2C2.33-7.15%2C5.62-9.3%2C9.84-2.15%2C4.23-3.23%2C9.2-3.23%2C14.9s1.09%2C10.61%2C3.27%2C14.86c2.18%2C4.25%2C5.28%2C7.56%2C9.3%2C9.92%2C4.02%2C2.36%2C8.81%2C3.54%2C14.36%2C3.54s10.35-1.18%2C14.4-3.54c4.05-2.36%2C7.17-5.65%2C9.38-9.88%2C2.2-4.23%2C3.31-9.22%2C3.31-14.98s-1.1-10.59-3.31-14.82c-2.21-4.23-5.33-7.51-9.38-9.84ZM287.6%2C41.51c-2.44%2C3.19-5.99%2C4.79-10.66%2C4.79s-8.34-1.6-10.7-4.79c-2.36-3.19-3.54-7.61-3.54-13.27s1.18-10.13%2C3.54-13.27c2.36-3.14%2C5.93-4.71%2C10.7-4.71s8.29%2C1.57%2C10.7%2C4.71c2.41%2C3.14%2C3.62%2C7.56%2C3.62%2C13.27s-1.22%2C10.08-3.66%2C13.27Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M335.03%2C45.52s-.04-.02-.04-.04V.89s-.02-.04-.04-.04h-12.07s-.04.02-.04.04v54.79s.02.04.04.04h36.81s.04-.02.04-.04v-10.12s-.02-.04-.04-.04h-24.67Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M376.5.86s-.04.02-.04.04v54.79s.02.04.04.04h12.07s.04-.02.04-.04V.89s-.02-.04-.04-.04h-12.07Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M439.97%2C5.39c-1.29-2.77-4.06-4.54-7.12-4.54s-5.85%2C1.79-7.13%2C4.57l-23.09%2C50.24s0%2C.05.03.05h12.14s.02-.01.03-.02l17.97-42.08h.31l8.97%2C20.8s0%2C.05-.03.05h-9.56c-2.58%2C0-4.67%2C2.09-4.67%2C4.67s2.09%2C4.67%2C4.67%2C4.67h13.41s.03%2C0%2C.03.02l5.14%2C11.86s.02.02.03.02h12.21s.04-.03.03-.05l-23.39-50.27Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M30.56.86c-2.6%2C0-4.71%2C2.11-4.71%2C4.71s2.11%2C4.71%2C4.71%2C4.71%2C4.71-2.11%2C4.71-4.71-2.11-4.71-4.71-4.71Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M17.62%2C29.75c-2.6%2C0-4.71%2C2.11-4.71%2C4.71s2.11%2C4.71%2C4.71%2C4.71%2C4.71-2.11%2C4.71-4.71-2.11-4.71-4.71-4.71Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M24.13%2C15.3h-12.98c-2.6%2C0-4.71%2C2.11-4.71%2C4.71v.04c0%2C2.58%2C2.09%2C4.67%2C4.67%2C4.67h13.02c2.6%2C0%2C4.71-2.11%2C4.71-4.71s-2.11-4.71-4.71-4.71Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M22.4%2C5.56c0-2.6-2.11-4.71-4.71-4.71H4.71c-2.6%2C0-4.71%2C2.11-4.71%2C4.71v.04c0%2C2.58%2C2.09%2C4.67%2C4.67%2C4.67h13.02c2.6%2C0%2C4.71-2.11%2C4.71-4.71Z%22%2F%3E%3C%2Fsvg%3E';
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
  /* A column's definition rides on its header as an ⓘ, so a table needs no
     legend paragraph. b.headInfo is keyed by column name, or by index. */
  function thInfo(b, h, i) {
    var m = b.headInfo || {}, t = m[String(h).trim()] != null ? m[String(h).trim()] : m[i];
    if (!t || !String(t).trim()) return '';
    return '<i class="th-i" tabindex="0" role="button" aria-label="What ' + esc(String(h)) + ' means">i<span class="th-pop">' + inline(String(t)) + '</span></i>';
  }
  function dkGrid(b) {
    var head = b.head || [], rows = b.rows || [], rcols = roleColumns(head), n = head.length;
    var wide = n >= 6, tall = rows.length > 12;
    var out = '<div class="tablewrap' + (wide ? ' wide' : '') + (tall ? '' : ' short') + '"><table>';
    if (head.some(function (h) { return String(h).trim(); })) out += '<thead><tr>' + head.map(function (h, hi) { return '<th>' + inline(h) + thInfo(b, h, hi) + '</th>'; }).join('') + '</tr></thead>';
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
  var GT_GRP = {};
  function gtGrp(name) {
    var k = String(name || '').trim().toLowerCase();
    if (!GT_GRP[k]) GT_GRP[k] = 'g' + ((Object.keys(GT_GRP).length % 4) + 1);
    return GT_GRP[k];
  }
  function dkGantt(b) {
    GT_GRP = {};
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
        var note = String(r[8] || '').trim(), grp = String(r[7] || '').trim();
        rs += '<div class="gt-row" data-cell="r' + ri + 'c1">'
          + '<div class="gt-lab"><b>' + rText(b, r[1] || '', 'r' + ri + 'c1')
          + (note ? '<i class="gt-i" tabindex="0" role="button" aria-label="More about ' + esc(r[1] || '') + '">i<span class="gt-pop">' + rText(b, note, 'r' + ri + 'c8') + '</span></i>' : '')
          + '</b><span>'
          + (grp ? '<em class="gt-grp ' + gtGrp(grp) + '">' + rText(b, grp, 'r' + ri + 'c7') + '</em>' : '')
          + rText(b, r[2] || '', 'r' + ri + 'c2') + '</span></div>'
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
    /* The filled chip is the CHOICE once there is one, and the recommendation
       falls back to a light outline. Before a choice is made the recommendation
       is filled, which is what it meant all along. Reading the filled chip as
       the recommendation after a decision went the other way is how D-01 and
       D-03 of the Action Inventory came out wrong on the page. */
    var chosen = b.decision;
    if (opts && opts.length) {
      html += '<div class="opts">' + opts.map(function (o) {
        var isChosen = chosen === o[0], isRec = o[0] === recLetter;
        var cls = 'opt' + (isChosen ? ' chosen' : '')
          + (isRec ? (chosen ? ' rec-soft' : ' rec') : '');
        if (!pageEdit) return '<span class="' + cls + '"><b>' + esc(o[0]) + '</b>' + rText(b, o[1]) + '</span>';
        return '<button type="button" class="' + cls + '" data-opt="' + esc(o[0]) + '"'
          + ' aria-pressed="' + (isChosen ? 'true' : 'false') + '"'
          + ' title="' + (isChosen ? 'Chosen — click again to clear' : 'Choose this option') + '">'
          + '<b>' + esc(o[0]) + '</b>' + rText(b, o[1]) + '</button>';
      }).join('') + '</div>';
    }
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
  function knownTemplates() { return Object.keys(TEMPLATES); }
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
    var h = '<header class="top">'
      + '<img class="logo logo-light" src="' + DK_LOGO + '" alt="Verbolia">'
      + '<img class="logo logo-dark" src="' + DK_LOGO_WHITE + '" alt="">'
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
  /* ---------------------------------------------------------- brief ----
     A third read-mode layout, selected by `template: "brief"`: the house look
     with the tabs unfolded into one continuous page, for a one-pager or a
     short memo that is read top to bottom rather than navigated. Each tab
     becomes a titled band and its level-2 heading becomes editable in place,
     as it is in desk-research and is not in the tabbed layout. Nothing else
     differs, so a brief that grows into a spec becomes one by changing the
     template and republishing. */
  function readHtmlBrief() {
    var split = rSplit(model.blocks), tabs = split.tabs;
    var nav = tabs.map(function (t) {
      return '<a href="#' + esc(t.id) + '">' + esc(t.label) + '</a>';
    }).join('');
    /* rTab already emits the tab's own anchor span, so the band head must not
       emit it again — two nodes with one id breaks every link into it. */
    var body = tabs.map(function (t) {
      return '<div class="band">'
        + '<div class="wrap">' + wrapBlk(t.block, '<div class="band-head">' + rText(t.block, t.label) + '</div>') + '</div>'
        + rTab(t, true, true) + '</div>';
    }).join('\n');
    return rPubNote()
      + '<div class="topbar"><div class="wrap"><div class="brand"><span class="dot"></span>Verbolia <span class="sep">/</span> <span class="doc">' + esc(model.component || 'Document') + '</span></div>'
      + '<nav class="sections">' + nav + '</nav></div></div>'
      + rHero(split.hero) + body + rFooter(tabs);
  }

  /* The read-mode layouts, by `model.template`. Adding one is an entry here
     and a stylesheet: the dispatch, the body class and the validator all read
     this object, so a template can never be half-registered. `cls` is the
     modifier put on `.house`; the default layout carries none. */
  var TEMPLATES = {
    'house': { cls: '', render: null, note: 'the default: a tabbed spec or PRD' },
    'desk-research': { cls: 'desk', render: function () { return readHtmlDesk(); }, note: 'one long page, sticky nav, stat tiles and charts' },
    'brief': { cls: 'brief', render: function () { return readHtmlBrief(); }, note: 'a one-pager: the house look, tabs unfolded into one page' }
  };
  function template() { return TEMPLATES[model.template] || TEMPLATES.house; }
  function templateCls() { var c = template().cls; return c ? ' ' + c : ''; }
  function rPubNote() {
    return model.publicMarks && model.publicMarksNote
      ? '<div class="pubnote"><div class="wrap">' + inline(model.publicMarksNote) + '</div></div>' : '';
  }

  function readHtml() {
    var t = template();
    if (t.render) return t.render();
    var split = rSplit(model.blocks), tabs = split.tabs;
    var tabBtns = tabs.map(function (t, i) {
      return '<button type="button" role="tab" id="tab-' + esc(t.id) + '" aria-controls="' + esc(t.id) + '" aria-selected="' + (i === 0 ? 'true' : 'false') + '"' + (i === 0 ? '' : ' tabindex="-1"') + '>' + esc(t.label) + '</button>';
    }).join('');
    var html = rPubNote() + '<div class="topbar"><div class="wrap"><div class="brand"><span class="dot"></span>Verbolia <span class="sep">/</span> <span class="doc">' + esc(model.component || 'Document') + '</span></div>'
      + '<div class="tabs" role="tablist" aria-label="Document tabs">' + tabBtns + '</div></div></div>'
      + rHero(split.hero)
      + tabs.map(function (t, i) { return rTab(t, i === 0); }).join('\n')
      + rFooter(tabs);
    /* a link into a section this view does not show is unwrapped to its words */
    var ids = {};
    html.replace(/id="([^"]+)"/g, function (_, id) { ids[id] = 1; return _; });
    html = html.replace(/<a href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, function (m0, id, text) { return ids[id] ? m0 : text; });
    return html;
  }

  /* --- editing in the page --------------------------------------------- */
  function rBlkNode(id) { return document.querySelector('.la-blk[data-block-id="' + id + '"]'); }
  /* the same chrome and the same editors the block list used to carry, now
     attached to the
     rendered blocks after the fact */
  function dressBlocks(house) {
    var blks = [].slice.call(house.querySelectorAll('.la-blk'));
    blks.forEach(function (node) {
      var b = getBlock(node.dataset.blockId); if (!b) return;
      if (b.touched) node.dataset.touched = b.touched.by === 'claude' ? 'claude' : 'viewer';
      if (changedWhole(b)) node.dataset.changed = 'all';
      node.insertBefore(renderChrome(b), node.firstChild);
      if (b.note) {
        var n = el('div', 'la-note' + (b.noteDone ? doneCls(b.noteDoneRev) : ''));
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
          /* A decision chip is an answer, not a way into the editor. Clicking
             the chosen one again clears the choice: a recorded intent has to be
             correctable, like every other gesture here. The choice and a note on
             the same decision stay two operations, because they have different
             lives — a note is answered and cleared, a choice stands. */
          var chip = e.target.closest('.opts [data-opt]');
          if (chip) {
            e.preventDefault(); e.stopPropagation();
            var pick = chip.getAttribute('data-opt');
            var was = b.decision;
            if (was === pick) delete b.decision; else b.decision = pick;
            record({ op: 'decide', block: b.id, option: b.decision || null, was: was || null });
            render();
            return;
          }
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
    var house = el('div', 'house' + templateCls() + (pageEdit ? ' la-page' : ''));
    house.innerHTML = readHtml();
    /* The writing rules sit above the document, not inside it: they are
       instructions about the page rather than part of it, and a reader of the
       published page must never see them. */
    if (pageEdit && rulesOpen) root.appendChild(renderContract());
    root.appendChild(house);
    if (pageEdit) dressBlocks(house);
    wireRead(house);
    var pill = document.getElementById('la-modepill'); if (pill) pill.remove();
    if (!readOnly) renderBar();
    else { var bar = document.getElementById('la-bar'); if (bar) bar.remove(); }
    /* diagrams: drawn by the shared on-demand loader */
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
    [].forEach.call(house.querySelectorAll('.la-empty[data-empty-after]'), function (ph) {
      ph.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var r = rangeOf(ph.getAttribute('data-empty-after'));
        if (r) placeBlock('para', r[1]);
      });
    });
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
  /* A shell document's runtime and stylesheet are separate files beside it.
     They are this artifact's own files, so the page can fetch them and inline
     them into one standalone copy — which is what the button promises. */
  async function fetchShellAssets() {
    var link = document.querySelector('link[rel="stylesheet"]');
    var tag = [].slice.call(document.querySelectorAll('script[src]'))
      .filter(function (n) { return /runtime\.js(\?|$)/.test(n.getAttribute('src') || ''); })[0];
    if (!link || !tag || typeof fetch !== 'function') return null;
    try {
      var res = await Promise.all([fetch(link.getAttribute('href')), fetch(tag.getAttribute('src'))]);
      if (!res[0].ok || !res[1].ok) return null;
      var text = await Promise.all([res[0].text(), res[1].text()]);
      return { css: text[0], js: text[1] };
    } catch (e) { return null; }
  }

  async function downloadDocument() {
    var dl = null;
    try { dl = await claude.use('downloads'); } catch (e) { /* not granted */ }
    if (!dl) return status('Downloading is not available in this view.', true);

    var html = null, assets = null;
    if (modelSource === 'file') {
      status('Building a standalone copy\u2026');
      assets = await fetchShellAssets();
    }
    try { html = buildDocument(assets); }
    catch (e) { html = null; }

    if (html) {
      try {
        await dl.save({ filename: model.docId + '-rev' + model.rev + '.html', data: html });
        return status('Saved a full copy of rev ' + model.rev + ' to your disk.');
      } catch (e) {
        if (e && e.code === 'cancelled') return status('Download cancelled.');
        return status('Download failed (' + ((e && e.code) || 'unknown') + ').', true);
      }
    }

    /* Could not reach the shared runtime: hand over the model, which is the
       part that is not recoverable from anywhere else. `.json`, never `.js` —
       a download of a script is refused, which is what `rejected_extension`
       was. The runtime is in the repo and in the design-system artifact. */
    try {
      await dl.save({
        filename: model.docId + '-rev' + model.rev + '.model.json',
        data: JSON.stringify(model, null, 2)
      });
      return status('Saved the model of rev ' + model.rev + '. The runtime that draws it is in the repo.');
    } catch (e2) {
      if (e2 && e2.code === 'cancelled') return status('Download cancelled.');
      return status('Download failed (' + ((e2 && e2.code) || 'unknown') + ').', true);
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
      var dlb = el('button', 'la-btn', '\u2913');
      dlb.title = 'Download the full editable document to your disk';
      dlb.setAttribute('aria-label', 'Download this document');
      dlb.onclick = function () { downloadDocument(); };
      /* The writing rules used to live in the outline's header, which is the
         only reason the outline outlived the move to editing in the page.
         They are standing instructions for every regeneration, so they belong
         where the document is written, not behind a view nobody opens. */
      var nrules = (((model.style || {}).directives) || []).filter(function (x) { return x.active; }).length;
      var rules = el('button', 'la-btn' + (rulesOpen ? ' on' : ''),
        'Writing rules' + (nrules ? ' \u00b7 ' + nrules : ''));
      rules.title = 'How this document should be written: standing instructions Claude applies on every rewrite';
      rules.setAttribute('aria-pressed', rulesOpen ? 'true' : 'false');
      rules.onclick = function (e) { e.stopPropagation(); rulesOpen = !rulesOpen; render(); };
      bar.appendChild(u); bar.appendChild(r); bar.appendChild(f);
      var add = el('button', 'la-btn', '+ Add');
      add.title = 'Add a block: pick a type, then click where it goes';
      add.onclick = function (e) { e.stopPropagation(); closeFilterMenu(); toggleAddMenu(add); };
      bar.appendChild(add);
      bar.appendChild(rules);
      /* Publish cuts a read-only copy of this version, with the changes listed
         at the top. It never replaces the download beside it: that one hands
         back the whole editable document, which is the no-lock-in promise. */
      var pub = el('button', 'la-btn', 'Publish');
      pub.title = 'Save a read-only copy of this version, with what changed listed at the top';
      pub.onclick = function (e) { e.stopPropagation(); publishCopy(); };
      bar.appendChild(pub);
      bar.appendChild(modeToggle());
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


  /* ------------------------------------------------------- publishing a copy */
  /* What changed since the last rebuild, read from the same `touched` marks the
     page already paints. The changelog is DERIVED, never stored: a stored one
     is a second source of truth that has to be cleared every round, and the one
     thing worse than no changelog is a stale one. */
  function changeList() {
    var out = [];
    model.blocks.forEach(function (b) {
      if (!b.touched) return;
      var label = b.text || b.title || b.caption
        || (b.items && b.items[0]) || (b.head && b.head.join(' \u00b7 ')) || b.type;
      out.push({
        id: b.id,
        by: b.touched.by,
        type: b.type,
        label: clip(String(label).replace(/\s+/g, ' ').trim(), 70)
      });
    });
    return out;
  }

  function changelogHtml(changes) {
    if (!changes.length) return '';
    var items = changes.map(function (c) {
      return '<li><a href="#chg-' + esc(c.id) + '">' + esc(c.label) + '</a>'
        + '<span class="who">' + (c.by === 'viewer' ? 'you' : 'Claude') + '</span></li>';
    }).join('');
    return '<nav class="la-changelog"><div class="wrap">'
      + '<p class="la-changelog-h">' + changes.length + ' change'
      + (changes.length === 1 ? '' : 's') + ' in this version</p>'
      + '<ol>' + items + '</ol></div></nav>';
  }

  /* The published copy IS the preview: the same read-mode render, with the
     change marks turned on for its readers and a changelog above it. No editor,
     no journal, no `db` — it is a file, and a file cannot be edited back. */
  function buildPreviewCopy(assets, changes) {
    var styleEl = document.getElementById(STYLE_EL);
    var css = (assets && assets.css) || (styleEl && styleEl.textContent) || '';
    if (!css) throw new Error('this view has no copy of the stylesheet to inline');
    var keepModel = model, keepEdit = pageEdit, keepRO = readOnly;
    var copy = clone(model);
    copy.publicMarks = true;
    copy.publicMarksNote = 'Purple is what changed in this version \u00b7 rev ' + model.rev;
    var body;
    try {
      model = copy; pageEdit = false; readOnly = true;
      body = readHtml();
    } finally {
      model = keepModel; pageEdit = keepEdit; readOnly = keepRO;
    }
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<title>' + esc(model.title) + '</title>\n'
      + '<style>\n' + css + '\n</style>\n</head>\n<body>\n'
      + '<div class="house' + templateCls() + '">' + changelogHtml(changes) + body + '</div>\n'
      + '</body>\n</html>\n';
  }

  async function publishCopy() {
    if (readOnly) return status('This view cannot publish.', true);
    var dl = null;
    try { dl = await claude.use('downloads'); } catch (e) { /* not granted */ }

    /* Save first, so the version this copy is cut from is the live one. */
    if (pending.length) { status('Saving before publishing\u2026'); await doSave(); }

    var changes = changeList();
    var assets = (modelSource === 'file') ? await fetchShellAssets() : null;
    var html;
    try { html = buildPreviewCopy(assets, changes); }
    catch (e) { return status('Could not build the copy: ' + e.message, true); }

    record({ op: 'publish', rev: model.rev, changed: changes.map(function (c) { return c.id; }) });
    scheduleSave();

    if (!dl) {
      return status('Built the copy for rev ' + model.rev + ', but this view cannot save files.', true);
    }
    try {
      await dl.save({ filename: model.docId + '-rev' + model.rev + '.published.html', data: html });
      status('Published rev ' + model.rev + ' \u00b7 ' + changes.length + ' change'
        + (changes.length === 1 ? '' : 's') + ' listed at the top of the copy.');
    } catch (e) {
      if (e && e.code === 'cancelled') return status('Publishing cancelled.');
      status('Could not save the copy (' + ((e && e.code) || 'unknown') + ').', true);
    }
  }

  /* ------------------------------------------------------- document output */
  /* `assets` lets a shell-form document build the same standalone file an
     inlined one builds, from its own fetched runtime and stylesheet. */
  function buildDocument(assets) {
    var styleEl = document.getElementById(STYLE_EL), runtimeEl = document.getElementById(RUNTIME_EL);
    var css = (assets && assets.css) || (styleEl && styleEl.textContent) || '';
    var js = (assets && assets.js) || (runtimeEl && runtimeEl.textContent) || '';
    if (!css || !js) throw new Error('this view has no copy of the runtime to inline');
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
        mode = stored === 'preview' ? 'preview' : 'page';
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
    /* the live model and the operations queued since the last save — the test
       harness reads these, because the embedded JSON is only rewritten on save
       and reading it mid-round reports the state before the gesture */
    model: function () { return model; },
    ops: function () { return pending.slice(); },
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
    publishCopy: function () { return publishCopy(); },
    changeList: changeList,
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
