// enrich.mjs — orchestrate the Phase-3A data enrichment: attach fees/AUM/manager/exit-load/
// riskometer (tigzig) and benchmark excess vs TRI (NSE Indices) to each fund, and build the
// committed TRI series file. Fail-soft: if a source is down, prior committed values are carried
// forward and marked `stale:true` rather than wiped.

import { fetchTigzigMap, TIGZIG_SOURCE } from './tigzig.mjs';
import { resolveBenchmark, fetchTRI, benchmarkReturns, monthlyDownsample, NSE_TRI_SOURCE } from './benchmark.mjs';
import { toISODate } from './dates.mjs';

const isoToMs = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const excess = (a, b) => (a != null && b != null ? a - b : null);
const ratio = (a, b) => (a != null && b != null && b > 0 ? a / b : null);
const stale = (obj) => (obj ? { ...obj, stale: true } : null);

/**
 * @param funds       the computed fund array (each needs schemeCode, peerGroup, returns, latestNavDate)
 * @param priorByCode Map<schemeCode, priorFund> from the last committed funds.json (for carry-forward)
 * @param log         logger
 * @returns { byCode, benchmarksJson, coverage, indicesFetched, emptyIndices, warnings, sources }
 */
export async function enrichFunds(funds, priorByCode, log = console.log) {
  const warnings = [];

  // 1) tigzig disclosures (fail-soft) -----------------------------------------
  let tig = null;
  try { tig = await fetchTigzigMap(); log(`tigzig: ${tig.size} schemes`); }
  catch (e) { warnings.push(`tigzig fetch failed (carrying prior): ${e.message}`); log('tigzig FAILED:', e.message); }

  // 2) resolve each fund's benchmark index ------------------------------------
  const resolved = new Map();
  const needed = new Set();
  for (const f of funds) {
    const filed = tig?.get(f.schemeCode)?.benchmarkFiled ?? priorByCode.get(f.schemeCode)?.benchmark?.filed ?? null;
    const r = resolveBenchmark(filed, f.peerGroup);
    resolved.set(f.schemeCode, { r, filed });
    if (r) needed.add(r.indexName);
  }

  // 3) fetch each needed TRI once (throttle ~1s; empty array = silent name mismatch) ----
  const triByIndex = new Map();
  const emptyIndices = [];
  for (const name of [...needed].sort()) {
    try {
      const s = await fetchTRI(name);
      if (s) { triByIndex.set(name, s); log(`  TRI ${name}: ${s.length} pts (latest ${s[s.length - 1].nav.toFixed(1)})`); }
      else { emptyIndices.push(name); warnings.push(`TRI empty (name mismatch): ${name}`); log(`  TRI ${name}: EMPTY`); }
    } catch (e) { emptyIndices.push(name); warnings.push(`TRI error ${name}: ${e.message}`); log(`  TRI ${name}: ERROR ${e.message}`); }
    await new Promise((r) => setTimeout(r, 1100));
  }

  // 4) per-fund enrichment ----------------------------------------------------
  const byCode = new Map();
  for (const f of funds) {
    const t = tig?.get(f.schemeCode) || null;
    const prior = priorByCode.get(f.schemeCode) || null;
    const { r, filed } = resolved.get(f.schemeCode);

    let benchmark;
    if (!r) {
      benchmark = { indexName: null, basis: null, filed, source: NSE_TRI_SOURCE, reason: 'no mapped TRI benchmark' };
    } else {
      const s = triByIndex.get(r.indexName);
      if (!s) {
        // TRI down this run → carry prior benchmark if we had one, else record the reason.
        benchmark = prior?.benchmark?.excess
          ? { ...prior.benchmark, stale: true }
          : { indexName: r.indexName, basis: r.basis, filed, source: NSE_TRI_SOURCE, reason: 'TRI unavailable this run' };
      } else {
        const bm = benchmarkReturns(s, isoToMs(f.latestNavDate));
        const fr = f.returns;
        benchmark = {
          indexName: r.indexName, basis: r.basis, filed, source: NSE_TRI_SOURCE, asOf: toISODate(s[s.length - 1].t),
          cagr: bm ? { y1: bm.y1, y3: bm.y3, y5: bm.y5, y10: bm.y10 } : null,
          excess: bm ? { y1: excess(fr.y1, bm.y1), y3: excess(fr.y3, bm.y3), y5: excess(fr.y5, bm.y5), y10: excess(fr.y10, bm.y10) } : null,
          ratio: bm ? { y3: ratio(fr.y3, bm.y3), y5: ratio(fr.y5, bm.y5), y10: ratio(fr.y10, bm.y10) } : null,
        };
      }
    }

    // tigzig fields: fresh when available, else carry prior marked stale.
    byCode.set(f.schemeCode, {
      costs: t ? t.costs : stale(prior?.costs),
      aum: t ? t.aum : stale(prior?.aum),
      manager: t ? t.manager : stale(prior?.manager),
      exitLoad: t ? t.exitLoad : stale(prior?.exitLoad),
      riskometer: t ? t.riskometer : (prior?.riskometer ?? null),
      benchmark,
    });
  }

  // 5) committed TRI series (monthly downsample to stay small) ----------------
  const benchmarksJson = {};
  for (const [name, s] of triByIndex) {
    benchmarksJson[name] = { name, source: NSE_TRI_SOURCE, asOf: toISODate(s[s.length - 1].t), latest: s[s.length - 1].nav, series: monthlyDownsample(s) };
  }

  const coverage = { benchmark: 0, ter: 0, aum: 0, manager: 0, exitLoad: 0, riskometer: 0 };
  for (const e of byCode.values()) {
    if (e.benchmark?.excess && e.benchmark.indexName) coverage.benchmark++;
    if (e.costs?.terDirect != null) coverage.ter++;
    if (e.aum) coverage.aum++;
    if (e.manager) coverage.manager++;
    if (e.exitLoad) coverage.exitLoad++;
    if (e.riskometer) coverage.riskometer++;
  }

  return {
    byCode, benchmarksJson, coverage, indicesFetched: [...triByIndex.keys()], emptyIndices, warnings,
    sources: [
      { name: 'tigzig (AMFI/SEBI disclosures)', url: 'https://api.tigzig.com/', note: 'TER, AUM, managers, exit load, riskometer, filed benchmark' },
      { name: NSE_TRI_SOURCE, url: 'https://www.niftyindices.com/', note: 'Total Return Index history for benchmark comparison' },
    ],
  };
}
