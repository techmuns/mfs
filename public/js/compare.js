// compare.js — the Compare tab: side-by-side metrics for up to 5 funds + a growth-of-₹10,000
// chart that aligns every fund to a COMMON start (the latest inception among the selected, so no
// line is extrapolated), rebased to ₹10,000, with a benchmark overlay and a "zoom to last
// correction" toggle.

import { state, emit } from './state.js';
import { esc, pct, num, fmtDate, groupColor, terFmt, aumFmt, ppFmt, vsFmt, ICON } from './meta.js';
import { scoreOf, scoreColor } from './score.js';
import { fetchNav, rebase, benchToSeries } from './navapi.js';
import { growth10k, disposeChart } from './charts.js';

const PALETTE = ['#6366f1', '#ec4899', '#0ea5e9', '#10b981', '#f59e0b'];
const shortName = (n) => (n.length > 30 ? n.slice(0, 28) + '…' : n);
export const compareFunds = () => state.compareFunds.map((c) => state.funds.find((f) => f.schemeCode === c)).filter(Boolean);

// Side-by-side rows: better = which direction wins (for best-cell highlight).
const ROWS = [
  { label: '3Y CAGR', get: (f) => f.returns.y3, fmt: pct, better: 'high' },
  { label: '5Y CAGR', get: (f) => f.returns.y5, fmt: pct, better: 'high' },
  { label: '10Y CAGR', get: (f) => f.returns.y10, fmt: pct, better: 'high' },
  { label: '5Y vs category', get: (f) => (f.vsCategory.y5 ? f.vsCategory.y5.ratio : null), fmt: (v, f) => vsFmt(f.vsCategory.y5), better: 'high' },
  { label: '10Y vs category', get: (f) => (f.vsCategory.y10 ? f.vsCategory.y10.ratio : null), fmt: (v, f) => vsFmt(f.vsCategory.y10), better: 'high' },
  { label: '5Y benchmark excess', get: (f) => (f.benchmark && f.benchmark.excess ? f.benchmark.excess.y5 : null), fmt: ppFmt, better: 'high' },
  { label: '3Y rolling avg', get: (f) => (f.rolling.y3 ? f.rolling.y3.avg : null), fmt: pct, better: 'high' },
  { label: '3Y rolling % positive', get: (f) => (f.rolling.y3 ? f.rolling.y3.pctPositive : null), fmt: (v) => pct(v, 0), better: 'high' },
  { label: '5Y rolling avg', get: (f) => (f.rolling.y5 ? f.rolling.y5.avg : null), fmt: pct, better: 'high' },
  { label: 'Sharpe', get: (f) => f.risk.sharpe, fmt: (v) => num(v, 2), better: 'high' },
  { label: 'Volatility', get: (f) => f.risk.volatility, fmt: pct, better: 'low' },
  { label: 'Max drawdown', get: (f) => f.risk.maxDrawdown, fmt: pct, better: 'high' },
  { label: 'TER (direct)', get: (f) => (f.costs ? f.costs.terDirect : null), fmt: terFmt, better: 'low' },
  { label: 'AUM', get: (f) => (f.aum ? f.aum.cr : null), fmt: aumFmt, better: 'high' },
  { label: 'Age (yrs)', get: (f) => f.ageYears, fmt: (v) => num(v, 1), better: 'high' },
  { label: 'Lead manager tenure', get: (f) => (f.manager && f.manager.names.length ? Math.max(...f.manager.names.map((m) => m.tenureYears || 0)) : null), fmt: (v) => (v == null ? null : v.toFixed(1) + 'y'), better: 'high' },
  { label: 'Composite score', get: (f) => scoreOf(f), fmt: (v) => (v == null ? null : Math.round(v).toString()), better: 'high', score: true },
];

let openDetailFn = null;
export function setCompareDetailHandler(fn) { openDetailFn = fn; }

