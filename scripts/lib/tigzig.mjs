// tigzig.mjs — fetch official AMFI/SEBI scheme disclosures (TER, AUM, managers, exit load,
// riskometer, filed benchmark, true allotment date) from tigzig's bulk CSV, indexed by scheme code.
//
// tigzig re-serves official AMFI/SEBI disclosures. One gzipped CSV (~2.8 MB) covers every
// scheme/plan; we join on scheme_code (== our AMFI schemeCode). Provenance for every field is
// "AMFI/SEBI disclosures via tigzig" plus the per-field as-of date the disclosure carries.

import { gunzipSync } from 'node:zlib';
import { daysBetween, DAYS_PER_YEAR } from './dates.mjs';

export const TIGZIG_CSV_URL = 'https://api.tigzig.com/mf/v1/download/scheme_details_latest.csv.gz';
export const TIGZIG_SOURCE = 'AMFI/SEBI disclosures via tigzig';

/** Minimal RFC-4180 CSV parser (handles quotes, embedded commas and newlines). */
export function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const clean = (s) => { const v = (s ?? '').trim(); return v === '' || v.toUpperCase() === 'NULL' ? null : v; };
const numOrNull = (s) => { const v = clean(s); if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const dateOrNull = (s) => { const v = clean(s); return v ? v.slice(0, 10) : null; }; // ISO date prefix

// Optimal String Alignment (restricted Damerau-Levenshtein) distance — counts one adjacent
// transposition as a single edit, so "Agarwal"/"Agrawal" collapse to the same person.
export function osa(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
export const normName = (s) => (s || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

/** Dedupe near-identical manager spellings, preserving the tigzig LEAD-FIRST order. */
function dedupeNames(names) {
  const out = [];
  for (const n of names) {
    const key = normName(n.name);
    const dup = out.find((o) => { const ok = normName(o.name); return ok === key || osa(ok, key) <= 1; });
    if (dup) { if (dup.since == null && n.since != null) { dup.since = n.since; dup.tenureYears = n.tenureYears; } continue; }
    out.push(n);
  }
  return out;
}

/**
 * Parse the managers text "Name (since YYYY-MM-DD); Name (since ...)" into structured rows.
 * tigzig lists the LEAD manager FIRST (sleeve/co-managers follow), and `since` is the SEBI
 * (re-)notification date — often a recent re-notification, so tenure is a FLOOR, not the true start.
 * Tenure is measured against `asOfMs` (data_as_of) so a rebuild is deterministic (FIX 3).
 */
function parseManagers(text, asOf, asOfMs) {
  const v = clean(text);
  if (!v) return null;
  const names = [];
  for (const part of v.split(';')) {
    const m = part.trim().match(/^(.*?)\s*\(since\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\)\s*$/i);
    if (m) {
      const since = m[2];
      const tenureYears = +(daysBetween(Date.parse(since), asOfMs) / DAYS_PER_YEAR).toFixed(1);
      names.push({ name: m[1].trim(), since, tenureYears });
    } else if (part.trim()) {
      names.push({ name: part.trim(), since: null, tenureYears: null });
    }
  }
  const deduped = dedupeNames(names);
  return deduped.length ? { names: deduped, asOf } : null;
}

/**
 * Download + parse the bulk CSV, returning Map<schemeCode, enrichment>:
 *   { costs, aum, riskometer, benchmarkFiled, exitLoad, manager, allotmentDate, schemeName,
 *     isActive, idcwPlan }.  opts.asOfMs is the build's data_as_of (ms) used for manager tenure.
 * Only the first row per scheme_code is kept (the CSV lists each code once per plan).
 */
export async function fetchTigzigMap(opts = {}) {
  const asOfMs = Number.isFinite(opts.asOfMs) ? opts.asOfMs : Date.now();
  const res = await fetch(TIGZIG_CSV_URL, { headers: { 'User-Agent': 'mf-screener/1.0' }, signal: opts.signal });
  if (!res.ok) throw new Error(`tigzig CSV HTTP ${res.status}`);
  const csv = gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
  const rows = parseCSV(csv);
  const H = rows[0];
  const col = Object.fromEntries(H.map((h, i) => [h, i]));
  const map = new Map();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const code = Number(row[col.scheme_code]);
    if (!Number.isFinite(code) || map.has(code)) continue;

    const terDirect = numOrNull(row[col.ter_direct]);
    const terRegular = numOrNull(row[col.ter_regular]);
    const terAsOf = dateOrNull(row[col.ter_date]);
    const aumCr = numOrNull(row[col.amfi_daily_fund_aum_cr_all_plans]);
    const aumAsOf = dateOrNull(row[col.amfi_daily_aum_date]);
    const docDate = dateOrNull(row[col.ssd_doc_date]);
    const exit = clean(row[col.ssd_exit_load]);
    const bmFiled = clean(row[col.ssd_benchmark_tier1_std]) || clean(row[col.amfi_daily_benchmark_filed]);
    const schemeName = clean(row[col.scheme_name]);

    map.set(code, {
      costs: (terDirect != null || terRegular != null) ? { terDirect, terRegular, asOf: terAsOf } : null,
      aum: aumCr != null ? { cr: aumCr, asOf: aumAsOf } : null,
      riskometer: clean(row[col.amfi_daily_riskometer]),
      benchmarkFiled: bmFiled,
      exitLoad: exit ? { text: exit, asOf: docDate } : null,
      manager: parseManagers(row[col.ssd_fund_managers], docDate, asOfMs),
      allotmentDate: dateOrNull(row[col.ssd_allotment_date]), // true launch date (not the Direct-plan NAV start)
      schemeName,
      isActive: (clean(row[col.is_active]) || '').toLowerCase() !== 'false',
      idcwPlan: schemeName ? /idcw|dividend/i.test(schemeName) : null, // tigzig's plan label (for dedup tie-break)
    });
  }
  return map;
}
