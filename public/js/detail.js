// detail.js — the full fund-detail research view. Opened as a slide-in (click a fund) and shown
// inline in the "Fund Details" tab. Subtabs: Overview · Performance · Risk · Fund Manager · Costs
// · Documents. The only live browser fetch is the per-fund NAV history (navapi.js).

import { state, inShortlist, toggleShortlist, emit } from './state.js';
import { esc, pct, pctSigned, num, fmtDate, groupColor, terFmt, aumFmt, ppFmt, vsFmt, ICON } from './meta.js';
import { composite, scoreOf, scoredPillars, scoreColor, getWeights, setWeights, resetWeights, PILLAR_META, PILLAR_KEYS, explainPillar, DEFAULT_WEIGHTS } from './score.js';
import { fetchNav, sliceYears, rebase, benchToSeries, alignRebase } from './navapi.js';
import { navBenchmarkOverlay, drawdownChart, disposeChart } from './charts.js';

const RANGES = [['1Y', 1], ['3Y', 3], ['5Y', 5], ['Max', null]];
let onChange = null;
export function setDetailChangeHandler(fn) { onChange = fn; }

const ctx = () => ({ categories: state.categories, benchmarks: state.benchmarks || {} });

// ---- small bits -------------------------------------------------------------
const tile = (label, value, sub) => `<div class="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100"><div class="text-[11px] font-medium text-slate-400">${esc(label)}</div><div class="mt-0.5 font-display text-lg font-bold tnum text-slate-800">${value}</div>${sub ? `<div class="text-[11px] text-slate-400">${esc(sub)}</div>` : ''}</div>`;
const RISK_COLOR = { Low: '#10b981', 'Low to Moderate': '#84cc16', Moderate: '#f59e0b', 'Moderately High': '#fb923c', High: '#f97316', 'Very High': '#f43f5e' };
const riskPill = (r) => (r ? `<span class="pill" style="background:${(RISK_COLOR[r] || '#64748b')}1f;color:${RISK_COLOR[r] || '#64748b'}">${esc(r)}</span>` : '<span class="v-na">N/A</span>');
const coloredRet = (v) => `<span class="tnum font-semibold ${v == null ? 'v-na' : v > 0 ? 'v-pos' : v < 0 ? 'v-neg' : 'v-zero'}">${pct(v) ?? 'N/A'}</span>`;

function warnings(f) {
  const w = [];
  if (f.ageYears != null && f.ageYears < 3) w.push(['Young fund', `Only ${f.ageYears.toFixed(1)} years of history — long-horizon figures are limited.`]);
  const mi = f.score && f.score.pillars.manager.inputs;
  if (mi && mi.predatesRecord) w.push(['Record predates manager', `Much of the multi-year record was built before ${mi.primaryManager || 'the current lead manager'} (${mi.tenureYears}y tenure) took charge.`]);
  if (f.benchmark && f.benchmark.basis === 'category') w.push(['Category-proxy benchmark', `Compared against ${f.benchmark.indexName} (a peer-group proxy); the fund's filed benchmark is ${f.benchmark.filed || 'N/A'}, which isn't an NSE index.`]);
  return w;
}