export function renderCompare(container) {
  const funds = compareFunds();
  if (!funds.length) {
    container.innerHTML = `<div class="card grid place-items-center p-12 text-center"><div class="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">${ICON.compare}</div>
      <h2 class="font-display text-lg font-bold text-slate-700">Compare up to 5 funds</h2>
      <p class="mx-auto mt-1 max-w-sm text-sm text-slate-500">Tick funds in the Screener and hit <b>Compare</b>, or open your Shortlist. They’ll line up side-by-side here with a growth-of-₹10,000 chart.</p>
      ${state.shortlist.size ? `<button id="cmp-from-shortlist" class="mt-3 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">Compare my ${state.shortlist.size} shortlisted</button>` : ''}</div>`;
    const b = container.querySelector('#cmp-from-shortlist');
    if (b) b.addEventListener('click', () => { state.compareFunds = [...state.shortlist].slice(0, 5); renderCompare(container); });
    return;
  }

  const chips = funds.map((f, i) => `<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold" style="background:${PALETTE[i]}1a;color:${PALETTE[i]}"><span class="h-2 w-2 rounded-full" style="background:${PALETTE[i]}"></span>${esc(shortName(f.name))}<button data-rm="${f.schemeCode}" class="ml-0.5 text-slate-400 hover:text-rose-500">✕</button></span>`).join('');

  const best = (row) => {
    const vals = funds.map((f) => row.get(f));
    const valid = vals.filter((v) => v != null && isFinite(v));
    if (!valid.length) return -1;
    const target = row.better === 'low' ? Math.min(...valid) : Math.max(...valid);
    return vals.findIndex((v) => v === target);
  };

  const headCells = funds.map((f, i) => `<th class="px-3 py-2 text-left align-bottom"><div class="h-1 w-full rounded-full" style="background:${PALETTE[i]}"></div><button data-open="${f.schemeCode}" class="mt-1 block max-w-[150px] truncate text-left text-xs font-bold text-slate-700 hover:text-indigo-600">${esc(f.name)}</button><div class="text-[10px] font-normal text-slate-400">${esc(f.peerGroup)}</div></th>`).join('');
  const rowsHtml = ROWS.map((row) => {
    const bi = best(row);
    const cells = funds.map((f, i) => {
      const v = row.get(f);
      const disp = v == null ? '<span class="v-na">N/A</span>' : (row.score ? `<span class="rounded-md px-1.5 py-0.5 font-bold text-white" style="background:${scoreColor(v)}">${esc(row.fmt(v, f))}</span>` : esc(row.fmt(v, f)));
      return `<td class="num px-3 py-2 tnum ${i === bi ? 'bg-emerald-50 font-bold text-emerald-700' : ''}">${disp}${i === bi && !row.score ? ' <span class="text-[10px] text-emerald-500">●</span>' : ''}</td>`;
    }).join('');
    return `<tr class="border-t border-slate-100"><td class="px-3 py-2 text-left text-xs font-medium text-slate-500">${row.label}</td>${cells}</tr>`;
  }).join('');

  container.innerHTML = `<div class="space-y-4">
    <div class="card p-4">
      <div class="mb-2 flex flex-wrap items-center gap-2"><h2 class="flex items-center gap-2 font-display text-sm font-bold text-slate-700">${ICON.compare}Comparing ${funds.length} fund${funds.length > 1 ? 's' : ''}</h2>
        <button id="cmp-clear" class="ml-auto rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200">Clear</button></div>
      <div class="flex flex-wrap gap-1.5">${chips}</div>
    </div>
    <div class="card p-4">
      <div class="mb-1 flex flex-wrap items-center gap-2"><h3 class="flex items-center gap-2 font-display text-sm font-bold text-slate-700">${ICON.chart}Growth of ₹10,000</h3>
        <span class="cmp-start text-[11px] text-slate-400"></span>
        <label class="ml-auto flex items-center gap-1.5 text-xs text-slate-500"><input type="checkbox" id="cmp-bench" class="h-3.5 w-3.5 rounded accent-indigo-600">benchmark</label>
        <button id="cmp-zoom" class="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200">Zoom to last correction</button></div>
      <div class="cmp-chart h-72 w-full rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-100"></div>
      <div class="cmp-chart-msg mt-1 text-center text-[11px] text-slate-400">Loading live NAV for each fund…</div>
    </div>
    <div class="card overflow-hidden"><div class="table-scroll overflow-x-auto"><table class="w-full text-sm"><thead><tr class="bg-slate-50/60"><th class="px-3 py-2"></th>${headCells}</tr></thead><tbody>${rowsHtml}</tbody></table></div>
      <p class="px-3 py-2 text-[11px] text-slate-400">Green = best value in the row. Research only — not investment advice.</p></div>
  </div>`;

  container.querySelector('#cmp-clear').addEventListener('click', () => { state.compareFunds = []; renderCompare(container); emit(); });
  container.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { state.compareFunds = state.compareFunds.filter((c) => c !== +b.dataset.rm); renderCompare(container); }));
  container.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { const f = state.funds.find((x) => x.schemeCode === +b.dataset.open); if (f && openDetailFn) openDetailFn(f); }));

  // growth chart (live)
  let zoomStart = null, showBench = false;
  const chartEl = container.querySelector('.cmp-chart'), msgEl = container.querySelector('.cmp-chart-msg'), startEl = container.querySelector('.cmp-start');
  let loaded = null;
  async function loadAndDraw() {
    if (!loaded) {
      const got = await Promise.all(funds.map((f) => fetchNav(f.schemeCode).then((n) => ({ f, n })).catch(() => ({ f, n: null }))));
      loaded = got;
    }
    const ok = loaded.filter((x) => x.n && x.n.length);
    const dropped = loaded.filter((x) => !x.n || !x.n.length).map((x) => x.f.name);
    if (!ok.length) { msgEl.innerHTML = '<span class="text-rose-500">Could not load NAV for the selected funds.</span>'; return; }
    const commonStart = Math.max(...ok.map((x) => x.n[0][0]));
    const from = zoomStart || commonStart;
    const seriesList = ok.map((x, i) => ({ name: shortName(x.f.name), color: PALETTE[loaded.indexOf(x) % PALETTE.length], data: rebase(x.n.filter((p) => p[0] >= from), 10000) }));
    // optional benchmark overlay (use the first fund's benchmark)
    if (showBench) {
      const bi = ok[0].f.benchmark && ok[0].f.benchmark.indexName, bench = bi ? (state.benchmarks || {})[bi] : null;
      if (bench) seriesList.push({ name: bi + ' TRI', color: '#94a3b8', data: rebase(benchToSeries(bench).filter((p) => p[0] >= from), 10000) });
    }
    growth10k(chartEl, seriesList);
    startEl.textContent = `aligned from ${fmtDate(new Date(commonStart).toISOString())} (common start)${zoomStart ? ' · zoomed to last correction' : ''}`;
    msgEl.textContent = dropped.length ? `No history for: ${dropped.join(', ')}` : 'Each fund rebased to ₹10,000 at the common start · live NAV (MFAPI)';
  }
  container.querySelector('#cmp-bench').addEventListener('change', (e) => { showBench = e.target.checked; loadAndDraw(); });
  container.querySelector('#cmp-zoom').addEventListener('click', (e) => {
    if (zoomStart) { zoomStart = null; e.target.textContent = 'Zoom to last correction'; }
    else {
      const ref = loaded && loaded.find((x) => x.n && x.n.length);
      const corr = ref ? findLastCorrection(ref.n) : null;
      if (corr) { zoomStart = corr; e.target.textContent = 'Reset zoom'; }
      else { msgEl.textContent = 'No 10%+ correction found in the common window.'; return; }
    }
    loadAndDraw();
  });
  loadAndDraw();
}

// Most recent peak preceding a >=10% drawdown; returns the peak timestamp or null.
function findLastCorrection(series) {
  let peak = -Infinity, peakT = null, bestPeakT = null;
  for (const [t, v] of series) {
    if (v > peak) { peak = v; peakT = t; }
    if (peak > 0 && v / peak - 1 <= -0.10) bestPeakT = peakT;
  }
  return bestPeakT;
}
