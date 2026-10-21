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
  const align = col.align === 'left' ? 'text-left' : 'num';
  if (col.soon) return `<td class="${align}"><span class="v-dim" title="${esc(col.tip)}">—</span></td>`;
  if (col.key === 'name') {
    const star = inShortlist(f.schemeCode) ? '<span class="text-amber-400" title="In shortlist">★</span> ' : '';
    const badge = f.isIndex ? '<span class="idx-badge" title="Passive index fund">Passive</span> ' : '';
    return `<td class="text-left stick stick-1"><div class="fund-name font-semibold text-slate-800 leading-tight" title="${esc(f.name)}">${star}${esc(f.name)}</div><div class="fund-name text-[11px] text-slate-400" title="${esc(f.amc || '')}">${badge}${esc(f.amc || '')}</div></td>`;
  }
  if (col.key === 'group' || col.key === 'catRaw') {
    const g = col.get(f); const c = groupColor(f.peerGroup);
    return `<td class="text-left"><span class="pill" style="background:${c}1a;color:${c}" title="${esc(g)}">${esc(g)}</span></td>`;
  }
  const raw = col.grade === 'vs' ? col.get(f) : col.get(f, cats);
  const display = col.key.startsWith('vs') ? vsFmt(raw) : col.fmt(raw);
  if (display == null) {
    const reason = col.naReason ? col.naReason(f) : '';
    return `<td class="${align}"><span class="v-na"${reason ? ` title="N/A — ${esc(reason)}"` : ''}>N/A</span></td>`;
  }
  const gv = (col.gradeVal || col.get)(f, cats);
  const t = col.grade ? gradeT(col, gv, st) : null;
  const h = t == null ? null : heat(t);
  const style = h ? `background:${h.bg};color:${h.fg}` : '';
  return `<td class="${align}" style="${style}"><span class="v-strong">${esc(display)}</span></td>`;
}

export function renderTable(mount, funds, cats) {
  const cols = state.cols.map((k) => COL_BY_KEY[k]).filter(Boolean);
  const sorted = sortFunds(funds, cats);
  const st = gradeStats(sorted, cols, cats);
  const scroll = mount.querySelector('.tbl-scroll');

  const allChecked = sorted.length > 0 && sorted.every((f) => selected.has(f.schemeCode));
  const head = `<th class="stick stick-0"><input type="checkbox" class="chk-all h-4 w-4 rounded border-slate-300 accent-indigo-600" ${allChecked ? 'checked' : ''}></th>` +
    cols.map((col) => {
      const active = state.sort.key === col.key;
      // The sort caret lives on the bottom .th-meta row so the ?/arrow line up across every header.
      const caret = col.soon ? '' : active ? (state.sort.dir === 'asc' ? 'sort-asc' : 'sort-desc') : 'sort-caret';
      const align = col.align === 'left' ? 'text-left' : 'num';
      const stickCls = col.key === 'name' ? ' stick stick-1' : '';
      const cls = `${align} ${col.soon ? '' : 'sortable'} ${active ? 'text-indigo-600' : ''}${stickCls}`;
      return `<th class="${cls}" data-key="${col.key}"><span class="th-label">${esc(col.label)}</span><span class="th-meta ${caret}"><span class="qmark" title="${esc(col.tip)}">?</span></span></th>`;
    }).join('');

  // Explicit widths (table-layout:fixed) keep every cell on one line; 40px lead col = checkbox.
  const colgroup = `<colgroup><col style="width:40px">${cols.map((c) => `<col style="width:${c.w || 90}px">`).join('')}</colgroup>`;
  const totalW = 40 + cols.reduce((s, c) => s + (c.w || 90), 0);

  const body = sorted.length === 0
    ? `<tr><td class="p-10 text-center text-slate-400" colspan="${cols.length + 1}">No funds match the current filters. Try relaxing a rule or hitting Reset.</td></tr>`
    : sorted.map((f) => {
      const checked = selected.has(f.schemeCode) ? 'checked' : '';
      return `<tr class="row cursor-pointer" data-code="${f.schemeCode}">` +
        `<td class="stick stick-0" data-nodrill><input type="checkbox" class="chk h-4 w-4 rounded border-slate-300 accent-indigo-600" data-code="${f.schemeCode}" ${checked}></td>` +
        cols.map((col) => cellHtml(col, f, cats, st)).join('') + '</tr>';
    }).join('');

  scroll.innerHTML = `<table class="text-sm" style="width:${totalW}px">${colgroup}<thead><tr class="text-xs font-semibold uppercase tracking-wide">${head}</tr></thead><tbody>${body}</tbody></table>`;

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