// ---- Overview (incl. the re-weightable score) -------------------------------
function scoreBreakdown(f) {
  if (!f.score) return '<div class="text-sm text-slate-400">Not enough data to score this fund.</div>';
  const comp = scoreOf(f), w = getWeights();
  const bars = PILLAR_KEYS.map((k) => {
    const p = f.score.pillars[k], m = PILLAR_META[k], s = p ? p.score : null;
    const width = s == null ? 0 : Math.round(s);
    return `<div class="score-pillar" data-pk="${k}">
      <div class="flex items-center justify-between text-xs"><button class="pk-toggle font-medium text-slate-600">${esc(m.label)} <span class="text-slate-300">▸</span></button>
        <span class="tnum font-semibold" style="color:${s == null ? '#cbd5e1' : m.color}">${s == null ? 'N/A' : Math.round(s)}</span></div>
      <div class="mt-1 h-2.5 rounded-full bg-slate-100"><div class="h-2.5 rounded-full" style="width:${width}%;background:${m.color}"></div></div>
      <div class="pk-detail hidden mt-1.5 rounded-lg bg-slate-50 p-2 text-[11px] text-slate-500">
        <div>${esc(explainPillar(k, p))}</div>
        <div class="mt-1 text-slate-400">weight <input type="range" class="pk-weight align-middle" data-pk="${k}" min="0" max="50" value="${w[k]}" style="width:90px"> <span class="pk-wval tnum">${w[k]}</span>${p ? ' · inputs: ' + esc(inputsStr(k, p.inputs)) : ''}</div>
      </div></div>`;
  }).join('');
  return `<div class="rounded-2xl p-4 ring-1 ring-inset ring-slate-100" style="background:linear-gradient(135deg,${scoreColor(comp)}12,transparent)">
    <div class="flex items-center gap-3">
      <div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-white shadow-sm" style="background:${scoreColor(comp)}"><span class="font-display text-2xl font-extrabold tnum score-comp">${comp == null ? 'N/A' : Math.round(comp)}</span></div>
      <div class="min-w-0"><div class="font-display text-sm font-bold text-slate-700">Composite score</div>
        <div class="text-xs text-slate-500">Percentile vs its peer group (n=${f.score.n}) across ${scoredPillars(f)} of 5 pillars${scoreOf(f) == null ? ' — partial: not enough evidence for a composite yet' : ''}. Drag a weight to re-rank live.</div>
        <div class="mt-0.5 text-[11px] font-medium text-amber-600">Research only — not investment advice.</div></div>
    </div>
    <div class="mt-3 space-y-2 score-bars">${bars}</div>
    <button class="score-reset mt-2 text-[11px] font-medium text-indigo-500 hover:underline">reset weights to default</button>
  </div>`;
}
function inputsStr(k, i) {
  if (k === 'performance') return `5Y ${pct(i.y5) ?? '–'}, 10Y ${pct(i.y10) ?? '–'}, excess ${ppFmt(i.excess5y) ?? '–'}`;
  if (k === 'consistency') return `${pct(i.pctPositive3y, 0) ?? '–'} positive, worst ${pct(i.min3y) ?? '–'}`;
  if (k === 'risk') return `Sharpe ${num(i.sharpe, 2) ?? '–'}, vol ${pct(i.volatility) ?? '–'}, maxDD ${pct(i.maxDrawdown) ?? '–'}`;
  if (k === 'cost') return `TER ${terFmt(i.terDirect) ?? '–'}`;
  if (k === 'manager') return `${i.primaryManager || '–'}, ${i.tenureYears != null ? i.tenureYears + 'y' : '–'}`;
  return '';
}

function overviewTab(f) {
  const c = ctx();
  const benchLine = !f.benchmark || !f.benchmark.indexName
    ? `<span class="v-na">N/A${f.benchmark && f.benchmark.reason ? ' — ' + esc(f.benchmark.reason) : ''}</span>`
    : f.benchmark.basis === 'category'
      ? `${esc(f.benchmark.indexName)} <span class="text-[11px] text-amber-600">— category proxy · filed: ${esc(f.benchmark.filed || 'N/A')}</span>`
      : esc(f.benchmark.indexName);
  const warns = warnings(f);
  return `<div class="grid gap-4 lg:grid-cols-2">
    <div class="space-y-3">
      ${f.isIndex ? `<div class="flex gap-2 rounded-xl bg-sky-50 p-2.5 text-xs ring-1 ring-inset ring-sky-100"><span>🎯</span><div><b class="text-sky-700">Passive index fund.</b> <span class="text-sky-700/80">Judge it on low fee + tight tracking — a benchmark excess near zero (slightly negative is normal, from fees) is good. It aims to match ${f.benchmark && f.benchmark.indexName ? esc(f.benchmark.indexName) : 'its index'}, not beat it.</span></div></div>` : ''}
      <div class="grid grid-cols-2 gap-2">
        ${tile('Latest NAV', f.latestNav != null ? '₹' + num(f.latestNav, 2) : 'N/A', fmtDate(f.latestNavDate))}
        ${tile('Fund size', f.aum ? aumFmt(f.aum.cr) : 'N/A', f.aum ? 'as of ' + fmtDate(f.aum.asOf) : 'not disclosed')}
        ${tile('TER (Direct)', f.costs && f.costs.terDirect != null ? terFmt(f.costs.terDirect) : 'N/A', f.costs && f.costs.terRegular != null ? 'Regular ' + terFmt(f.costs.terRegular) : '')}
        ${tile('Age', f.ageYears != null ? num(f.ageYears, 1) + ' yrs' : 'N/A', f.inceptionDate ? 'launched ' + fmtDate(f.inceptionDate) : '')}
      </div>
      <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100 text-sm">
        <div class="flex justify-between py-1"><span class="text-slate-500">Category / peer group</span><span class="text-right font-medium text-slate-700">${esc(f.category)}<br><span class="text-xs">${esc(f.peerGroup)}</span></span></div>
        <div class="flex items-center justify-between border-t border-slate-100 py-1.5"><span class="text-slate-500">Riskometer</span>${riskPill(f.riskometer)}</div>
        <div class="flex justify-between border-t border-slate-100 py-1.5"><span class="text-slate-500">Benchmark</span><span class="text-right text-sm font-medium text-slate-700">${benchLine}</span></div>
        ${f.navSince && f.inceptionBasis === 'allotment' ? `<div class="flex justify-between border-t border-slate-100 py-1.5"><span class="text-slate-500">Return history</span><span class="text-right font-medium text-slate-700">Direct-plan NAV since ${esc(fmtDate(f.navSince))}</span></div>` : ''}
        <div class="flex justify-between border-t border-slate-100 py-1.5"><span class="text-slate-500">AMC</span><span class="font-medium text-slate-700">${esc(f.amc || 'N/A')}</span></div>
      </div>
      ${warns.length ? `<div class="space-y-1.5">${warns.map(([t, d]) => `<div class="flex gap-2 rounded-xl bg-amber-50 p-2.5 text-xs ring-1 ring-inset ring-amber-100"><span>⚠️</span><div><b class="text-amber-700">${esc(t)}</b> <span class="text-amber-700/80">${esc(d)}</span></div></div>`).join('')}</div>` : ''}
    </div>
    <div>${scoreBreakdown(f)}</div>
  </div>`;
}

