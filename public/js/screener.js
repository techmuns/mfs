// screener.js — the Screener tab. Compact by design: a single slim control row sits directly
// above the table (search · category · Filters popover · Screening-steps popover · Columns ·
// export). The KPI strip and the three overview charts live BELOW the table so the funds are
// visible with almost no scrolling.

import {
  state, emit, filteredBase, visibleFunds, scopeCount, runFunnel, FUNNEL_RULES,
  activeChips, clearChip, resetFilters, savePreset, loadPreset,
} from './state.js';
import { ICON, esc, pct, isThematic, isIndex, orderGroups } from './meta.js';
import { categoryBar, topFundsBar, rollingRange } from './charts.js';
import { renderTable, columnPickerItems, toggleCol, selected } from './table.js';
import { exportCSV, exportExcel } from './export.js';

let root = null;
let debounceTimer = null;
const scheduleRender = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(() => { render(); }, 300); };

// Which popovers exist; a shared manager keeps only one open at a time.
const POPS = [
  { btn: 'btn-filters', pop: 'filters-pop' },
  { btn: 'btn-steps', pop: 'steps-pop' },
  { btn: 'btn-cols', pop: 'col-panel', onOpen: renderColPanel },
];

// ---- skeleton --------------------------------------------------------------
export function mountScreener(container) {
  root = container;
  root.innerHTML = `
  <div class="space-y-3">
    <div class="card overflow-visible">
      <!-- slim control row (+ anchored popovers) -->
      <div class="relative border-b border-slate-100">
        <div class="flex flex-wrap items-center gap-2 p-2.5">
          <div class="relative w-full sm:w-56">
            <input id="tbl-search" type="search" placeholder="Search funds…" autocomplete="off" class="inp !py-1.5 !pl-8 text-sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" class="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          </div>
          <select id="f-group" class="inp !w-auto max-w-[210px] !py-1.5 text-sm"></select>
          <button id="btn-filters" class="ctl-btn">${ICON.filter}Filters<span id="filters-count" class="ctl-badge hidden"></span><span class="chev text-[10px]">▾</span></button>
          <button id="btn-steps" class="ctl-btn">${ICON.funnel}Screening steps<span id="steps-count" class="ctl-badge hidden"></span><span class="chev text-[10px]">▾</span></button>
          <span id="result-count" class="rounded-full bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-600 tnum">—</span>
          <div class="relative ml-auto">
            <button id="btn-cols" class="ctl-btn">${ICON.table}Columns<span class="chev text-[10px]">▾</span></button>
            <div id="col-panel" class="absolute right-0 z-30 mt-1 hidden max-h-80 w-56 overflow-y-auto rounded-xl bg-white p-2 shadow-xl ring-1 ring-slate-200"></div>
          </div>
          <button id="btn-csv" class="ctl-btn">CSV</button>
          <button id="btn-xlsx" class="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">${ICON.download}Excel</button>
        </div>

        <!-- Filters popover -->
        <div id="filters-pop" class="pop hidden">
          <div class="mb-3 flex items-center gap-2 text-sm font-bold text-slate-700">${ICON.filter}<span class="font-display">Filters</span>
            <span class="text-xs font-normal text-slate-400">— narrow the universe before screening</span></div>
          <div class="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            ${slider('f-min5y', 'Min 5Y CAGR', -10, 40, 1, -10)}
            ${slider('f-min10y', 'Min 10Y CAGR', -10, 40, 1, -10)}
            ${slider('f-sharpe', 'Min Sharpe', 0, 20, 1, 0)}
            ${slider('f-maxvol', 'Max Volatility', 10, 50, 1, 50)}
            <label class="block"><span class="lbl">Fund age (years)</span>
              <div class="flex items-center gap-2"><input id="f-agemin" type="number" min="0" max="40" placeholder="min" class="inp tnum">
              <span class="text-slate-300">–</span><input id="f-agemax" type="number" min="0" max="40" placeholder="max" class="inp tnum"></div></label>
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            ${toggle('f-beats5y', '5Y beats category')}${toggle('f-beats10y', '10Y beats category')}
            ${toggle('f-has5y', 'Has 5Y history')}${toggle('f-has10y', 'Has 10Y history')}
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <button id="btn-reset" class="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200">Reset all</button>
            <select id="preset-select" class="inp !w-auto !py-1.5 text-xs"></select>
            <button id="btn-save-preset" class="rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-600 hover:bg-indigo-100">Save preset</button>
          </div>
        </div>

        <!-- Screening-steps (elimination funnel) popover -->
        <div id="steps-pop" class="pop hidden">
          <div class="mb-1 flex items-center gap-2 text-sm font-bold text-slate-700">${ICON.funnel}<span class="font-display">Screening steps</span>
            <span class="text-xs font-normal text-slate-400">— toggle rules to whittle the field down to a shortlist</span></div>
          <div id="funnel-list" class="mt-2 space-y-1.5"></div>
        </div>
      </div>

      <!-- active-filter chips (shown only when something is on) -->
      <div id="chips-row" class="hidden flex-wrap items-center gap-1.5 border-b border-slate-100 px-3 py-2"></div>

      <!-- the table, right at the top -->
      <div id="screener-table">
        <div class="tbl-actionbar hidden px-3 pt-2"></div>
        <div class="tbl-scroll table-scroll"></div>
      </div>
    </div>

    <!-- slim KPI strip -->
    <div id="kpi-row" class="card kpi-strip"></div>

    <!-- collapsible charts, below the table -->
    <div class="card overflow-hidden">
      <button id="btn-charts" class="flex w-full items-center gap-2 p-3 text-left text-sm font-bold text-slate-700 hover:bg-slate-50">
        ${ICON.chart}<span class="font-display">Charts &amp; overviews</span>
        <span class="hidden text-xs font-normal text-slate-400 sm:inline">— category averages, top funds, 3-year consistency</span>
        <span class="chev ml-auto">▾</span></button>
      <div id="charts-body" class="hidden border-t border-slate-100 p-4">
        <div class="grid gap-4 lg:grid-cols-2">
          ${chartCard('chart-cat', 'Average 5Y return by peer group', 'Taller bar = the group’s funds grew faster on average over 5 years.')}
          ${chartCard('chart-top', 'Top funds by 5Y return', 'The 10 strongest 5-year performers currently in view.')}
          <div class="lg:col-span-2">${chartCard('chart-roll', '3-year consistency — rolling return range',
            'Each bar spans this fund’s worst-to-best annual return across every 3-year stretch; the dot is the average. Narrow = steady, wide = less predictable.',
            'Across every 3-year stretch this fund has lived through, your yearly return would have landed somewhere in this band. A narrow band = steady / dependable; a wide band = less predictable. The marker is the average.')}</div>
        </div>
      </div>
    </div>
  </div>`;

  buildGroupOptions();
  wire();
  render();
}

