// build.mjs — the nightly data pipeline.
//
//   AMFI NAVAll  ->  Phase-1 universe (open-ended equity, Direct + Growth)
//   MFAPI        ->  NAV history per fund (small concurrency, retries, skip-on-fail)
//   metrics      ->  trailing / rolling / risk / vs-category, every figure computed
//                    from real NAV history with a documented formula
//   output       ->  public/data/{funds,categories,status}.json
//
// Design: compute everything here, in CI, and commit compact JSON. The browser only ever
// reads these JSON files — it never crunches NAV history. The build is deterministic given
// its inputs (stable sort order; only status.json carries the run timestamp) and resilient
// (one bad fund is logged and skipped, never fails the run).
//
// Run: `node scripts/build.mjs`  (Node 22+, no npm dependencies).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toISODate } from './lib/dates.mjs';
import { pool } from './lib/http.mjs';
import { AMFI_URL, fetchAmfiNavAll, parseAmfiEquityUniverse } from './lib/amfi.mjs';
import { fetchScheme, toNavSeries } from './lib/mfapi.mjs';
import { computeFundMetrics } from './lib/metrics.mjs';
import { computeCategories, attachVsCategory } from './lib/categories.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'public', 'data');
const CONCURRENCY = 8;

const log = (...a) => console.log(...a);

function loadRiskFreeRate() {
  const p = join(__dirname, 'config', 'risk-free-rate.json');
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  if (typeof cfg.annual_rate !== 'number' || !Number.isFinite(cfg.annual_rate)) {
    throw new Error('risk-free-rate.json: annual_rate must be a finite number');
  }
  return cfg;
}

// Round every number to 6 decimals on the way out — keeps the files compact without
// losing meaningful precision (6 decimals on a fraction == 1e-4 %).
function roundReplacer(_key, value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1e6) / 1e6
    : value;
}

function writeJson(name, obj) {
  const path = join(DATA_DIR, name);
  writeFileSync(path, JSON.stringify(obj, roundReplacer) + '\n');
  return path;
}

async function main() {
  const startedAt = Date.now();
  mkdirSync(DATA_DIR, { recursive: true });

  const rf = loadRiskFreeRate();
  log(`Risk-free rate: ${(rf.annual_rate * 100).toFixed(4)}% (${rf.source}, as of ${rf.as_of})`);

  // 1) AMFI universe ---------------------------------------------------------
  log('Fetching AMFI NAVAll ...');
  const navAllText = await fetchAmfiNavAll();
  const universe = parseAmfiEquityUniverse(navAllText);
  log(`AMFI universe: ${universe.length} open-ended equity Direct-Growth schemes`);
  if (universe.length === 0) throw new Error('AMFI parse produced 0 funds — aborting (likely a format change)');

  // AMFI's file date (all rows share one date) — used as the AMFI source as-of.
  const amfiAsOf = toISODate(Math.max(...universe.map((u) => u.amfiDate || 0))) || null;

  // 2) MFAPI history + metrics ----------------------------------------------
  log(`Fetching NAV history from MFAPI (concurrency ${CONCURRENCY}) ...`);
  const results = await pool(
    universe,
    CONCURRENCY,
    async (u) => {
      const raw = await fetchScheme(u.schemeCode);
      const series = toNavSeries(raw);
      if (series.length < 2) throw new Error('no usable NAV history');
      const m = computeFundMetrics(series, rf.annual_rate);
      if (!m) throw new Error('metrics unavailable');
      return {
        schemeCode: u.schemeCode,
        name: u.name,
        amc: u.amc || (raw.meta && raw.meta.fund_house) || null,
        category: u.category,
        plan: u.plan,
        option: u.option,
        isin: u.isin || (raw.meta && raw.meta.isin_growth) || null,
        inceptionDate: toISODate(m.inceptionDate),
        ageYears: m.ageYears,
        latestNav: m.latestNav,
        latestNavDate: toISODate(m.latestNavDate),
        returns: m.returns,
        rolling: m.rolling,
        risk: m.risk,
        vsCategory: null, // filled in the category pass below
        history: m.history,
        _latestNavMs: m.latestNavDate, // internal, stripped before write
      };
    },
    (done, total) => { if (done % 50 === 0 || done === total) log(`  ${done}/${total}`); },
  );

  const funds = [];
  const failures = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.ok) funds.push(r.value);
    else failures.push({ schemeCode: universe[i].schemeCode, name: universe[i].name, reason: String(r.error && r.error.message || r.error) });
  }
  log(`Computed metrics for ${funds.length} funds (${failures.length} skipped)`);
  for (const f of failures.slice(0, 20)) log(`  skip ${f.schemeCode} ${f.name}: ${f.reason}`);
  if (failures.length > 20) log(`  ...and ${failures.length - 20} more`);

  // Stable, human-friendly order: category, then fund name, then scheme code.
  funds.sort((a, b) =>
    a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.schemeCode - b.schemeCode);

  // Latest NAV date across the whole set — the MFAPI data "as of".
  const dataAsOf = toISODate(Math.max(...funds.map((f) => f._latestNavMs || 0))) || amfiAsOf;

  // 3) Categories + vs-category ---------------------------------------------
  const categories = computeCategories(funds, dataAsOf);
  attachVsCategory(funds, categories);

  // 4) Counts + write --------------------------------------------------------
  const counts = {
    equityDirectGrowth: funds.length,
    with3y: funds.filter((f) => f.history.has3y).length,
    with5y: funds.filter((f) => f.history.has5y).length,
    with10y: funds.filter((f) => f.history.has10y).length,
    failures: failures.length,
  };

  for (const f of funds) delete f._latestNavMs; // strip internal field

  const status = {
    generated_at: new Date(startedAt).toISOString(),
    data_as_of: dataAsOf,
    sources: [
      { name: 'MFAPI.in', url: 'https://www.mfapi.in/', asOf: dataAsOf, note: 'NAV history + scheme metadata (per-fund)' },
      { name: 'AMFI NAVAll', url: AMFI_URL, asOf: amfiAsOf, note: 'Official classified scheme universe (category + AMC)' },
    ],
    riskFreeRate: rf,
    counts,
    notes: [
      'Phase 1 universe: open-ended EQUITY schemes, Direct plan, Growth option only.',
      'Category averages are over Direct-Growth funds only (each portfolio counted once).',
      'Returns are decimal fractions (0.12 = 12%). Periods <= 12 months are absolute, longer periods are CAGR (365.25-day year).',
      'Risk metrics use a 3-year lookback (full history if younger, see risk.lookbackYears); volatility annualised with sqrt(252).',
      'Rolling returns step window starts monthly; rolling.*.n is the window count / confidence (read n < 12 as low-confidence).',
      'NAV "on/before" a date walks back to the nearest trading day — missing days are never interpolated. Insufficient history => null (N/A), never 0.',
    ],
  };

  const fundsPath = writeJson('funds.json', funds);
  const catsPath = writeJson('categories.json', categories);
  const statusPath = writeJson('status.json', status);

  const sizeKB = (p) => (readFileSync(p).length / 1024).toFixed(1);
  log('');
  log(`Wrote ${fundsPath} (${sizeKB(fundsPath)} KB)`);
  log(`Wrote ${catsPath} (${sizeKB(catsPath)} KB)`);
  log(`Wrote ${statusPath} (${sizeKB(statusPath)} KB)`);
  log('');
  log(`Counts: ${JSON.stringify(counts)}`);
  log(`Categories: ${Object.keys(categories).length} | data as of ${dataAsOf}`);
  log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('BUILD FAILED:', err);
  process.exit(1);
});