// ---- Performance ------------------------------------------------------------
function rollRange(o, label) {
  if (!o) return `<div class="rounded-xl bg-slate-50 p-3 text-xs text-slate-400 ring-1 ring-inset ring-slate-100">${label}: not enough history</div>`;
  const lo = o.min, hi = o.max, av = o.avg, span = hi - lo || 1;
  const posAvg = Math.max(0, Math.min(100, ((av - lo) / span) * 100));
  return `<div class="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100"><div class="mb-1 flex justify-between text-xs"><span class="font-semibold text-slate-600">${label}</span><span class="text-slate-400">${o.n} windows · ${pct(o.pctPositive, 0)} positive</span></div>
    <div class="relative mt-2 h-6"><div class="absolute inset-y-2 left-0 right-0 rounded-full bg-gradient-to-r from-rose-200 via-amber-200 to-emerald-200"></div>
      <div class="absolute top-0 flex -translate-x-1/2 flex-col items-center" style="left:${posAvg}%"><div class="h-3 w-3 rounded-full bg-indigo-600 ring-2 ring-white"></div></div></div>
    <div class="mt-1 flex justify-between text-[11px] tnum"><span class="v-neg">worst ${pct(lo)}</span><span class="font-semibold text-indigo-600">avg ${pct(av)}</span><span class="v-pos">best ${pct(hi)}</span></div></div>`;
}
function performanceTab(f) {
  const r = f.returns, periods = [['1M', r.m1], ['3M', r.m3], ['6M', r.m6], ['1Y', r.y1], ['3Y', r.y3], ['5Y', r.y5], ['10Y', r.y10], ['Since inception', r.si]];
  const b = f.benchmark || {};
  const cmpRow = (label, vsC, exc, rat) => `<tr><td class="py-1.5 text-slate-500">${label}</td>
    <td class="num py-1.5">${vsC && vsC.ratio != null ? `<span class="${vsC.ratio >= 1 ? 'v-pos' : 'v-neg'}">${vsFmt(vsC)}</span>` : '<span class="v-na">N/A</span>'}</td>
    <td class="num py-1.5">${exc != null ? `<span class="${exc >= 0 ? 'v-pos' : 'v-neg'}">${ppFmt(exc)}</span>` : '<span class="v-na">N/A</span>'}</td>
    <td class="num py-1.5">${rat != null ? num(rat, 2) + '×' : '<span class="v-na">N/A</span>'}</td></tr>`;
  return `<div class="space-y-4">
    <section>
      <div class="mb-1.5 flex items-center justify-between"><h3 class="font-display text-sm font-bold text-slate-700">NAV growth vs benchmark</h3>
        <div class="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">${RANGES.map(([l], i) => `<button data-range="${l}" class="pr-rng rounded-md px-2.5 py-1 ${i === 2 ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}">${l}</button>`).join('')}</div></div>
      <div class="mb-2 text-xs text-slate-500">Both the fund and its benchmark start at 100 — the steeper line grew faster. The fund’s fee is already included in its NAV.</div>
      <div class="perf-chart h-64 w-full rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-100"></div>
      <div class="perf-chart-msg mt-1 text-center text-[11px] text-slate-400">Loading live NAV…</div>
    </section>
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100"><h3 class="mb-1 font-display text-sm font-bold text-slate-700">Returns</h3>
        ${periods.map(([l, v]) => `<div class="flex justify-between border-b border-slate-100 py-1.5 text-sm"><span class="text-slate-500">${l}</span>${coloredRet(v)}</div>`).join('')}
        <div class="mt-1 text-[11px] text-slate-400">Over 1 year = CAGR; shorter = absolute. Net of fees.</div></div>
      <div class="space-y-3">
        <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100"><h3 class="mb-1 font-display text-sm font-bold text-slate-700">Vs peers &amp; benchmark</h3>
          <table class="w-full gridtbl text-sm"><thead><tr class="text-[11px] uppercase tracking-wide text-slate-400"><th class="text-left font-medium"> </th><th class="num text-right font-medium">vs peers</th><th class="num text-right font-medium">bmark excess</th><th class="num text-right font-medium">ratio</th></tr></thead>
          <tbody>${cmpRow('3Y', f.vsCategory.y3, b.excess ? b.excess.y3 : null, b.ratio ? b.ratio.y3 : null)}${cmpRow('5Y', f.vsCategory.y5, b.excess ? b.excess.y5 : null, b.ratio ? b.ratio.y5 : null)}${cmpRow('10Y', f.vsCategory.y10, b.excess ? b.excess.y10 : null, b.ratio ? b.ratio.y10 : null)}</tbody></table></div>
        <div class="text-[11px] text-slate-400">Rolling returns = the worst, average and best annualised return across every 3Y / 5Y window the fund has lived through. A narrow spread means steadier results.</div>
        ${rollRange(f.rolling.y3, '3-year rolling return')}
        ${rollRange(f.rolling.y5, '5-year rolling return')}
      </div>
    </div>
  </div>`;
}