// ---- small HTML builders ---------------------------------------------------
function slider(id, label, min, max, step, anyAt) {
  return `<label class="block"><span class="lbl flex justify-between"><span>${label}</span><span id="${id}-val" class="font-semibold text-indigo-600">Any</span></span>
    <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${anyAt}" data-anyat="${anyAt}" class="range"></label>`;
}
function toggle(id, label) {
  return `<button id="${id}" data-on="0" class="toggle-off">${esc(label)}</button>`;
}
function chartCard(id, title, sub, tip) {
  const q = tip ? ` <span class="qmark align-middle" title="${esc(tip)}">?</span>` : '';
  return `<div class="card p-4"><div class="mb-1 flex items-center gap-2 text-sm font-bold text-slate-700">${ICON.chart}<span class="font-display">${esc(title)}</span>${q}</div>
    <div class="mb-2 text-xs text-slate-500">${esc(sub)}</div><div id="${id}" class="w-full"></div></div>`;
}

function buildGroupOptions() {
  const sel = root.querySelector('#f-group');
  const groups = orderGroups(Object.keys(state.categories));
  const div = groups.filter((g) => !isThematic(g) && !isIndex(g));
  const them = groups.filter(isThematic);
  const idx = groups.filter(isIndex);
  const opt = (g) => `<option value="${esc(g)}">${esc(g)} (${state.categories[g].n})</option>`;
  const nIndex = state.funds.filter((f) => f.isIndex).length;
  const nActive = state.funds.length - nIndex;
  sel.innerHTML = `<option value="">All funds (${state.funds.length})</option>` +
    `<option value="__active">All active funds (${nActive})</option>` +
    (nIndex ? `<option value="__index">All index funds (${nIndex})</option>` : '') +
    `<optgroup label="Active — diversified">${div.map(opt).join('')}</optgroup>` +
    `<optgroup label="Active — thematic">${them.map(opt).join('')}</optgroup>` +
    (idx.length ? `<optgroup label="Index (passive)">${idx.map(opt).join('')}</optgroup>` : '');
}

