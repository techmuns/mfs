// app.js — entry point. Loads the committed JSON once, builds the header + tabs + 🔔 bell, and
// wires the Screener, Fund Details, Compare, Shortlist and Data Status tabs together.

import { state, subscribe, emit, removeShortlist, clearShortlist } from './state.js';
import { esc, pct, num, fmtDate, groupColor, orderGroups, ICON, GROUP_COLOR } from './meta.js';
import { mountScreener, render as renderScreener } from './screener.js';
import { setDrillHandler, setCompareHandler, setChangeHandler } from './table.js';
import { openDetail, renderDetail, setDetailChangeHandler } from './detail.js';
import { renderCompare, setCompareDetailHandler } from './compare.js';
import { updateBadge as updateAlertsBadge, openBell, setAlertsDetailHandler } from './alerts.js';
import { scoreOf, scoreColor } from './score.js';

const DATA = {
  funds: './data/funds.json', categories: './data/categories.json', status: './data/status.json',
  benchmarks: './data/benchmarks.json', alerts: './data/alerts.json',
};
let detailFund = null; // fund shown in the Fund Details tab

async function loadJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

function setTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('[data-tabbtn]').forEach((b) => {
    const on = b.dataset.tabbtn === tab;
    b.className = `tabbtn ${on ? 'tabbtn-on' : ''}`;
  });
  document.querySelectorAll('[data-tabpanel]').forEach((p) => p.classList.toggle('hidden', p.dataset.tabpanel !== tab));
  if (tab === 'screener') renderScreener();
  if (tab === 'detail') renderFundDetails();
  if (tab === 'shortlist') renderShortlist();
  if (tab === 'status') renderStatus();
  if (tab === 'compare') renderCompare(document.getElementById('tab-compare'));
}

// Open a fund's detail: in the slide-in (default) or routed to the Fund Details tab.
function showFund(f, inTab) {
  if (inTab) { detailFund = f; setTab('detail'); } else openDetail(f);
}

// ---- header ----------------------------------------------------------------
function renderHeader() {
  document.getElementById('live-chip').innerHTML =
    `<span class="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400"></span>Live · Updated ${fmtDate(state.status.data_as_of)}`;

  // Global typeahead
  const input = document.getElementById('global-search');
  const drop = document.getElementById('search-drop');
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      if (!q) { drop.classList.add('hidden'); return; }
      const hits = state.funds.filter((f) => f.name.toLowerCase().includes(q) || (f.amc || '').toLowerCase().includes(q)).slice(0, 8);
      drop.innerHTML = hits.length ? hits.map((f) => `<button data-code="${f.schemeCode}" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50">
          <span class="h-2 w-2 shrink-0 rounded-full" style="background:${groupColor(f.peerGroup)}"></span>
          <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium text-slate-700">${esc(f.name)}</span>
          <span class="block truncate text-[11px] text-slate-400">${esc(f.peerGroup)} · ${esc(f.amc || '')}</span></span>
          <span class="tnum text-xs font-semibold ${f.returns.y5 >= 0 ? 'v-pos' : 'v-neg'}">${pct(f.returns.y5) ?? ''}</span></button>`).join('')
        : '<div class="px-3 py-3 text-sm text-slate-400">No matching fund.</div>';
      drop.classList.remove('hidden');
    }, 150);
  });
  drop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-code]'); if (!b) return;
    const f = state.funds.find((x) => x.schemeCode === +b.dataset.code);
    if (f) { openDetail(f); drop.classList.add('hidden'); input.value = ''; }
  });
  document.addEventListener('click', (e) => { if (!drop.contains(e.target) && e.target !== input) drop.classList.add('hidden'); });

  // Sources modal
  document.getElementById('btn-sources').addEventListener('click', openSources);
}

