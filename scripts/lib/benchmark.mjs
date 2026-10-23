// benchmark.mjs — map each fund to its Total Return Index (TRI), fetch TRI history from NSE
// Indices, and compute benchmark returns + excess/ratio over the SAME windows as the fund.
//
// Hard rules (client non-negotiables):
//  - TRI only, the scheme's correct benchmark. Prefer the fund's FILED benchmark; only when
//    that isn't a fetchable Nifty index do we fall back to a category→Nifty proxy, and we stamp
//    `basis:"category"` so the substitution is never silent. No mapping → N/A with a reason.
//  - NSE's canonical index name must match EXACTLY or the API returns an empty array silently.
//    Every name in CANONICAL below was verified live to return data during the build bring-up.

import { navOnOrBefore } from './metrics.mjs';
import { DAYS_PER_YEAR, daysBetween, yearsBefore, toISODate } from './dates.mjs';

export const NSE_TRI_SOURCE = 'NSE Indices TRI';
const NIFTY_URL = 'https://www.niftyindices.com/BackPage/getTotalReturnIndexString';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Canonical NSE index names, each verified to return a non-empty TRI series. The first block was
// verified during the Phase-3A bring-up; the second block was added for passive index funds and
// is confirmed live on each build (an empty fetch is logged and the affected funds show N/A).
export const CANONICAL = new Set([
  'NIFTY 50', 'NIFTY 100', 'NIFTY 200', 'NIFTY 500', 'NIFTY MIDCAP 150', 'NIFTY SMALLCAP 250',
  'NIFTY LARGEMIDCAP 250', 'NIFTY500 MULTICAP 50:25:25', 'NIFTY BANK', 'NIFTY FINANCIAL SERVICES',
  'NIFTY IT', 'NIFTY PHARMA', 'NIFTY HEALTHCARE', 'NIFTY ENERGY', 'NIFTY INFRASTRUCTURE',
  'NIFTY INDIA CONSUMPTION', 'NIFTY AUTO', 'NIFTY METAL', 'NIFTY FMCG', 'NIFTY INDIA MANUFACTURING',
  'NIFTY MNC', 'NIFTY100 ESG', 'NIFTY COMMODITIES', 'NIFTY SERVICES SECTOR', 'NIFTY PSE',
  'NIFTY TRANSPORTATION & LOGISTICS',
  // index-fund targets
  'NIFTY NEXT 50', 'NIFTY MIDCAP 50', 'NIFTY MIDCAP 100', 'NIFTY SMALLCAP 50', 'NIFTY SMALLCAP 100',
  'NIFTY MICROCAP 250', 'NIFTY MIDSMALLCAP 400', 'NIFTY TOTAL MARKET', 'NIFTY PSU BANK',
  'NIFTY PRIVATE BANK', 'NIFTY REALTY', 'NIFTY MEDIA', 'NIFTY CONSUMER DURABLES', 'NIFTY OIL & GAS',
]);

// Overseas / non-NSE trackers → no NSE TRI (reported N/A with an honest reason, never proxied).
const OVERSEAS_RE = /nasdaq|s&\s*p\s*500|hang\s*seng|\bmsci\b|\bfang\b|\bnyse\b|\bglobal\b|\bworld\b|developed|emerging\s*market|\bchina\b|\bjapan\b/i;