// ---- popover manager -------------------------------------------------------
function setPop(open, which) {
  for (const p of POPS) {
    const on = open && p.pop === which;
    const pe = root.querySelector('#' + p.pop), be = root.querySelector('#' + p.btn);
    pe.classList.toggle('hidden', !on);
    be.classList.toggle('ctl-btn-on', on);
    const chev = be.querySelector('.chev'); if (chev) chev.classList.toggle('chev-open', on);
    if (on && p.onOpen) p.onOpen();
  }
}

// ---- wiring ----------------------------------------------------------------
function readSlider(id, scale) {
  const el = root.querySelector('#' + id);
  const v = +el.value, anyAt = +el.dataset.anyat;
  return v === anyAt ? null : v * scale;
}
function wire() {
  root.querySelector('#f-group').addEventListener('change', (e) => { state.filters.peerGroup = e.target.value; render(); });

  const bindSlider = (id, scale, setter, fmt) => {
    const el = root.querySelector('#' + id), out = root.querySelector('#' + id + '-val');
    el.addEventListener('input', () => {
      const v = readSlider(id, scale); setter(v); out.textContent = v == null ? 'Any' : fmt(v); scheduleRender();
    });
  };
  bindSlider('f-min5y', 0.01, (v) => (state.filters.min5y = v), (v) => '≥ ' + (v * 100).toFixed(0) + '%');
  bindSlider('f-min10y', 0.01, (v) => (state.filters.min10y = v), (v) => '≥ ' + (v * 100).toFixed(0) + '%');
  bindSlider('f-sharpe', 0.1, (v) => (state.filters.minSharpe = v), (v) => '≥ ' + v.toFixed(1));
  bindSlider('f-maxvol', 0.01, (v) => (state.filters.maxVol = v), (v) => '≤ ' + (v * 100).toFixed(0) + '%');

  root.querySelector('#f-agemin').addEventListener('input', (e) => { state.filters.ageMin = e.target.value === '' ? null : +e.target.value; scheduleRender(); });
  root.querySelector('#f-agemax').addEventListener('input', (e) => { state.filters.ageMax = e.target.value === '' ? null : +e.target.value; scheduleRender(); });

  for (const [id, key] of [['f-beats5y', 'beats5y'], ['f-beats10y', 'beats10y'], ['f-has5y', 'has5y'], ['f-has10y', 'has10y']]) {
    root.querySelector('#' + id).addEventListener('click', (e) => { state.filters[key] = !state.filters[key]; syncToggle(e.currentTarget, state.filters[key]); render(); });
  }

  root.querySelector('#btn-reset').addEventListener('click', () => { resetFilters(); selected.clear(); syncControls(); render(); });
  root.querySelector('#tbl-search').addEventListener('input', (e) => { state.filters.search = e.target.value; scheduleRender(); });

  // presets
  root.querySelector('#btn-save-preset').addEventListener('click', () => {
    const name = prompt('Name this preset:'); if (name && name.trim()) { savePreset(name.trim()); renderPresetSelect(); }
  });
  root.querySelector('#preset-select').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === '__del') { renderPresetSelect(); return; }
    if (v) { loadPreset(v); syncControls(); render(); }
  });

  // popovers (Filters / Screening steps / Columns)
  for (const p of POPS) {
    root.querySelector('#' + p.btn).addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !root.querySelector('#' + p.pop).classList.contains('hidden');
      setPop(!isOpen, p.pop);
    });
  }
  document.addEventListener('click', (e) => {
    const inside = POPS.some((p) => root.querySelector('#' + p.pop).contains(e.target) || root.querySelector('#' + p.btn).contains(e.target));
    if (!inside) setPop(false);
  });

  // collapsible charts (lazy-render on first open, re-render while open)
  root.querySelector('#btn-charts').addEventListener('click', () => {
    const body = root.querySelector('#charts-body');
    const nowOpen = body.classList.contains('hidden');
    body.classList.toggle('hidden', !nowOpen);
    root.querySelector('#btn-charts .chev').classList.toggle('chev-open', nowOpen);
    if (nowOpen) renderCharts();
  });

  root.querySelector('#btn-csv').addEventListener('click', () => exportCSV(visibleFunds(), state.categories, state.status.data_as_of));
  root.querySelector('#btn-xlsx').addEventListener('click', () => {
    const visibleCodes = new Set(visibleFunds().map((f) => f.schemeCode));
    exportExcel(state.funds, visibleCodes, state.categories, state.status, activeChips().map((c) => c.label).join(', '));
  });

  // re-render table after shortlist stars change inside the table
  root.querySelector('#screener-table').addEventListener('mfs:rerender', () => renderTableView());
}