function openSources() {
  const s = state.status;
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `<div class="modal-backdrop fixed inset-0 z-[60] grid place-items-center bg-slate-900/40 p-4">
    <div class="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
      <div class="mb-3 flex items-center justify-between"><h2 class="font-display text-lg font-bold text-slate-800">Data sources</h2>
        <button class="modal-x rounded-lg p-1 text-slate-400 hover:bg-slate-100">${ICON.close}</button></div>
      <div class="space-y-3 text-sm">
        ${s.sources.map((src) => `<div class="rounded-xl bg-slate-50 p-3">
          <div class="font-semibold text-slate-700">${esc(src.name)}</div>
          <a href="${esc(src.url)}" target="_blank" rel="noopener" class="break-all text-xs text-indigo-500 underline decoration-dotted">${esc(src.url)}</a>
          <div class="mt-1 text-xs text-slate-500">${esc(src.note || '')} · as of ${esc(fmtDate(src.asOf))}</div></div>`).join('')}
        <div class="rounded-xl bg-slate-50 p-3"><div class="font-semibold text-slate-700">Risk-free rate</div>
          <div class="text-xs text-slate-500">${(s.riskFreeRate.annual_rate * 100).toFixed(2)}% — ${esc(s.riskFreeRate.source)}, as of ${esc(fmtDate(s.riskFreeRate.as_of))}</div></div>
      </div>
      <p class="mt-3 text-xs text-slate-400">Research only — not investment advice. Figures are computed from real NAV history; insufficient history shows N/A.</p>
    </div></div>`;
  const close = () => (modal.innerHTML = '');
  modal.querySelector('.modal-x').addEventListener('click', close);
  modal.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) close(); });
}

// ---- Shortlist tab ---------------------------------------------------------
function renderShortlist() {
  const el = document.getElementById('tab-shortlist');
  const funds = state.funds.filter((f) => state.shortlist.has(f.schemeCode));
  if (!funds.length) {
    el.innerHTML = emptyState(ICON.star, 'Your shortlist is empty', 'Tick funds in the Screener and hit “Add to Shortlist”, or ☆ a fund from its detail panel. Your picks are saved in this browser.');
    return;
  }
  const row = (f) => `<tr class="cursor-pointer hover:bg-slate-50" data-code="${f.schemeCode}">
    <td class="px-3 py-2"><div class="font-semibold text-slate-800">${esc(f.name)}</div><div class="text-[11px] text-slate-400">${esc(f.amc || '')}</div></td>
    <td class="px-3 py-2"><span class="pill" style="background:${groupColor(f.peerGroup)}1a;color:${groupColor(f.peerGroup)}">${esc(f.peerGroup)}</span></td>
    ${numTd(f.returns.y5)}${numTd(f.returns.y10)}${numTd(f.rolling.y3 ? f.rolling.y3.avg : null)}
    <td class="num px-3 py-2 tnum">${num(f.risk.sharpe, 2) ?? 'N/A'}</td>${numTd(f.risk.volatility)}${numTd(f.risk.maxDrawdown)}
    <td class="px-3 py-2 text-right"><button data-rm="${f.schemeCode}" class="rounded-lg bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-100">Remove</button></td></tr>`;
  el.innerHTML = `<div class="card overflow-hidden">
    <div class="flex items-center gap-2 border-b border-slate-100 p-3">
      <h2 class="flex items-center gap-2 font-display text-sm font-bold text-slate-700">${ICON.star}Shortlist <span class="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-600">${funds.length}</span></h2>
      <button id="sl-clear" class="ml-auto rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200">Clear all</button></div>
    <div class="table-scroll overflow-x-auto"><table class="w-full text-sm"><thead>
      <tr class="border-b border-slate-200 bg-slate-50/60 text-xs font-semibold uppercase tracking-wide text-slate-500">
      <th class="px-3 py-2 text-left">Fund</th><th class="px-3 py-2 text-left">Category</th>
      <th class="num px-3 py-2 text-right">5Y</th><th class="num px-3 py-2 text-right">10Y</th><th class="num px-3 py-2 text-right">3Y Roll</th>
      <th class="num px-3 py-2 text-right">Sharpe</th><th class="num px-3 py-2 text-right">Vol</th><th class="num px-3 py-2 text-right">Max DD</th><th></th></tr></thead>
      <tbody class="divide-y divide-slate-100">${funds.map(row).join('')}</tbody></table></div></div>`;
  el.querySelector('#sl-clear').addEventListener('click', () => { clearShortlist(); renderShortlist(); emit(); });
  el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeShortlist(+b.dataset.rm); renderShortlist(); emit(); }));
  el.querySelectorAll('tr[data-code]').forEach((tr) => tr.addEventListener('click', () => { const f = state.funds.find((x) => x.schemeCode === +tr.dataset.code); if (f) openDetail(f); }));
}
const numTd = (v) => `<td class="num px-3 py-2 tnum ${v == null ? 'v-na' : v >= 0 ? 'v-pos' : 'v-neg'}">${pct(v) ?? 'N/A'}</td>`;

