// table.js — the screener table: sortable, column-customisable, heat-map coloured, with
// multi-select → shortlist/compare. Row click opens the fund drill.

import { COLUMNS, COL_BY_KEY, heat, esc, groupColor, vsFmt } from './meta.js';
import { state, inShortlist, addManyToShortlist, toggleColumn } from './state.js';

export const selected = new Set(); // ephemeral row selection (scheme codes)
let drillHandler = null, compareHandler = null, changeHandler = null;
export function setDrillHandler(fn) { drillHandler = fn; }
export function setCompareHandler(fn) { compareHandler = fn; }
export function setChangeHandler(fn) { changeHandler = fn; } // notified after selection changes

function valueFor(col, f, cats) {
  if (col.soon) return null;
  const fn = col.sortVal || col.gradeVal || col.get;
  return fn ? fn(f, cats) : null;
}

export function sortFunds(funds, cats) {
  const col = COL_BY_KEY[state.sort.key] || COL_BY_KEY.y5;
  const mul = state.sort.dir === 'asc' ? 1 : -1;
  const text = col.key === 'name' || col.key === 'group' || col.key === 'catRaw';
  return [...funds].sort((a, b) => {
    if (text) return mul * String(col.get(a) ?? '').localeCompare(String(col.get(b) ?? ''));
    const va = valueFor(col, a, cats), vb = valueFor(col, b, cats);
    const na = va == null || !isFinite(va), nb = vb == null || !isFinite(vb);
    if (na && nb) return 0; if (na) return 1; if (nb) return -1; // nulls last
    return mul * (va - vb);
  });
}