// ---- Risk -------------------------------------------------------------------
function riskMetric(label, value, meaning, peerVal) {
  return `<div class="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100"><div class="flex items-baseline justify-between"><span class="text-xs font-semibold text-slate-600">${label}</span><span class="tnum text-lg font-bold text-slate-800">${value}</span></div>
    ${peerVal ? `<div class="text-[11px] text-slate-400">peer group avg ${peerVal}</div>` : ''}<div class="mt-0.5 text-[11px] text-slate-500">${esc(meaning)}</div></div>`;
}
function riskTab(f) {
  const rk = f.risk, cat = ctx().categories[f.peerGroup];
  const pv = (metric, fmt) => (cat && cat.mean[metric] != null ? fmt(cat.mean[metric]) : null);
  return `<div class="space-y-4">
    <div class="grid grid-cols-2 gap-2">
      ${riskMetric('Sharpe', num(rk.sharpe, 2) ?? 'N/A', 'Return earned per unit of risk — higher is better.', pv('sharpe', (v) => num(v, 2)))}
      ${riskMetric('Volatility', pct(rk.volatility) ?? 'N/A', 'How much the value swings year to year — lower is calmer.', pv('volatility', (v) => pct(v)))}
      ${riskMetric('Max drawdown', pct(rk.maxDrawdown) ?? 'N/A', 'Worst fall from a previous peak — closer to 0 is better.', null)}
      ${riskMetric('Sortino', num(rk.sortino, 2) ?? 'N/A', 'Like Sharpe but only counts downside swings.', null)}
    </div>
    <section><h3 class="mb-1 font-display text-sm font-bold text-slate-700">Drawdown — how far below its peak it fell</h3>
      <div class="mb-2 text-xs text-slate-500">0% means the fund is at an all-time high; −30% means it has fallen 30% from its last peak. Deeper, longer dips are a rougher ride.</div>
      <div class="dd-chart h-56 w-full rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-100"></div>
      <div class="dd-chart-msg mt-1 text-center text-[11px] text-slate-400">Loading…</div></section>
    <p class="text-[11px] text-slate-400">Risk is measured over a ${rk.lookbackYears ? rk.lookbackYears.toFixed(1) : '3'}-year lookback. Research only — not investment advice.</p>
  </div>`;
}