// ---- Fund Details tab (inline detail view + a fund picker) ------------------
function renderFundDetails() {
  const el = document.getElementById('tab-detail');
  const f = detailFund || state.funds.find((x) => x.score && x.score.composite != null) || state.funds[0];
  detailFund = f;
  el.innerHTML = `<div class="mb-3 flex flex-wrap items-center gap-2">
      <label class="text-xs font-semibold uppercase tracking-wide text-slate-500">Fund</label>
      <input id="fd-search" type="search" placeholder="Pick or search a fund…" value="${esc(f ? f.name : '')}" class="inp !w-80 !py-2 text-sm" autocomplete="off">
      <div id="fd-drop" class="relative"></div>
    </div>
    <div id="fd-view" class="card overflow-hidden"></div>`;
  if (f) renderDetail(el.querySelector('#fd-view'), f, { slide: false });

  const inp = el.querySelector('#fd-search');
  const drop = document.createElement('div');
  drop.className = 'absolute z-30 mt-1 hidden max-h-80 w-80 overflow-y-auto rounded-xl bg-white py-1 shadow-xl ring-1 ring-slate-200';
  el.querySelector('#fd-drop').appendChild(drop);
  inp.addEventListener('focus', () => inp.select());
  inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    const hits = (q ? state.funds.filter((x) => x.name.toLowerCase().includes(q) || (x.amc || '').toLowerCase().includes(q)) : state.funds).slice(0, 10);
    drop.innerHTML = hits.map((x) => `<button data-code="${x.schemeCode}" class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50"><span class="min-w-0"><span class="block truncate text-sm font-medium text-slate-700">${esc(x.name)}</span><span class="block truncate text-[11px] text-slate-400">${esc(x.peerGroup)}</span></span><span class="tnum text-xs font-bold" style="color:${scoreColor(scoreOf(x))}">${scoreOf(x) == null ? '' : Math.round(scoreOf(x))}</span></button>`).join('');
    drop.classList.remove('hidden');
  });
  drop.addEventListener('click', (e) => { const b = e.target.closest('[data-code]'); if (!b) return; detailFund = state.funds.find((x) => x.schemeCode === +b.dataset.code); drop.classList.add('hidden'); renderFundDetails(); });
  document.addEventListener('click', (e) => { if (!drop.contains(e.target) && e.target !== inp) drop.classList.add('hidden'); });
}

