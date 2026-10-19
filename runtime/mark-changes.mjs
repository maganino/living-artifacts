#!/usr/bin/env node
/* mark-changes: word-level change marks, computed rather than hand-written.
 *
 *   node mark-changes.mjs <previous.doc.json> <next.doc.json> [--rev N] [--by claude] [--keep-viewer]
 *
 * Rewrites <next.doc.json> in place so that every block whose text differs from
 * the previous model carries `touched: {rev, by, spans}`, where the spans are
 * the runs of words that are new or changed, at word granularity. A block that
 * did not exist before is marked whole (no spans). A block that only moved is
 * not marked. Tables get cell-scoped spans, lists a span per changed item.
 * The reader's own marks (`touched.by: "viewer"`) are cleared too: a rebuild
 * means their edits were read, so the amber goes and only the new purple
 * stays. `--keep-viewer` leaves them.
 *
 * Why a script: the runtime marks whatever Claude puts in `spans`, and a round
 * that rewrote a paragraph wholesale used to mark the whole paragraph, which
 * the reader then had to re-read entirely. Diffing the two models says exactly
 * which words moved, every round, with no judgement call.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normaliseNotes } from './build.mjs';

const args = process.argv.slice(2);
const [prevPath, nextPath] = args.filter((a) => !a.startsWith('--'));
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const by = opt('--by', 'claude');
const keepViewer = args.includes('--keep-viewer');

const prev = normaliseNotes(JSON.parse(readFileSync(prevPath, 'utf8')));
const next = normaliseNotes(JSON.parse(readFileSync(nextPath, 'utf8')));
const rev = Number(opt('--rev', (next.rev ?? 0)));
const prevById = new Map(prev.blocks.map((b) => [b.id, b]));

/* words with their following whitespace, so joining a run gives back the text */
const tokens = (s) => String(s ?? '').match(/\S+\s*/g) ?? [];

/* LCS over tokens; returns the runs of tokens present in `b` and not matched
   in `a`, joined back into strings. Punctuation rides with its word. */
export function changedRuns(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!B.length) return [];
  if (!A.length) return [B.join('').trim()];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = A[i].trim() === B[j].trim() ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const runs = []; let cur = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i].trim() === B[j].trim()) { if (cur.length) { runs.push(cur); cur = []; } i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else { cur.push(B[j]); j++; }
  }
  while (j < m) cur.push(B[j++]);
  if (cur.length) runs.push(cur);
  /* a run is a quote the runtime finds with indexOf, so it must be verbatim
     and long enough not to match somewhere else by accident */
  const out = [];
  for (const r of runs) {
    let q = r.join('').trim();
    if (q.length < 3 && !/\d/.test(q)) continue;
    out.push(q);
  }
  return out;
}

/* The text surfaces of a block, keyed so a span can be scoped to a cell. */
function surfaces(b) {
  const out = [];
  switch (b.type) {
    case 'table':
      (b.head ?? []).forEach((h, ci) => out.push(['h' + ci, h]));
      (b.rows ?? []).forEach((r, ri) => r.forEach((c, ci) => out.push(['r' + ri + 'c' + ci, c])));
      break;
    case 'list': (b.items ?? []).forEach((it, i) => out.push(['i' + i, it])); break;
    case 'callout': out.push(['title', b.title]); out.push(['text', b.text]); break;
    case 'figure': out.push(['caption', b.caption]); break;
    case 'heading': out.push(['eyebrow', b.eyebrow]); out.push(['text', b.text]); break;
    case 'mermaid': out.push(['text', b.text]); break;
    default: out.push(['text', b.text]);
  }
  return out;
}

/* A list item or a table row inserted at the top shifts every index after
   it, so surfaces are aligned by content, not by position: an item or row
   that existed before, wherever it sat, is unchanged; a row that shares its
   first cell with an old one is that row edited; anything else is new. */
function alignedSurfaces(was, b) {
  if (b.type === 'list') {
    const old = new Set(was.items ?? []);
    return (b.items ?? []).map((it, i) => ['i' + i, it, old.has(it) ? it : null]);
  }
  if (b.type === 'table') {
    const out = [];
    (b.head ?? []).forEach((h, ci) => out.push(['h' + ci, h, (was.head ?? [])[ci]]));
    const oldRows = (was.rows ?? []).map((r) => r.map((c) => String(c ?? '')));
    const oldJoined = new Set(oldRows.map((r) => r.join('\u0001')));
    (b.rows ?? []).forEach((r, ri) => {
      const cells = r.map((c) => String(c ?? ''));
      let match = null;
      if (oldJoined.has(cells.join('\u0001'))) match = cells;
      else {
        const byFirst = oldRows.find((o) => o[0] && o[0] === cells[0]);
        match = byFirst ?? (oldRows[ri] && oldRows[ri][0] === cells[0] ? oldRows[ri] : null);
      }
      cells.forEach((c, ci) => out.push(['r' + ri + 'c' + ci, c, match ? (match[ci] ?? '') : null]));
    });
    return out;
  }
  const before = new Map(surfaces(was));
  return surfaces(b).map(([k, t]) => [k, t, before.get(k)]);
}
/* A note answered since the previous model gets the round stamped on it, so
   the page can tell a fresh answer (purple) from a settled one (green). */
function stampAnswers(was, b) {
  /* every note is its own entry with its own id, so an answer is new when the
     entry with that id had no answer, or a different one, in the previous
     model — whichever element it sits on */
  const stamp = (now, before) => {
    const old = new Map((before ?? []).map((n) => [n.id, n]));
    for (const n of now ?? []) {
      if (!n.done) continue;
      const o = old.get(n.id);
      if (!o || o.done !== n.done) n.doneRev = rev;
    }
  };
  stamp(b.notes, was && was.notes);
  for (const k of Object.keys(b.cellNotes ?? {})) stamp(b.cellNotes[k], ((was && was.cellNotes) ?? {})[k]);
  const oldMarks = (was && was.marks) ?? [];
  for (const mk of b.marks ?? []) {
    const o = oldMarks.find((x) => x.quote === mk.quote);
    stamp(mk.notes, o && o.notes);
  }
}
let marked = 0, whole = 0, cleared = 0, viewerCleared = 0;
for (const b of next.blocks) {
  if (!keepViewer && b.touched && b.touched.by !== by) { delete b.touched; viewerCleared++; }
  const was = prevById.get(b.id);
  stampAnswers(was, b);
  if (!was) { b.touched = { rev, by }; whole++; continue; }
  const spans = [];
  let diagramChanged = false;
  for (const [key, text, old] of alignedSurfaces(was, b)) {
    if ((old ?? '') === (text ?? '')) continue;
    if (b.type === 'mermaid') { diagramChanged = true; continue; }
    const runs = old == null ? [String(text ?? '').trim()].filter((x) => x) : changedRuns(old, text);
    for (const q of runs) spans.push(b.type === 'table' ? { cell: key, quote: q } : q);
  }
  if (diagramChanged) { b.touched = { rev, by }; whole++; continue; }
  if (spans.length) { b.touched = { rev, by, spans }; marked++; }
  else if (b.touched && b.touched.by === by) { delete b.touched; cleared++; }
}
writeFileSync(nextPath, JSON.stringify(next, null, 2));
console.log(`${nextPath}: ${marked} blocks marked at word level, ${whole} marked whole (new or a diagram), ${cleared} stale marks cleared, ${viewerCleared} reader marks cleared`);