// ---- Fund Manager -----------------------------------------------------------
const mgrKey = (s) => (s || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

/**
 * A manager's footprint across every fund we track: total AUM they run and how many funds. We don't
 * get a per-manager AUM or a career-experience figure from AMFI/SEBI (tigzig), and the per-fund "since"
 * date is only a SEBI (re-)notification — often recent, so "tenure on this fund" reads 0 for a new fund
 * and understates a veteran elsewhere. The footprint (AUM + fund count, summed from our own data) is an
 * honest, meaningful stand-in, computed once per open and shared by all of this fund's managers.
 */
function buildManagerStats() {
  const map = new Map();
  for (const g of state.funds) {
    const seen = new Set();
    for (const m of (g.manager && g.manager.names) || []) {
      const k = mgrKey(m.name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const e = map.get(k) || { aum: 0, funds: 0, hasAum: false };
      e.funds++;
      if (g.aum && g.aum.cr != null) { e.aum += g.aum.cr; e.hasAum = true; }
      map.set(k, e);
    }
  }
  return map;
}

function managerTab(f) {
  if (!f.manager || !f.manager.names.length) return '<div class="rounded-xl bg-slate-50 p-4 text-sm text-slate-400">Manager details not disclosed.</div>';
  const ordered = f.manager.names; // tigzig lists the LEAD manager first (sleeve/co-managers follow)
  const stats = buildManagerStats();
  return `<div class="space-y-3">
    ${ordered.map((m, i) => {
    const fp = stats.get(mgrKey(m.name)) || { aum: 0, funds: 1, hasAum: false };
    const footprint = fp.hasAum ? `Manages ${aumFmt(fp.aum)} across ${fp.funds} fund${fp.funds > 1 ? 's' : ''}` : `Manages ${fp.funds} fund${fp.funds > 1 ? 's' : ''}`;
    // Only show a tenure number when it is meaningful (>= 1y): the "since" date is a SEBI re-notification,
    // so a sub-year figure (0 yrs on a new fund, or a fresh re-notification) would just mislead.
    const tenure = m.since ? `On this fund since ${fmtDate(m.since)}${m.tenureYears != null && m.tenureYears >= 1 ? ' · ' + num(m.tenureYears, 1) + ' yrs' : ''}` : 'Join date not disclosed';
    return `<div class="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-100">
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-display font-bold text-white" style="background:${i === 0 ? '#4f46e5' : '#94a3b8'}">${esc((m.name || '?').slice(0, 1))}</div>
      <div class="min-w-0 flex-1"><div class="font-semibold text-slate-800">${esc(m.name)}${i === 0 ? '<span class="ml-1.5 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600">Lead</span>' : ''}</div>
        <div class="text-xs text-slate-600">${footprint}</div>
        <div class="text-[11px] text-slate-400">${tenure}</div></div></div>`;
  }).join('')}
    <p class="text-[11px] text-slate-400">AUM is the total across every fund we track that this manager runs. “Experience” (career years) isn’t in AMFI/SEBI disclosures, so it isn’t shown. Manager data as of ${esc(fmtDate(f.manager.asOf))}. Source: AMFI/SEBI disclosures via tigzig.</p>
  </div>`;
}

// ---- Costs ------------------------------------------------------------------
function parseExitLoad(text) {
  if (!text) return null;
  if (/nil|no exit load/i.test(text) && !/\d\s*%/.test(text)) return 'No exit load';
  const p = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const d = text.match(/within\s+(\d+)\s*(days?|months?|years?)/i) || text.match(/(\d+)\s*(days?|months?|years?)/i);
  if (p && d) return `${p[1]}% if redeemed within ${d[1]} ${d[2]}`;
  if (p) return `${p[1]}% exit load (see full terms)`;
  return null;
}
function costsTab(f) {
  const cat = ctx().categories[f.peerGroup];
  const medTer = cat && cat.median.terDirect != null ? cat.median.terDirect : null;
  const cheaper = f.costs && medTer != null ? f.costs.terDirect <= medTer : null;
  const el = parseExitLoad(f.exitLoad ? f.exitLoad.text : null);
  return `<div class="space-y-3">
    <div class="grid grid-cols-2 gap-2">
      ${tile('TER — Direct', f.costs ? terFmt(f.costs.terDirect) : 'N/A', 'the plan you hold')}
      ${tile('TER — Regular', f.costs ? terFmt(f.costs.terRegular) : 'N/A', 'with distributor')}
    </div>
    ${f.costs && medTer != null ? `<div class="rounded-xl bg-white p-3 text-sm ring-1 ring-slate-100"><div class="flex items-center justify-between"><span class="text-slate-500">vs peer-group median TER</span><span class="font-semibold ${cheaper ? 'v-pos' : 'v-neg'}">${terFmt(f.costs.terDirect)} vs ${terFmt(medTer)} — ${cheaper ? 'cheaper' : 'pricier'}</span></div>
      <div class="mt-2 h-2.5 rounded-full bg-slate-100"><div class="h-2.5 rounded-full ${cheaper ? 'bg-emerald-500' : 'bg-rose-400'}" style="width:${Math.max(4, Math.min(100, (f.costs.terDirect / (medTer * 2)) * 100))}%"></div></div></div>` : ''}
    <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100"><h3 class="mb-1 font-display text-sm font-bold text-slate-700">Exit load</h3>
      ${el ? `<div class="text-sm font-semibold text-slate-700">${esc(el)}</div>` : '<div class="text-sm text-slate-400">See terms below.</div>'}
      ${f.exitLoad ? `<details class="mt-1.5 text-xs text-slate-500"><summary class="cursor-pointer font-medium text-slate-500">Full terms</summary><p class="mt-1 leading-relaxed">${esc(f.exitLoad.text)}</p></details><div class="mt-1 text-[11px] text-slate-400">as of ${esc(fmtDate(f.exitLoad.asOf))}</div>` : '<div class="text-sm text-slate-400">Not disclosed.</div>'}</div>
    <p class="text-[11px] text-slate-400">The expense ratio is already reflected in the NAV and the returns shown — it is not an extra deduction.</p>
  </div>`;
}

// ---- Documents --------------------------------------------------------------
function documentsTab(f) {
  const srcs = (state.status && state.status.sources) || [];
  return `<div class="space-y-3">
    <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100"><h3 class="mb-2 font-display text-sm font-bold text-slate-700">Scheme data &amp; documents</h3>
      <a href="https://api.mfapi.in/mf/${f.schemeCode}" target="_blank" rel="noopener" class="block rounded-lg bg-slate-50 px-3 py-2 text-sm text-indigo-600 hover:bg-slate-100">↗ NAV history (MFAPI) — scheme ${f.schemeCode}</a>
      <a href="https://www.amfiindia.com/nav-history-download" target="_blank" rel="noopener" class="mt-1.5 block rounded-lg bg-slate-50 px-3 py-2 text-sm text-indigo-600 hover:bg-slate-100">↗ AMFI official NAV &amp; scheme information</a>
      <p class="mt-1.5 text-[11px] text-slate-400">The Scheme Information Document (SID) &amp; factsheet are published on ${esc(f.amc || 'the AMC')}’s website and AMFI; we link the live data sources rather than a guessed PDF URL.</p></div>
    <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100"><h3 class="mb-2 font-display text-sm font-bold text-slate-700">Data sources &amp; as-of dates</h3>
      <ul class="space-y-1 text-xs">${srcs.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener" class="font-medium text-indigo-600 underline decoration-dotted">${esc(s.name)}</a> <span class="text-slate-400">as of ${esc(fmtDate(s.asOf))}</span></li>`).join('')}
      ${f.benchmark && f.benchmark.indexName ? `<li class="text-slate-500">Benchmark: ${esc(f.benchmark.indexName)} TRI (${esc(f.benchmark.source)}), as of ${esc(fmtDate(f.benchmark.asOf))}</li>` : ''}</ul></div>
  </div>`;
}

const SUBTABS = [['overview', 'Overview', overviewTab], ['performance', 'Performance', performanceTab], ['risk', 'Risk', riskTab], ['manager', 'Fund Manager', managerTab], ['costs', 'Costs', costsTab], ['documents', 'Documents', documentsTab]];

// ---- assembly ---------------------------------------------------------------
export function renderDetail(container, f, { slide = false } = {}) {
  const c = groupColor(f.peerGroup), comp = scoreOf(f);
  container.innerHTML = `
    <header class="flex items-start gap-3 border-b border-slate-100 p-5" style="background:linear-gradient(135deg, ${c}14, transparent)">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2"><span class="pill" style="background:${c}1a;color:${c}">${esc(f.peerGroup)}</span><span class="text-[11px] text-slate-400">${esc(f.category)}</span>${f.isIndex ? '<span class="pill" style="background:#ccfbf1;color:#0f766e">Passive · Index</span>' : ''}</div>
        <h2 class="mt-1 font-display text-xl font-extrabold leading-tight text-slate-900">${esc(f.name)}</h2>
        <p class="text-xs text-slate-500">${esc(f.amc || '')} · Direct · Growth</p>
      </div>
      <div class="flex shrink-0 flex-col items-center"><div class="detail-head-badge flex h-12 w-12 items-center justify-center rounded-xl text-white" style="background:${scoreColor(comp)}"><span class="detail-head-score font-display text-lg font-extrabold tnum">${comp == null ? 'N/A' : Math.round(comp)}</span></div><span class="mt-0.5 text-[10px] text-slate-400">score</span></div>
      ${slide ? `<button class="detail-close rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-5 w-5"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : ''}
    </header>
    <nav class="flex gap-1 overflow-x-auto border-b border-slate-100 px-3 py-2">${SUBTABS.map(([k, label], i) => `<button data-sub="${k}" class="subtab ${i === 0 ? 'subtab-on' : ''} shrink-0">${esc(label)}</button>`).join('')}</nav>
    <div class="detail-body flex-1 overflow-y-auto p-5"></div>
    ${slide ? `<footer class="flex items-center gap-2 border-t border-slate-100 p-4"><button class="detail-star flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold ${inShortlist(f.schemeCode) ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'}">${inShortlist(f.schemeCode) ? '★ In shortlist' : '☆ Add to shortlist'}</button></footer>` : ''}`;

  const body = container.querySelector('.detail-body');
  const drawn = new Set();
  const show = (key) => {
    const def = SUBTABS.find((s) => s[0] === key);
    body.innerHTML = def[2](f);
    container.querySelectorAll('.subtab').forEach((b) => b.className = `subtab ${b.dataset.sub === key ? 'subtab-on' : ''} shrink-0`);
    if (key === 'overview') wireScore(body, f);
    if (key === 'performance') wirePerf(body, f);
    if (key === 'risk') wireRisk(body, f);
  };
  container.querySelectorAll('.subtab').forEach((b) => b.addEventListener('click', () => show(b.dataset.sub)));
  show('overview');

  if (slide) {
    container.querySelector('.detail-close').addEventListener('click', closeDetail);
    const starBtn = container.querySelector('.detail-star');
    starBtn.addEventListener('click', () => { toggleShortlist(f.schemeCode); const on = inShortlist(f.schemeCode); starBtn.className = `detail-star flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold ${on ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'}`; starBtn.textContent = on ? '★ In shortlist' : '☆ Add to shortlist'; if (onChange) onChange(); });
  }
}

function wireScore(body, f) {
  body.querySelectorAll('.pk-toggle').forEach((b) => b.addEventListener('click', () => { const d = b.closest('.score-pillar').querySelector('.pk-detail'); d.classList.toggle('hidden'); }));
  // Re-weighting changes only the composite (pillar percentiles are fixed); sync both badges.
  const syncComposite = () => {
    const comp = scoreOf(f);
    const txt = comp == null ? 'N/A' : Math.round(comp);
    const sc = body.querySelector('.score-comp'); if (sc) sc.textContent = txt;
    const hs = document.querySelector('.detail-head-score'); if (hs) hs.textContent = txt;
    const hb = document.querySelector('.detail-head-badge'); if (hb) hb.style.background = scoreColor(comp);
    if (onChange) onChange();
  };
  body.querySelectorAll('.pk-weight').forEach((inp) => inp.addEventListener('input', () => {
    const w = { ...getWeights() }; w[inp.dataset.pk] = +inp.value; setWeights(w);
    inp.closest('.pk-detail').querySelector('.pk-wval').textContent = inp.value;
    syncComposite();
  }));
  const reset = body.querySelector('.score-reset');
  if (reset) reset.addEventListener('click', () => {
    resetWeights();
    body.querySelectorAll('.pk-weight').forEach((i) => { i.value = DEFAULT_WEIGHTS[i.dataset.pk]; i.closest('.pk-detail').querySelector('.pk-wval').textContent = DEFAULT_WEIGHTS[i.dataset.pk]; });
    syncComposite();
  });
}

function wirePerf(body, f) {
  let range = '5Y';
  const draw = async () => {
    const el = body.querySelector('.perf-chart'), msg = body.querySelector('.perf-chart-msg');
    try {
      const nav = await fetchNav(f.schemeCode);
      const years = RANGES.find(([l]) => l === range)[1];
      const sliced = sliceYears(nav, years);
      if (!sliced.length) { msg.textContent = 'No NAV history in this window.'; return; }
      const bi = f.benchmark && f.benchmark.indexName, bench = bi ? ctx().benchmarks[bi] : null;
      // FIX 4: align fund (daily) + benchmark (monthly) to one shared anchor so both start at 100 on the same date.
      const { fund: fw, bench: bw } = alignRebase(sliced, bench ? benchToSeries(bench) : [], 100);
      const blabel = bench ? bi + ' TRI' : '';
      navBenchmarkOverlay(el, fw, bw, f.name.length > 22 ? f.name.slice(0, 20) + '…' : f.name, blabel);
      msg.textContent = bench ? 'Live NAV (MFAPI) vs benchmark TRI · both rebased to 100 at a shared start date' : (f.benchmark && f.benchmark.reason ? 'Benchmark N/A — ' + f.benchmark.reason : 'Live NAV (MFAPI) · rebased to 100');
    } catch {
      msg.innerHTML = '<span class="text-rose-500">Couldn’t load live NAV — the data source (MFAPI) is busy.</span> <button class="perf-retry font-semibold text-indigo-600 underline">Retry</button>';
      const rb = msg.querySelector('.perf-retry');
      if (rb) rb.addEventListener('click', () => { msg.textContent = 'Loading live NAV…'; draw(); });
    }
  };
  body.querySelectorAll('.pr-rng').forEach((b) => b.addEventListener('click', () => { range = b.dataset.range; body.querySelectorAll('.pr-rng').forEach((x) => x.className = 'pr-rng rounded-md px-2.5 py-1 text-slate-500'); b.className = 'pr-rng rounded-md px-2.5 py-1 bg-white text-indigo-600 shadow-sm'; draw(); }));
  draw();
}

function wireRisk(body, f) {
  const el = body.querySelector('.dd-chart'), msg = body.querySelector('.dd-chart-msg');
  const go = async () => {
    try { const nav = await fetchNav(f.schemeCode); drawdownChart(el, sliceYears(nav, null)); msg.textContent = 'Underwater drawdown from live NAV (full history)'; }
    catch {
      msg.innerHTML = '<span class="text-rose-500">Couldn’t load live NAV — the data source (MFAPI) is busy.</span> <button class="dd-retry font-semibold text-indigo-600 underline">Retry</button>';
      const rb = msg.querySelector('.dd-retry');
      if (rb) rb.addEventListener('click', () => { msg.textContent = 'Loading live NAV…'; go(); });
    }
  };
  go();
}

// ---- slide-in ---------------------------------------------------------------
export function openDetail(f) {
  const root = document.getElementById('drill-root');
  root.innerHTML = `<div class="drill-backdrop fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-sm"></div>
    <aside class="drill-panel detail-panel fixed right-0 top-0 z-50 flex h-full w-full max-w-[640px] flex-col bg-white shadow-2xl"></aside>`;
  renderDetail(root.querySelector('.detail-panel'), f, { slide: true });
  requestAnimationFrame(() => root.querySelector('.drill-panel').classList.add('drill-open'));
  root.querySelector('.drill-backdrop').addEventListener('click', closeDetail);
  document.addEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeDetail(); }
export function closeDetail() {
  const root = document.getElementById('drill-root');
  const panel = root.querySelector('.drill-panel');
  root.querySelectorAll('.perf-chart, .dd-chart').forEach(disposeChart);
  document.removeEventListener('keydown', escClose);
  if (panel) { panel.classList.remove('drill-open'); setTimeout(() => (root.innerHTML = ''), 220); } else root.innerHTML = '';
}