// ---- Data Status tab -------------------------------------------------------
function renderStatus() {
  const el = document.getElementById('tab-status');
  const s = state.status, c = s.counts;
  const tile = (label, value, accent, sub) => `<div class="card p-4"><div class="text-xs font-medium text-slate-400">${esc(label)}</div>
    <div class="mt-1 font-display text-2xl font-extrabold tnum" style="color:${accent}">${esc(value)}</div>${sub ? `<div class="text-[11px] text-slate-400">${esc(sub)}</div>` : ''}</div>`;
  const groups = orderGroups(Object.keys(state.categories));
  const maxN = Math.max(...groups.map((g) => state.categories[g].n));
  const bars = groups.map((g) => { const n = state.categories[g].n, col = GROUP_COLOR[g] || '#64748b';
    return `<div class="flex items-center gap-2"><span class="w-44 shrink-0 truncate text-xs text-slate-500" title="${esc(g)}">${esc(g)}</span>
      <div class="h-4 flex-1 rounded-full bg-slate-100"><div class="h-4 rounded-full" style="width:${Math.round(n / maxN * 100)}%;background:${col}"></div></div>
      <span class="w-8 text-right text-xs font-semibold tnum text-slate-600">${n}</span></div>`; }).join('');
  const live = ['Returns (1M–10Y, since inception) & 3Y/5Y rolling', 'Risk: volatility, Sharpe, Sortino, max drawdown', 'Peer-group averages & vs-category', 'Benchmark excess vs Total Return Index (NAV+TRI overlay)', 'Fees (TER), AUM, riskometer, managers, exit load', 'Explainable composite score (re-weightable)', 'Fund-detail page, compare up to 5, 🔔 what’s-new alerts'];
  const soon = ['Portfolio holdings & sector mix (out of scope for now)'];

  const cov = s.coverage;
  const covCard = cov ? (() => {
    const row = (label, n, grad) => `<div class="flex items-center gap-2"><span class="w-36 shrink-0 text-xs text-slate-500">${label}</span>
      <div class="h-4 flex-1 rounded-full bg-slate-100"><div class="h-4 rounded-full" style="width:${Math.round(n / cov.total * 100)}%;background:${grad}"></div></div>
      <span class="w-20 text-right text-xs font-semibold tnum text-slate-600">${n}/${cov.total}</span></div>`;
    return `<div class="card p-4"><h3 class="mb-3 font-display text-sm font-bold text-slate-700">Field coverage</h3><div class="space-y-1.5">
      ${row('Benchmark (TRI) excess', cov.benchmark, 'linear-gradient(90deg,#6366f1,#4f46e5)')}
      ${row('Composite score', cov.score ?? 0, 'linear-gradient(90deg,#8b5cf6,#6d28d9)')}
      ${row('Expense ratio (TER)', cov.ter, 'linear-gradient(90deg,#a855f7,#7c3aed)')}
      ${row('Fund size (AUM)', cov.aum, 'linear-gradient(90deg,#38bdf8,#0ea5e9)')}
      ${row('Fund manager', cov.manager, 'linear-gradient(90deg,#10b981,#059669)')}
      ${row('Exit load', cov.exitLoad, 'linear-gradient(90deg,#f59e0b,#d97706)')}
      ${row('Riskometer', cov.riskometer, 'linear-gradient(90deg,#14b8a6,#0d9488)')}
    </div><p class="mt-2 text-[11px] text-slate-400">Gaps are genuine non-disclosures or (for benchmark) funds with no mappable Nifty TRI — shown as N/A with a reason, never faked.</p></div>`;
  })() : '';
  el.innerHTML = `
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      ${tile('Funds', c.equityDirectGrowth, '#4f46e5', 'equity · Direct · Growth')}
      ${tile('≥ 5Y history', c.with5y, '#8b5cf6', `${c.with3y} have ≥ 3Y · ${c.with10y} have ≥ 10Y`)}
      ${tile('Peer groups', c.peerGroups ?? Object.keys(state.categories).length, '#10b981', 'incl. thematic splits')}
      ${tile('Risk-free rate', (s.riskFreeRate.annual_rate * 100).toFixed(2) + '%', '#f59e0b', 'used in Sharpe')}
    </div>
    ${covCard ? `<div class="mt-4">${covCard}</div>` : ''}
    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <div class="card p-4"><h3 class="mb-3 font-display text-sm font-bold text-slate-700">Funds per peer group</h3><div class="space-y-1.5">${bars}</div></div>
      <div class="space-y-4">
        <div class="card p-4"><h3 class="mb-2 font-display text-sm font-bold text-slate-700">Sources</h3>
          <div class="space-y-2 text-sm">${s.sources.map((src) => `<div><a href="${esc(src.url)}" target="_blank" rel="noopener" class="font-medium text-indigo-600 underline decoration-dotted">${esc(src.name)}</a> <span class="text-xs text-slate-400">as of ${esc(fmtDate(src.asOf))}</span><div class="text-xs text-slate-500">${esc(src.note || '')}</div></div>`).join('')}
          <div class="border-t border-slate-100 pt-2 text-xs text-slate-500">Risk-free: ${esc(s.riskFreeRate.source)}, as of ${esc(fmtDate(s.riskFreeRate.as_of))}. Updated ${esc(new Date(s.generated_at).toUTCString())}.</div></div></div>
        <div class="card p-4"><div class="grid grid-cols-2 gap-4">
          <div><h3 class="mb-2 font-display text-xs font-bold uppercase tracking-wide text-emerald-600">Live now</h3><ul class="space-y-1 text-xs text-slate-600">${live.map((x) => `<li class="flex gap-1.5"><span class="text-emerald-500">✓</span>${esc(x)}</li>`).join('')}</ul></div>
          <div><h3 class="mb-2 font-display text-xs font-bold uppercase tracking-wide text-slate-400">Not included</h3><ul class="space-y-1 text-xs text-slate-400">${soon.map((x) => `<li class="flex gap-1.5"><span>◦</span>${esc(x)}</li>`).join('')}</ul></div>
        </div></div>
      </div>
    </div>`;
}