function syncToggle(btn, on) { btn.className = on ? 'toggle-on' : 'toggle-off'; btn.dataset.on = on ? '1' : '0'; }

function syncControls() {
  const f = state.filters;
  root.querySelector('#f-group').value = f.peerGroup;
  const s = (id, val, scale, fmt) => { const el = root.querySelector('#' + id), out = root.querySelector('#' + id + '-val'); el.value = val == null ? el.dataset.anyat : Math.round(val / scale); out.textContent = val == null ? 'Any' : fmt(val); };
  s('f-min5y', f.min5y, 0.01, (v) => '≥ ' + (v * 100).toFixed(0) + '%');
  s('f-min10y', f.min10y, 0.01, (v) => '≥ ' + (v * 100).toFixed(0) + '%');
  s('f-sharpe', f.minSharpe, 0.1, (v) => '≥ ' + v.toFixed(1));
  s('f-maxvol', f.maxVol, 0.01, (v) => '≤ ' + (v * 100).toFixed(0) + '%');
  root.querySelector('#f-agemin').value = f.ageMin ?? '';
  root.querySelector('#f-agemax').value = f.ageMax ?? '';
  syncToggle(root.querySelector('#f-beats5y'), f.beats5y);
  syncToggle(root.querySelector('#f-beats10y'), f.beats10y);
  syncToggle(root.querySelector('#f-has5y'), f.has5y);
  syncToggle(root.querySelector('#f-has10y'), f.has10y);
}

// ---- render ----------------------------------------------------------------
export function render() {
  renderKPIs();
  renderChips();
  renderFunnel();
  renderCharts();
  renderTableView();
  renderPresetSelect();
  emit(); // notify other tabs (e.g. shortlist count)
}