// An index fund's benchmark IS the index it tracks. Map the scheme name → canonical NSE index.
// Ordered: specific caps and SECTORS before the plain broad indices, so "Nifty Bank Index Fund"
// maps to NIFTY BANK, not NIFTY 50. Factor/smart-beta and "Other" index funds are intentionally
// NOT mapped here (their specific TRI isn't carried) and resolve to N/A rather than a wrong proxy.
const INDEX_TRACK_MAP = [
  [/next\s*50/i, 'NIFTY NEXT 50'],
  [/midcap\s*50\b|midcap50\b/i, 'NIFTY MIDCAP 50'],
  [/midcap\s*100\b|midcap100\b/i, 'NIFTY MIDCAP 100'],
  [/midcap\s*150\b|midcap150\b/i, 'NIFTY MIDCAP 150'],
  [/smallcap\s*50\b|smallcap50\b/i, 'NIFTY SMALLCAP 50'],
  [/smallcap\s*100\b|smallcap100\b/i, 'NIFTY SMALLCAP 100'],
  [/smallcap\s*250\b|smallcap250\b/i, 'NIFTY SMALLCAP 250'],
  [/microcap\s*250|microcap250/i, 'NIFTY MICROCAP 250'],
  [/midsmall/i, 'NIFTY MIDSMALLCAP 400'],
  [/largemidcap|large\s*&?\s*mid/i, 'NIFTY LARGEMIDCAP 250'],
  [/psu\s*bank/i, 'NIFTY PSU BANK'],
  [/private\s*bank/i, 'NIFTY PRIVATE BANK'],
  [/\bbank\b|banking/i, 'NIFTY BANK'],
  [/financial\s*services|finserv|\bbfsi\b/i, 'NIFTY FINANCIAL SERVICES'],
  [/\bit\b|niftyit|infotech/i, 'NIFTY IT'],
  [/pharma/i, 'NIFTY PHARMA'],
  [/health/i, 'NIFTY HEALTHCARE'],
  [/\bauto\b/i, 'NIFTY AUTO'],
  [/\bfmcg\b/i, 'NIFTY FMCG'],
  [/consumer\s*durable/i, 'NIFTY CONSUMER DURABLES'],
  [/consumption/i, 'NIFTY INDIA CONSUMPTION'],
  [/\binfra/i, 'NIFTY INFRASTRUCTURE'],
  [/oil\s*&?\s*gas/i, 'NIFTY OIL & GAS'],
  [/\benergy\b|\bpower\b/i, 'NIFTY ENERGY'],
  [/\bmetal/i, 'NIFTY METAL'],
  [/commodit/i, 'NIFTY COMMODITIES'],
  [/realty|\breit/i, 'NIFTY REALTY'],
  [/\bmedia\b/i, 'NIFTY MEDIA'],
  [/manufactur/i, 'NIFTY INDIA MANUFACTURING'],
  [/\bmnc\b/i, 'NIFTY MNC'],
  [/\bpse\b/i, 'NIFTY PSE'],
  [/total\s*market/i, 'NIFTY TOTAL MARKET'],
  [/500\s*multicap|multicap\s*50:25:25/i, 'NIFTY500 MULTICAP 50:25:25'],
  [/nifty\s*500\b|nifty500\b/i, 'NIFTY 500'],
  [/nifty\s*200\b|nifty200\b/i, 'NIFTY 200'],
  [/nifty\s*100\b|nifty100\b/i, 'NIFTY 100'],
  [/nifty\s*50\b|nifty50\b|nifty\s*index/i, 'NIFTY 50'],
];

/**
 * Index-fund benchmark from its name + peer group:
 *   'overseas' → overseas/non-NSE index (N/A, no NSE TRI)
 *   'na'       → factor/smart-beta or other index with no carried TRI (N/A, never a proxy)
 *   <string>   → a canonical NSE index name to fetch
 *   null       → unrecognised; caller may fall back to the filed benchmark
 */
function indexTrack(name, peerGroup) {
  const n = (name || '').toLowerCase();
  if (OVERSEAS_RE.test(n) || peerGroup === 'Index: International') return 'overseas';
  if (peerGroup === 'Index: Factor / Smart-Beta' || peerGroup === 'Index: Other') return 'na';
  for (const [re, idx] of INDEX_TRACK_MAP) if (re.test(n)) return idx;
  return null;
}

// peerGroup → fallback canonical index when the filed benchmark isn't a fetchable Nifty index.
// Thematic: Other and Thematic: International have no sound proxy → N/A.
export const PEERGROUP_FALLBACK = {
  'Flexi Cap': 'NIFTY 500', 'Multi Cap': 'NIFTY500 MULTICAP 50:25:25', 'ELSS': 'NIFTY 500',
  'Value/Contra': 'NIFTY 500', 'Focused': 'NIFTY 500', 'Dividend Yield': 'NIFTY 500',
  'Large Cap': 'NIFTY 100', 'Large & Mid Cap': 'NIFTY LARGEMIDCAP 250', 'Mid Cap': 'NIFTY MIDCAP 150',
  'Small Cap': 'NIFTY SMALLCAP 250',
  'Thematic: Banking & Financial': 'NIFTY BANK', 'Thematic: Technology': 'NIFTY IT',
  'Thematic: Pharma & Healthcare': 'NIFTY PHARMA', 'Thematic: Energy & Power': 'NIFTY ENERGY',
  'Thematic: Infrastructure': 'NIFTY INFRASTRUCTURE', 'Thematic: Consumption': 'NIFTY INDIA CONSUMPTION',
  'Thematic: Auto': 'NIFTY AUTO', 'Thematic: Metals & Commodities': 'NIFTY METAL',
  'Thematic: Manufacturing': 'NIFTY INDIA MANUFACTURING', 'Thematic: ESG': 'NIFTY100 ESG',
  'Thematic: MNC': 'NIFTY MNC',
};

/** Normalize a filed benchmark name to a canonical Nifty name, or null if it isn't a (plain) Nifty index. */
export function normalizeFiled(filed) {
  if (!filed) return null;
  let s = filed.toUpperCase();
  if (!s.includes('NIFTY')) return null;                     // BSE / foreign → not on NSE Indices
  if (/\+|%|MSCI|S&P|SHARIAH|\bASIA\b|WORLD/.test(s)) return null; // blends/shariah/foreign → use fallback
  s = s.replace(/\(.*?\)/g, ' ').replace(/\bTOTAL\s+RETURNS?\s+INDEX\b/g, ' ')
    .replace(/\bTRI\b/g, ' ').replace(/\bINDEX\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === 'NIFTY 500 MULTICAP 50:25:25') s = 'NIFTY500 MULTICAP 50:25:25';
  if (s === 'NIFTY 100 ESG') s = 'NIFTY100 ESG';
  return CANONICAL.has(s) ? s : null;
}

