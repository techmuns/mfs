// drill.js — the fund detail slide-in panel. Static metrics come from funds.json; the NAV
// growth chart is fetched LIVE from MFAPI (CORS-enabled) only when a fund is opened.

import { state, inShortlist, toggleShortlist } from './state.js';
import { esc, pct, pctSigned, num, fmtDate, groupColor, terFmt, aumFmt, ppFmt } from './meta.js';
import { navLine, disposeChart } from './charts.js';

const navCache = new Map(); // schemeCode -> [[ts, nav], ...] ascending
let onChange = null;
export function setDrillChangeHandler(fn) { onChange = fn; }

const RANGES = [['1Y', 1], ['3Y', 3], ['5Y', 5], ['Max', null]];

function statTile(label, value, sub) {
  return `<div class="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
    <div class="text-[11px] font-medium text-slate-400">${esc(label)}</div>
    <div class="mt-0.5 font-display text-lg font-bold tnum text-slate-800">${esc(value)}</div>
    ${sub ? `<div class="text-[11px] text-slate-400">${esc(sub)}</div>` : ''}</div>`;
}
function retCell(label, v) {
  const cls = v == null ? 'v-na' : v > 0 ? 'v-pos' : v < 0 ? 'v-neg' : 'v-zero';
  return `<div class="flex items-center justify-between border-b border-slate-100 py-1.5"><span class="text-xs text-slate-500">${label}</span><span class="tnum text-sm font-semibold ${cls}">${pct(v) ?? 'N/A'}</span></div>`;
}
function vsBadge(label, vs) {
  if (!vs || vs.ratio == null) return `<div class="rounded-lg bg-slate-50 px-2.5 py-1.5 text-center"><div class="text-[10px] text-slate-400">${label}</div><div class="text-xs font-semibold text-slate-300">N/A</div></div>`;
  const up = vs.ratio >= 1;
  return `<div class="rounded-lg px-2.5 py-1.5 text-center" style="background:${up ? '#ecfdf5' : '#fff1f2'}">
    <div class="text-[10px] ${up ? 'text-emerald-600' : 'text-rose-600'}">${label}</div>
    <div class="text-xs font-bold ${up ? 'text-emerald-700' : 'text-rose-700'}">${vs.ratio.toFixed(2)}× <span class="font-medium">${pctSigned(vs.ppGap)}</span></div></div>`;
}

