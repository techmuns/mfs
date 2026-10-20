// tigzig.mjs — fetch official AMFI/SEBI scheme disclosures (TER, AUM, managers, exit load,
// riskometer, filed benchmark) from tigzig's bulk CSV and index them by AMFI scheme code.
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

/** Parse the managers text "Name (since YYYY-MM-DD); Name (since ...)" into structured rows. */
function parseManagers(text, asOf) {
  const v = clean(text);
  if (!v) return null;
  const names = [];
  for (const part of v.split(';')) {
    const m = part.trim().match(/^(.*?)\s*\(since\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\)\s*$/i);
    if (m) {
      const since = m[2];
      const tenureYears = +(daysBetween(Date.parse(since), Date.now()) / DAYS_PER_YEAR).toFixed(1);
      names.push({ name: m[1].trim(), since, tenureYears });
    } else if (part.trim()) {
      names.push({ name: part.trim(), since: null, tenureYears: null });
    }
  }
  return names.length ? { names, asOf } : null;
}

/**
 * Download + parse the bulk CSV, returning Map<schemeCode, enrichment>:
 *   { costs:{terDirect,terRegular,asOf}|null, aum:{cr,asOf}|null, riskometer, benchmarkFiled,
 *     exitLoad:{text,asOf}|null, manager:{names,asOf}|null }
 * Only the first row per scheme_code is kept (the CSV lists each code once per plan).
 */
export async function fetchTigzigMap(opts = {}) {
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

    map.set(code, {
      costs: (terDirect != null || terRegular != null) ? { terDirect, terRegular, asOf: terAsOf } : null,
      aum: aumCr != null ? { cr: aumCr, asOf: aumAsOf } : null,
      riskometer: clean(row[col.amfi_daily_riskometer]),
      benchmarkFiled: bmFiled,
      exitLoad: exit ? { text: exit, asOf: docDate } : null,
      manager: parseManagers(row[col.ssd_fund_managers], docDate),
    });
  }
  return map;
}