function emptyState(icon, title, sub) {
  return `<div class="card grid place-items-center p-12 text-center"><div class="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">${icon}</div>
    <h2 class="font-display text-lg font-bold text-slate-700">${esc(title)}</h2><p class="mx-auto mt-1 max-w-sm text-sm text-slate-500">${esc(sub)}</p></div>`;
}

// ---- boot ------------------------------------------------------------------
async function init() {
  try {
    const [funds, categories, status, benchmarks, alerts] = await Promise.all([
      loadJSON(DATA.funds), loadJSON(DATA.categories), loadJSON(DATA.status),
      loadJSON(DATA.benchmarks).catch(() => ({})), loadJSON(DATA.alerts).catch(() => ({ events: [] })),
    ]);
    state.funds = funds; state.categories = categories; state.status = status;
    state.benchmarks = benchmarks; state.alerts = alerts;

    document.getElementById('app-loading').remove();
    document.getElementById('app-shell').classList.remove('hidden');

    renderHeader();
    setDrillHandler(openDetail);
    setCompareHandler((codes) => { state.compareFunds = codes.slice(0, 5); setTab('compare'); });
    setChangeHandler(() => { updateShortlistBadge(); if (state.activeTab === 'shortlist') renderShortlist(); });
    // Re-weighting the score or shortlisting from a detail view refreshes the open tab.
    setDetailChangeHandler(() => { updateShortlistBadge(); if (state.activeTab === 'screener') renderScreener(); if (state.activeTab === 'shortlist') renderShortlist(); if (state.activeTab === 'compare') renderCompare(document.getElementById('tab-compare')); });
    setCompareDetailHandler(openDetail);
    setAlertsDetailHandler(openDetail);

    document.querySelectorAll('[data-tabbtn]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tabbtn)));
    document.getElementById('btn-bell').addEventListener('click', (e) => { e.stopPropagation(); openBell(); });
    subscribe(updateShortlistBadge);

    mountScreener(document.getElementById('tab-screener'));
    updateShortlistBadge();
    updateAlertsBadge();
    setTab('screener');
  } catch (err) {
    console.error(err);
    const l = document.getElementById('app-loading');
    if (l) l.innerHTML = `<div class="text-center"><div class="text-rose-500">Couldn’t load fund data.</div><div class="mt-1 text-sm text-slate-400">Please refresh in a moment.</div></div>`;
  }
}
function updateShortlistBadge() {
  const b = document.getElementById('shortlist-badge');
  if (!b) return;
  const n = state.shortlist.size;
  b.textContent = n; b.classList.toggle('hidden', n === 0);
}

init();