function renderKPIs() {
  const vis = visibleFunds();
  const best = vis.filter((f) => f.returns.y5 != null).sort((a, b) => b.returns.y5 - a.returns.y5)[0];
  const pg = state.filters.peerGroup;
  let catAvg, catAvgLabel;
  if (pg && state.categories[pg]) { catAvg = state.categories[pg].mean.y5; catAvgLabel = pg; }
  else { const vals = vis.map((f) => f.returns.y5).filter((v) => v != null); catAvg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; catAvgLabel = 'All funds in view'; }

  const item = (grad, label, value, sub) => `
    <div class="kpi-item">
      <div class="kpi-k">${esc(label)}</div>
      <div class="kpi-v" style="color:${grad}">${value}</div>
      <div class="kpi-sub" title="${esc(sub)}">${esc(sub)}</div>
    </div>`;
  const pgLabel = pg === '__active' ? 'Active funds only' : pg === '__index' ? 'Index funds only' : (pg || 'All peer groups');
  root.querySelector('#kpi-row').innerHTML =
    item('#4f46e5', 'Funds in view', String(scopeCount()), pgLabel) +
    item('#7c3aed', 'Passing filters', String(vis.length), 'after filters + screening steps') +
    item('#f59e0b', 'Best 5Y return', best ? pct(best.returns.y5) : '—', best ? best.name : 'no fund with 5Y') +
    item('#0ea5e9', 'Category avg 5Y', catAvg != null ? pct(catAvg) : '—', catAvgLabel);
}

function renderChips() {
  const chips = activeChips();
  // Filters-popover badge counts everything except the inline category + search controls.
  const popCount = chips.filter((c) => c.key !== 'peerGroup' && c.key !== 'search').length;
  const badge = root.querySelector('#filters-count');
  badge.textContent = popCount; badge.classList.toggle('hidden', popCount === 0);

  const row = root.querySelector('#chips-row');
  if (!chips.length) { row.classList.add('hidden'); row.innerHTML = ''; return; }
  row.classList.remove('hidden'); row.classList.add('flex');
  row.innerHTML = `<span class="text-xs font-semibold text-slate-400">Active:</span>` +
    chips.map((c) => `<button data-chip="${c.key}" class="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100">${esc(c.label)}<span class="text-indigo-400">✕</span></button>`).join('') +
    `<button id="chips-reset" class="ml-auto rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200">Clear all</button>`;
  row.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => { clearChip(b.dataset.chip); syncControls(); render(); }));
  row.querySelector('#chips-reset').addEventListener('click', () => { resetFilters(); selected.clear(); syncControls(); render(); });
}