// Per-column min/max over the visible funds, for relative heat grading.
function gradeStats(funds, cols, cats) {
  const s = {};
  for (const col of cols) {
    if (!col.grade || col.grade === 'vs') continue;
    let min = Infinity, max = -Infinity;
    for (const f of funds) {
      const v = (col.gradeVal || col.get)(f, cats);
      if (v != null && isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
    s[col.key] = { min, max };
  }
  return s;
}
function gradeT(col, v, st) {
  if (v == null || !isFinite(v)) return null;
  if (col.grade === 'vs') return Math.max(0, Math.min(1, 0.5 + (v - 1) / 0.8)); // centred at 1.0×
  const { min, max } = st[col.key] || {};
  if (min == null || max == null || max === min) return 0.5;
  const t = (v - min) / (max - min);
  return col.grade === 'low' ? 1 - t : t;
}

function cellHtml(col, f, cats, st) {
  const align = col.align === 'left' ? 'text-left' : 'num text-right';
  if (col.soon) return `<td class="px-3 py-2 ${align}"><span class="v-dim" title="${esc(col.tip)}">—</span></td>`;
  if (col.key === 'name') {
    const star = inShortlist(f.schemeCode) ? '<span class="text-amber-400" title="In shortlist">★</span> ' : '';
    return `<td class="px-3 py-2 text-left"><div class="font-semibold text-slate-800 leading-tight">${star}${esc(f.name)}</div><div class="text-[11px] text-slate-400">${esc(f.amc || '')}</div></td>`;
  }
  if (col.key === 'group' || col.key === 'catRaw') {
    const g = col.get(f); const c = groupColor(f.peerGroup);
    return `<td class="px-3 py-2 text-left"><span class="pill" style="background:${c}1a;color:${c}">${esc(g)}</span></td>`;
  }
  const raw = col.grade === 'vs' ? col.get(f) : col.get(f, cats);
  const display = col.key.startsWith('vs') ? vsFmt(raw) : col.fmt(raw);
  if (display == null) {
    const reason = col.naReason ? col.naReason(f) : '';
    return `<td class="px-3 py-2 ${align}"><span class="v-na"${reason ? ` title="N/A — ${esc(reason)}"` : ''}>N/A</span></td>`;
  }
  const gv = (col.gradeVal || col.get)(f, cats);
  const t = col.grade ? gradeT(col, gv, st) : null;
  const h = t == null ? null : heat(t);
  const style = h ? `background:${h.bg};color:${h.fg}` : '';
  return `<td class="px-3 py-2 ${align}" style="${style}"><span class="v-strong">${esc(display)}</span></td>`;
}

export function renderTable(mount, funds, cats) {
  const cols = state.cols.map((k) => COL_BY_KEY[k]).filter(Boolean);
  const sorted = sortFunds(funds, cats);
  const st = gradeStats(sorted, cols, cats);
  const scroll = mount.querySelector('.tbl-scroll');

  const allChecked = sorted.length > 0 && sorted.every((f) => selected.has(f.schemeCode));
  const head = `<th class="px-3 py-2 w-9"><input type="checkbox" class="chk-all h-4 w-4 rounded border-slate-300 accent-indigo-600" ${allChecked ? 'checked' : ''}></th>` +
    cols.map((col) => {
      const active = state.sort.key === col.key;
      const caret = col.soon ? '' : active ? (state.sort.dir === 'asc' ? 'sort-asc' : 'sort-desc') : 'sort-caret';
      const align = col.align === 'left' ? 'text-left' : 'num text-right';
      const cls = `px-3 py-2 ${align} ${col.soon ? '' : 'sortable'} ${caret} ${active ? 'text-indigo-600' : ''}`;
      return `<th class="${cls}" data-key="${col.key}"><span class="inline-flex items-center gap-1">${esc(col.label)}<span class="qmark" title="${esc(col.tip)}">?</span></span></th>`;
    }).join('');

  const body = sorted.length === 0
    ? `<tr><td class="p-10 text-center text-slate-400" colspan="${cols.length + 1}">No funds match the current filters. Try relaxing a rule or hitting Reset.</td></tr>`
    : sorted.map((f) => {
      const checked = selected.has(f.schemeCode) ? 'checked' : '';
      return `<tr class="row cursor-pointer" data-code="${f.schemeCode}">` +
        `<td class="px-3 py-2" data-nodrill><input type="checkbox" class="chk h-4 w-4 rounded border-slate-300 accent-indigo-600" data-code="${f.schemeCode}" ${checked}></td>` +
        cols.map((col) => cellHtml(col, f, cats, st)).join('') + '</tr>';
    }).join('');

  scroll.innerHTML = `<table class="w-full border-collapse text-sm"><thead><tr class="border-b border-slate-200 bg-slate-50/60 text-xs font-semibold uppercase tracking-wide text-slate-500">${head}</tr></thead><tbody class="divide-y divide-slate-100">${body}</tbody></table>`;

  // Header sort
  scroll.querySelectorAll('th.sortable').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort.key = key; const c = COL_BY_KEY[key]; state.sort.dir = (c.key === 'name' || c.key === 'group' || c.key === 'catRaw') ? 'asc' : 'desc'; }
    renderTable(mount, funds, cats);
  }));
  // Select-all
  const chkAll = scroll.querySelector('.chk-all');
  if (chkAll) chkAll.addEventListener('change', (e) => {
    sorted.forEach((f) => (e.target.checked ? selected.add(f.schemeCode) : selected.delete(f.schemeCode)));
    renderTable(mount, funds, cats); notifySelection(mount);
  });
  // Row checkboxes
  scroll.querySelectorAll('.chk').forEach((cb) => cb.addEventListener('change', (e) => {
    e.stopPropagation();
    const code = +e.target.dataset.code;
    e.target.checked ? selected.add(code) : selected.delete(code);
    notifySelection(mount);
    const all = scroll.querySelector('.chk-all'); if (all) all.checked = sorted.every((f) => selected.has(f.schemeCode));
  }));
  // Row click -> drill (ignore clicks on the checkbox cell)
  scroll.querySelectorAll('tr.row').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('[data-nodrill]')) return;
    const f = state.funds.find((x) => x.schemeCode === +tr.dataset.code);
    if (f && drillHandler) drillHandler(f);
  }));

  notifySelection(mount);
}

function notifySelection(mount) {
  const bar = mount.querySelector('.tbl-actionbar');
  if (!bar) return;
  if (selected.size === 0) { bar.innerHTML = ''; bar.classList.add('hidden'); if (changeHandler) changeHandler(); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `<div class="flex flex-wrap items-center gap-2">
    <span class="text-sm font-semibold text-slate-600">${selected.size} selected</span>
    <button class="act-shortlist rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600">★ Add to Shortlist</button>
    <button class="act-compare rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">Compare</button>
    <button class="act-clear rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200">Clear</button>
  </div>`;
  bar.querySelector('.act-shortlist').addEventListener('click', () => { addManyToShortlist([...selected]); if (changeHandler) changeHandler(); notifySelection(mount); renderInPlaceStar(mount); });
  bar.querySelector('.act-compare').addEventListener('click', () => { if (compareHandler) compareHandler([...selected]); });
  bar.querySelector('.act-clear').addEventListener('click', () => { selected.clear(); if (changeHandler) changeHandler(); notifySelection(mount); });
}
// Re-render just to refresh the shortlist stars after "Add to Shortlist".
function renderInPlaceStar(mount) {
  const evt = new CustomEvent('mfs:rerender'); mount.dispatchEvent(evt);
}

/** Data for the column customiser: [{key,label,on,soon,group}]. */
export function columnPickerItems() {
  return COLUMNS.map((c) => ({ key: c.key, label: c.label, on: state.cols.includes(c.key), soon: !!c.soon, group: c.group }));
}
export function toggleCol(key) { toggleColumn(key); }