/**
 * Resolve the TRI index for a fund:
 *   { indexName, basis:'filed'|'category'|'index' } | { overseas:true } | null (→ N/A).
 * For a passive index fund (opts.isIndex), the benchmark is the index it TRACKS (derived from its
 * name, basis 'index'); overseas trackers return { overseas:true }; a factor/other index returns
 * null. Index funds never get a peer-group proxy. Active funds keep the filed→category logic.
 */
export function resolveBenchmark(filed, peerGroup, opts = {}) {
  const { isIndex, name } = opts;
  if (isIndex) {
    const n = (name || '').toLowerCase(); // caller passes the AMC-stripped name (FIX 6)
    if (OVERSEAS_RE.test(n) || peerGroup === 'Index: International') return { overseas: true };
    if (peerGroup === 'Index: Factor / Smart-Beta' || peerGroup === 'Index: Other') return null; // specific TRI not carried → N/A, never a proxy
    // A passive fund legally tracks the index named in its OWN title, so the name is authoritative.
    // The filed field is secondary: tigzig's ssd_benchmark_tier1_std / amfi_daily_benchmark_filed
    // each carry occasional errors (e.g. a Nifty 50 fund filed as "Nifty Next 50"), and they even
    // disagree with each other — but the scheme name is never wrong about which index it tracks.
    const info = indexTrack(n, peerGroup);
    if (info && info !== 'overseas' && info !== 'na') return { indexName: info, basis: 'index' };
    const d = normalizeFiled(filed); // name didn't name a carried index → fall back to the filed benchmark
    if (d) return { indexName: d, basis: 'filed' };
    return null;
  }
  const direct = normalizeFiled(filed);
  if (direct) return { indexName: direct, basis: 'filed' };
  const fb = PEERGROUP_FALLBACK[peerGroup];
  if (fb) return { indexName: fb, basis: 'category' };
  return null;
}

function parseNiftyDate(s) {
  const m = String(s).trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  return mo === undefined ? null : Date.UTC(+m[3], mo, +m[1]);
}
function todayDMY() {
  const d = new Date();
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, '0')}-${mo}-${d.getUTCFullYear()}`;
}

/**
 * Fetch a TRI series (ascending [{t, nav}]) for a canonical index name. Returns null on an empty
 * array (a silent name mismatch) so the caller can log it and mark affected funds N/A.
 */
export async function fetchTRI(indexName, { startDate = '01-Jan-2010', retries = 3 } = {}) {
  const body = JSON.stringify({ cinfo: `{'name':'${indexName}','startDate':'${startDate}','endDate':'${todayDMY()}','indexName':'${indexName}'}` });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(NIFTY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = JSON.parse(await res.text());
      if (!Array.isArray(arr) || arr.length === 0) return null; // empty => name mismatch
      const series = arr
        .map((r) => ({ t: parseNiftyDate(r.Date), nav: Number(r.TotalReturnsIndex) }))
        .filter((p) => p.t != null && Number.isFinite(p.nav) && p.nav > 0)
        .sort((a, b) => a.t - b.t);
      return series.length ? series : null;
    } catch (err) { lastErr = err; if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); }
  }
  throw lastErr;
}

/** Benchmark returns anchored to the FUND's latest date: 1Y absolute, 3/5/10Y CAGR. */
export function benchmarkReturns(series, fundLatestMs) {
  const now = navOnOrBefore(series, fundLatestMs);
  if (!now) return null;
  const period = (years, annualize) => {
    const then = navOnOrBefore(series, yearsBefore(fundLatestMs, years));
    if (!then || then.nav <= 0) return null;
    const ratio = now.nav / then.nav;
    if (!annualize) return ratio - 1;
    const days = daysBetween(then.t, now.t);
    return days > 0 ? Math.pow(ratio, DAYS_PER_YEAR / days) - 1 : null;
  };
  return { y1: period(1, false), y3: period(3, true), y5: period(5, true), y10: period(10, true) };
}

/** Downsample a daily series to the last trading day of each calendar month: [{date, value}]. */
export function monthlyDownsample(series) {
  const out = [], idx = new Map();
  for (const p of series) {
    const d = new Date(p.t), key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const point = { date: toISODate(p.t), value: p.nav };
    if (idx.has(key)) out[idx.get(key)] = point; else { idx.set(key, out.length); out.push(point); }
  }
  return out;
}