function renderFunnel() {
  const base = filteredBase();
  const { steps } = runFunnel(base);
  const enabledN = steps.filter((s) => s.enabled).length;
  const badge = root.querySelector('#steps-count');
  badge.textContent = enabledN; badge.classList.toggle('hidden', enabledN === 0);

  const list = root.querySelector('#funnel-list');
  const maxN = Math.max(base.length, 1);
  const header = `<div class="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2">
      <span class="w-48 shrink-0 text-xs font-semibold text-slate-500">Start (after filters)</span>
      <div class="h-6 flex-1 rounded-full bg-slate-100"><div class="h-6 rounded-full" style="width:100%;background:linear-gradient(90deg,#c7d2fe,#a5b4fc)"></div></div>
      <span class="w-10 text-right text-sm font-bold tnum text-slate-700">${base.length}</span></div>`;
  const rows = steps.map((s) => {
    const w = Math.round((s.count / maxN) * 100);
    const barBg = s.enabled ? 'linear-gradient(90deg,#818cf8,#a855f7)' : '#e2e8f0';
    const extra = s.key === 'sharpe' ? funnelSlider('fn-sharpe', 0, 30, 1, Math.round(state.funnel.sharpe.min * 10))
      : s.key === 'maxdd' ? funnelSlider('fn-maxdd', -50, 0, 1, Math.round(state.funnel.maxdd.min * 100))
      : s.key === 'minScore' ? funnelSlider('fn-minscore', 0, 100, 5, state.funnel.minScore.min) : '';
    return `<div class="flex items-center gap-3 px-3 py-1">
      <button data-fn="${s.key}" class="w-48 shrink-0 text-left ${s.enabled ? '' : 'opacity-60'}">
        <span class="switch ${s.enabled ? 'switch-on' : ''}"><span class="knob"></span></span>
        <span class="ml-1.5 align-middle text-xs font-medium ${s.enabled ? 'text-slate-700' : 'text-slate-400'}">${esc(s.label)}</span></button>
      <div class="flex flex-1 items-center gap-2">
        <div class="h-6 flex-1 rounded-full bg-slate-100"><div class="h-6 rounded-full transition-all" style="width:${w}%;background:${barBg}"></div></div>
        ${extra}
      </div>
      <span class="w-10 text-right text-sm font-bold tnum ${s.enabled ? 'text-indigo-600' : 'text-slate-400'}">${s.count}</span></div>`;
  }).join('');
  const final = visibleFunds().length;
  const footer = `<div class="mt-1 flex items-center gap-3 rounded-lg bg-indigo-50 px-3 py-2">
      <span class="w-48 shrink-0 text-xs font-bold text-indigo-700">${ICON.star} Shortlist</span>
      <div class="h-6 flex-1 rounded-full bg-indigo-100"><div class="h-6 rounded-full" style="width:${Math.round((final / maxN) * 100)}%;background:linear-gradient(90deg,#6366f1,#4f46e5)"></div></div>
      <span class="w-10 text-right text-sm font-extrabold tnum text-indigo-700">${final}</span></div>`;
  list.innerHTML = header + rows + footer;

  list.querySelectorAll('[data-fn]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.fn; state.funnel[k].enabled = !state.funnel[k].enabled; render();
  }));
  const sh = root.querySelector('#fn-sharpe'); if (sh) sh.addEventListener('input', (e) => { state.funnel.sharpe.min = +e.target.value / 10; scheduleRender(); });
  const md = root.querySelector('#fn-maxdd'); if (md) md.addEventListener('input', (e) => { state.funnel.maxdd.min = +e.target.value / 100; scheduleRender(); });
  const ms = root.querySelector('#fn-minscore'); if (ms) ms.addEventListener('input', (e) => { state.funnel.minScore.min = +e.target.value; scheduleRender(); });
}
function funnelSlider(id, min, max, step, val) {
  return `<input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val}" class="range !w-24" title="drag to adjust">`;
}

function renderCharts() {
  const body = root.querySelector('#charts-body');
  if (!body || body.classList.contains('hidden')) return; // only draw when the panel is open
  categoryBar(root.querySelector('#chart-cat'), state.categories);
  const base = filteredBase();
  topFundsBar(root.querySelector('#chart-top'), base.length ? base : state.funds);
  rollingRange(root.querySelector('#chart-roll'), base.length ? base : state.funds);
}

function renderTableView() {
  const vis = visibleFunds();
  root.querySelector('#result-count').textContent = `${vis.length} shown`;
  renderTable(root.querySelector('#screener-table'), vis, state.categories);
}

function renderColPanel() {
  const panel = root.querySelector('#col-panel');
  const items = columnPickerItems();
  const group = (g, title) => `<div class="px-1 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">${title}</div>` +
    items.filter((i) => i.group === g).map((i) => `<label class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-slate-50">
      <input type="checkbox" data-col="${i.key}" ${i.on ? 'checked' : ''} class="h-4 w-4 rounded border-slate-300 accent-indigo-600">
      <span class="text-slate-700">${esc(i.label)}</span></label>`).join('');
  panel.innerHTML = group('core', 'Default columns') + group('extra', 'More columns');
  panel.querySelectorAll('[data-col]').forEach((cb) => cb.addEventListener('change', () => { toggleCol(cb.dataset.col); renderTableView(); }));
}

function renderPresetSelect() {
  const sel = root.querySelector('#preset-select');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">Presets…</option>` + state.presets.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('') +
    (state.presets.length ? `<option value="__del" disabled>──────</option>` : '');
  sel.value = cur && [...sel.options].some((o) => o.value === cur) ? cur : '';
}