export function openDrill(f) {
  const root = document.getElementById('drill-root');
  const c = groupColor(f.peerGroup);
  const r = f.returns, rk = f.risk;
  const roll = (o, lab) => o
    ? `<div class="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100"><div class="mb-1 text-xs font-semibold text-slate-500">${lab}</div>
         <div class="grid grid-cols-4 gap-1 text-center">
           <div><div class="text-[10px] text-slate-400">Worst</div><div class="tnum text-sm font-semibold v-neg">${pct(o.min)}</div></div>
           <div><div class="text-[10px] text-slate-400">Avg</div><div class="tnum text-sm font-bold text-slate-800">${pct(o.avg)}</div></div>
           <div><div class="text-[10px] text-slate-400">Best</div><div class="tnum text-sm font-semibold v-pos">${pct(o.max)}</div></div>
           <div><div class="text-[10px] text-slate-400">% +ve</div><div class="tnum text-sm font-semibold text-indigo-600">${pct(o.pctPositive, 0)}</div></div>
         </div><div class="mt-1 text-[10px] text-slate-400">${o.n} windows</div></div>`
    : `<div class="rounded-xl bg-slate-50 p-3 text-xs text-slate-400 ring-1 ring-inset ring-slate-100">${lab}: not enough history</div>`;

  root.innerHTML = `
  <div class="drill-backdrop fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-sm"></div>
  <aside class="drill-panel fixed right-0 top-0 z-50 flex h-full w-full max-w-[560px] flex-col bg-white shadow-2xl">
    <header class="flex items-start gap-3 border-b border-slate-100 p-5" style="background:linear-gradient(135deg, ${c}14, transparent)">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2"><span class="pill" style="background:${c}1a;color:${c}">${esc(f.peerGroup)}</span>
          <span class="text-[11px] text-slate-400">${esc(f.category)}</span></div>
        <h2 class="mt-1 font-display text-xl font-extrabold leading-tight text-slate-900">${esc(f.name)}</h2>
        <p class="text-xs text-slate-500">${esc(f.amc || '')} · Direct · Growth</p>
      </div>
      <button class="drill-close rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-5 w-5"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </header>

    <div class="flex-1 overflow-y-auto p-5">
      <div class="grid grid-cols-3 gap-2">
        ${statTile('Latest NAV', '₹' + num(f.latestNav, 2), fmtDate(f.latestNavDate))}
        ${statTile('Age', num(f.ageYears, 1) + ' yrs', 'since ' + fmtDate(f.inceptionDate))}
        ${statTile('Since incep.', pct(r.si) ?? 'N/A', 'annualised')}
      </div>

      <section class="mt-4">
        <h3 class="mb-2 font-display text-sm font-bold text-slate-700">Fund facts</h3>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
          ${statTile('TER (Direct)', f.costs ? terFmt(f.costs.terDirect) : 'N/A', f.costs ? 'Regular ' + terFmt(f.costs.terRegular) : 'not disclosed')}
          ${statTile('Fund size', f.aum ? aumFmt(f.aum.cr) : 'N/A', f.aum ? 'as of ' + fmtDate(f.aum.asOf) : 'not disclosed')}
          ${statTile('Riskometer', f.riskometer || 'N/A', 'SEBI rating')}
          ${f.benchmark && f.benchmark.indexName
            ? statTile('Benchmark', f.benchmark.indexName, f.benchmark.basis === 'category' ? 'peer-group proxy' : 'filed benchmark')
            : statTile('Benchmark', 'N/A', (f.benchmark && f.benchmark.reason) || '')}
          ${statTile('5Y vs benchmark', f.benchmark && f.benchmark.excess && f.benchmark.excess.y5 != null ? ppFmt(f.benchmark.excess.y5) : 'N/A', 'excess return (TRI)')}
          ${(() => {
            if (!f.manager) return statTile('Lead manager', 'N/A', '');
            const lead = [...f.manager.names].sort((a, b) => (b.tenureYears || 0) - (a.tenureYears || 0))[0];
            const sub = [lead.tenureYears != null ? lead.tenureYears + 'y tenure' : '', f.manager.names.length > 1 ? f.manager.names.length + ' mgrs' : ''].filter(Boolean).join(' · ');
            return statTile('Lead manager', lead.name, sub);
          })()}
        </div>
        ${f.exitLoad ? `<details class="mt-2 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-500 ring-1 ring-inset ring-slate-100"><summary class="cursor-pointer font-semibold text-slate-600">Exit load</summary><p class="mt-1.5 leading-relaxed">${esc(f.exitLoad.text)}</p></details>` : ''}
      </section>

      <section class="mt-4">
        <div class="mb-2 flex items-center justify-between">
          <h3 class="font-display text-sm font-bold text-slate-700">NAV growth</h3>
          <div class="drill-ranges inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
            ${RANGES.map(([lab], i) => `<button data-range="${lab}" class="rng rounded-md px-2.5 py-1 ${i === 2 ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}">${lab}</button>`).join('')}
          </div>
        </div>
        <div class="drill-chart h-56 w-full rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-100"></div>
        <div class="drill-chart-msg mt-1 text-center text-[11px] text-slate-400">Loading live NAV history from MFAPI…</div>
      </section>

      <section class="mt-4 grid grid-cols-2 gap-3">
        <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100">
          <h3 class="mb-1 font-display text-sm font-bold text-slate-700">Returns</h3>
          ${retCell('1 month', r.m1)}${retCell('3 months', r.m3)}${retCell('6 months', r.m6)}${retCell('1 year', r.y1)}
          ${retCell('3 years (CAGR)', r.y3)}${retCell('5 years (CAGR)', r.y5)}${retCell('10 years (CAGR)', r.y10)}
        </div>
        <div class="space-y-3">
          <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100">
            <h3 class="mb-1.5 font-display text-sm font-bold text-slate-700">Risk (3Y lookback)</h3>
            <div class="grid grid-cols-2 gap-1.5">
              ${statTile('Volatility', pct(rk.volatility) ?? 'N/A', 'lower = calmer')}
              ${statTile('Sharpe', num(rk.sharpe, 2) ?? 'N/A', 'higher = better')}
              ${statTile('Max drawdown', pct(rk.maxDrawdown) ?? 'N/A', 'worst fall')}
              ${statTile('Sortino', num(rk.sortino, 2) ?? 'N/A', 'downside-adj')}
            </div>
          </div>
          <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100">
            <h3 class="mb-1.5 font-display text-sm font-bold text-slate-700">vs peer group</h3>
            <div class="grid grid-cols-3 gap-1.5">${vsBadge('3Y', f.vsCategory.y3)}${vsBadge('5Y', f.vsCategory.y5)}${vsBadge('10Y', f.vsCategory.y10)}</div>
          </div>
        </div>
      </section>

      <section class="mt-3 grid grid-cols-2 gap-3">${roll(f.rolling.y3, '3Y rolling returns')}${roll(f.rolling.y5, '5Y rolling returns')}</section>
    </div>

    <footer class="flex items-center gap-2 border-t border-slate-100 p-4">
      <button class="drill-star flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold ${inShortlist(f.schemeCode) ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'}">${inShortlist(f.schemeCode) ? '★ In shortlist' : '☆ Add to shortlist'}</button>
      <a href="https://api.mfapi.in/mf/${f.schemeCode}" target="_blank" rel="noopener" class="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200">MFAPI ↗</a>
    </footer>
  </aside>`;

  requestAnimationFrame(() => root.querySelector('.drill-panel')?.classList.add('drill-open'));
  const close = () => closeDrill();
  root.querySelector('.drill-close').addEventListener('click', close);
  root.querySelector('.drill-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', escClose);

  root.querySelector('.drill-star').addEventListener('click', (e) => {
    toggleShortlist(f.schemeCode);
    const on = inShortlist(f.schemeCode);
    e.currentTarget.className = `drill-star flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold ${on ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'}`;
    e.currentTarget.textContent = on ? '★ In shortlist' : '☆ Add to shortlist';
    if (onChange) onChange();
  });

  const chartEl = root.querySelector('.drill-chart');
  const msgEl = root.querySelector('.drill-chart-msg');
  let currentRange = '5Y';
  root.querySelectorAll('.rng').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('.rng').forEach((x) => x.className = 'rng rounded-md px-2.5 py-1 text-slate-500');
    b.className = 'rng rounded-md px-2.5 py-1 bg-white text-indigo-600 shadow-sm';
    currentRange = b.dataset.range; drawNav();
  }));

  async function loadNav() {
    if (navCache.has(f.schemeCode)) return navCache.get(f.schemeCode);
    const res = await fetch(`https://api.mfapi.in/mf/${f.schemeCode}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();
    const pts = (raw.data || []).map((d) => { const [dd, mm, yy] = d.date.split('-').map(Number); return [Date.UTC(yy, mm - 1, dd), Number(d.nav)]; })
      .filter((p) => isFinite(p[0]) && isFinite(p[1]) && p[1] > 0).sort((a, b) => a[0] - b[0]);
    navCache.set(f.schemeCode, pts);
    return pts;
  }
  function drawNav() {
    const all = navCache.get(f.schemeCode) || [];
    if (!all.length) return;
    const yrs = RANGES.find(([l]) => l === currentRange)?.[1];
    let series = all;
    if (yrs) { const cut = all[all.length - 1][0] - yrs * 365.25 * 86400000; series = all.filter((p) => p[0] >= cut); }
    navLine(chartEl, series);
  }
  loadNav().then(() => { msgEl.textContent = 'Live NAV from MFAPI · hover to inspect'; drawNav(); })
    .catch(() => { msgEl.innerHTML = '<span class="text-rose-500">Could not load live NAV history. Try again shortly.</span>'; });
}

function escClose(e) { if (e.key === 'Escape') closeDrill(); }
export function closeDrill() {
  const root = document.getElementById('drill-root');
  const panel = root.querySelector('.drill-panel');
  const chartEl = root.querySelector('.drill-chart');
  if (chartEl) disposeChart(chartEl);
  document.removeEventListener('keydown', escClose);
  if (panel) { panel.classList.remove('drill-open'); setTimeout(() => (root.innerHTML = ''), 220); }
  else root.innerHTML = '';
}
