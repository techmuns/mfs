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

import { toISODate, daysBetween, DAYS_PER_YEAR } from './lib/dates.mjs';
const isoToMs = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
import { pool } from './lib/http.mjs';
import { AMFI_URL, fetchAmfiNavAll, parseAmfiEquityUniverse } from './lib/amfi.mjs';
import { fetchScheme, toNavSeries } from './lib/mfapi.mjs';
import { computeFundMetrics } from './lib/metrics.mjs';
import { computeCategories, attachVsCategory } from './lib/categories.mjs';
import { derivePeerGroup } from './lib/peergroup.mjs';
import { enrichFunds } from './lib/enrich.mjs';
import { computeScores } from './lib/score.mjs';
import { computeAlertEvents, mergeAlerts } from './lib/alerts.mjs';

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

// Prior committed funds.json (array) — used for fail-soft enrichment carry-forward AND the
// "what's new" alerts diff (old vs new). Returns [] on the first ever run.
function readPriorFundsArray() {
  try { return JSON.parse(readFileSync(join(DATA_DIR, 'funds.json'), 'utf8')); }
  catch { return []; }
}

function readPriorAlerts() {
  try { return JSON.parse(readFileSync(join(DATA_DIR, 'alerts.json'), 'utf8')); }
  catch { return { events: [] }; }
}

// FIX 9 — collapse genuine duplicate share-classes: the same fund listed twice under two scheme
// codes with near-identical NAV (within 2%). Groups whose NAVs genuinely differ (e.g. Sundaram
// Small Cap's two distinct funds ₹38 vs ₹311) are kept intact. Within a duplicate group we keep the
// Growth share-class (tigzig plan without IDCW/dividend), then the active one, then the lowest code.
function dedupeFunds(funds, enrich, log) {
  const norm = (n) => (n || '').toLowerCase().replace(/\(.*?\)/g, '')
    .replace(/\b(direct|regular|growth|idcw|dividend|payout|reinvest|plan|option|fund)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const groups = new Map();
  for (const f of funds) { const k = norm(f.name) + '||' + (f.amc || ''); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
  const drop = new Set();
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    const navs = g.map((f) => f.latestNav).filter(Number.isFinite);
    if (navs.length < 2 || (Math.max(...navs) - Math.min(...navs)) / Math.max(...navs) >= 0.02) continue; // genuinely distinct — keep all
    const keep = [...g].sort((a, b) => {
      const ea = enrich.byCode.get(a.schemeCode) || {}, eb = enrich.byCode.get(b.schemeCode) || {};
      if (!!ea.idcwPlan !== !!eb.idcwPlan) return ea.idcwPlan ? 1 : -1; // Growth plan first
      if (!!ea.tigActive !== !!eb.tigActive) return ea.tigActive ? -1 : 1; // active first
      return a.schemeCode - b.schemeCode;
    })[0];
    for (const f of g) if (f !== keep) { drop.add(f.schemeCode); log(`  dedup: dropping [${f.schemeCode}] ${f.name} — duplicate share-class of [${keep.schemeCode}]`); }
  }
  return { funds: drop.size ? funds.filter((f) => !drop.has(f.schemeCode)) : funds, dropped: drop };
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
  const nIndexUni = universe.filter((u) => u.isIndex).length;
  log(`AMFI universe: ${universe.length} open-ended Direct-Growth schemes (${universe.length - nIndexUni} active + ${nIndexUni} passive index)`);
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
        isIndex: !!u.isIndex, // passive index fund (its own "Index: <segment>" peer group)
        peerGroup: derivePeerGroup(u.category, u.name, u.amc), // Sectoral/Thematic -> "Thematic: <Theme>"; Index Fund -> "Index: <segment>"
        plan: u.plan,
        option: u.option,
        isin: u.isin || (raw.meta && raw.meta.isin_growth) || null,
        navSince: toISODate(m.inceptionDate), // first Direct-plan NAV date — drives returns/risk (unchanged); true launch comes from tigzig allotment
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

  let funds = [];
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

  // 3) Enrichment: fees/AUM/manager/exit-load/riskometer (tigzig) + benchmark excess (NSE TRI)
  log('Enriching with disclosures + benchmark TRI ...');
  const priorFunds = readPriorFundsArray();                       // "yesterday" — for carry-forward + alerts
  const priorByCode = new Map(priorFunds.map((f) => [f.schemeCode, f]));
  const enrich = await enrichFunds(funds, priorByCode, log, dataAsOf);
  const dataAsOfMs = isoToMs(dataAsOf);
  for (const f of funds) {
    const e = enrich.byCode.get(f.schemeCode);
    f.benchmark = e.benchmark;
    f.costs = e.costs;
    f.aum = e.aum;
    f.manager = e.manager;
    f.exitLoad = e.exitLoad;
    f.riskometer = e.riskometer;
    // True inception from tigzig allotment (not the 2013 Direct-plan NAV start); fall back to the
    // NAV start and label it honestly. Returns/risk still use navSince (unchanged).
    if (e.allotmentDate) { f.inceptionDate = e.allotmentDate; f.inceptionBasis = 'allotment'; }
    else { f.inceptionDate = f.navSince; f.inceptionBasis = 'nav'; }
    f.ageYears = +(daysBetween(isoToMs(f.inceptionDate), dataAsOfMs) / DAYS_PER_YEAR).toFixed(1);
  }
  // Collapse genuine duplicate share-classes (same fund, two scheme codes, near-identical NAV).
  const dedup = dedupeFunds(funds, enrich, log);
  funds = dedup.funds;
  const droppedCodes = dedup.dropped; // for alerts: a deduped share-class merged, it did not close

  // Fail-soft universe: a transient source outage (AMFI returning a partial/stale file) must not drop
  // real funds from the screener or fire false "fund closed"/"new fund" alerts. Carry forward any fund
  // that was in the prior build but is missing from today's source, marked stale, until it has been
  // absent for MAX_ABSENT consecutive builds — only then is it treated as a genuine closure. A fund
  // that reappears is rebuilt fresh (markers cleared), so it never shows up as "new" again either.
  const MAX_ABSENT = 5;
  const liveCodes = new Set(funds.map((f) => f.schemeCode));
  let carried = 0;
  for (const pf of priorFunds) {
    if (liveCodes.has(pf.schemeCode)) continue;
    const absentBuilds = (pf.absentBuilds || 0) + 1;
    if (absentBuilds > MAX_ABSENT) continue; // gone long enough — accept the closure
    funds.push({ ...pf, stale: true, staleSince: pf.staleSince || dataAsOf, absentBuilds });
    carried++;
  }
  if (carried) log(`Universe fail-soft: ${carried} fund(s) missing from today's source carried forward (stale); ${funds.length} total`);
  const benchPath = writeJson('benchmarks.json', enrich.benchmarksJson);
  log(`Benchmark TRI: ${enrich.indicesFetched.length} indices fetched${enrich.emptyIndices.length ? `, ${enrich.emptyIndices.length} empty: ${enrich.emptyIndices.join(', ')}` : ''}`);
  log(`Coverage: ${JSON.stringify(enrich.coverage)}`);

  // 4) Categories + vs-category ---------------------------------------------
  const categories = computeCategories(funds, dataAsOf);
  attachVsCategory(funds, categories);

  // 5) Composite score (percentile within peer group) -----------------------
  computeScores(funds);

  // 4) Counts + write --------------------------------------------------------
  const counts = {
    equityDirectGrowth: funds.length,
    activeFunds: funds.filter((f) => !f.isIndex).length,
    indexFunds: funds.filter((f) => f.isIndex).length,
    with3y: funds.filter((f) => f.history.has3y).length,
    with5y: funds.filter((f) => f.history.has5y).length,
    with10y: funds.filter((f) => f.history.has10y).length,
    peerGroups: Object.keys(categories).length,
    failures: failures.length,
  };

  // Field coverage (how many of the funds carry each enriched field).
  const coverage = {
    total: funds.length,
    benchmark: enrich.coverage.benchmark,
    ter: enrich.coverage.ter,
    aum: enrich.coverage.aum,
    manager: enrich.coverage.manager,
    exitLoad: enrich.coverage.exitLoad,
    riskometer: enrich.coverage.riskometer,
    score: funds.filter((f) => f.score && f.score.composite != null).length,
  };

  for (const f of funds) delete f._latestNavMs; // strip internal field

  const status = {
    generated_at: new Date(startedAt).toISOString(),
    data_as_of: dataAsOf,
    sources: [
      { name: 'MFAPI.in', url: 'https://www.mfapi.in/', asOf: dataAsOf, note: 'NAV history + scheme metadata (per-fund)' },
      { name: 'AMFI NAVAll', url: AMFI_URL, asOf: amfiAsOf, note: 'Official classified scheme universe (category + AMC)' },
      ...enrich.sources,
    ],
    riskFreeRate: rf,
    counts,
    coverage,
    benchmarkIndices: enrich.indicesFetched,
    enrichmentWarnings: enrich.warnings,
    notes: [
      'Universe: open-ended Direct-Growth schemes — ACTIVE equity (every sub-category) plus PASSIVE equity index funds (category "Index Fund", isIndex:true); debt / target-maturity / commodity index funds are excluded by name.',
      'Passive index funds live in their own "Index: <segment>" peer groups (Large Cap, Broad Market, Mid & Small Cap, Sectoral, Factor / Smart-Beta, International, Other), so their averages and "vs category" never mix with active funds — the active peer-group averages are unchanged. An index fund is benchmarked against the index it TRACKS (benchmark.basis="index"); overseas trackers (Nasdaq / S&P 500 / MSCI) have no NSE TRI and show N/A. For a passive fund a slightly-negative benchmark excess (fee + tracking error) is expected and is a useful quality signal — judge it on low fee + tight tracking, not on beating the index.',
      'Averages and vs-category are computed per PEER GROUP: diversified categories stay as-is, while Sectoral/Thematic funds are split into "Thematic: <Theme>" groups (theme inferred from the scheme name) so like is compared with like. Each fund keeps its raw AMFI category too.',
      'Category averages are over Direct-Growth funds only (each portfolio counted once).',
      'Returns are decimal fractions (0.12 = 12%). Periods <= 12 months are absolute, longer periods are CAGR (365.25-day year).',
      'Risk metrics use a 3-year lookback (full history if younger, see risk.lookbackYears); volatility annualised with sqrt(252).',
      'Rolling returns step window starts monthly; rolling.*.n is the window count / confidence (read n < 12 as low-confidence).',
      'NAV "on/before" a date walks back to the nearest trading day — missing days are never interpolated. Insufficient history => null (N/A), never 0.',
      'Benchmark: Total Return Index (TRI) from NSE Indices. benchmark.basis="filed" uses the scheme\'s own filed benchmark; "basis"="category" means the filed benchmark is a non-NSE index (e.g. a BSE index) and a peer-group Nifty proxy was used (never a silent substitution). No sound mapping (e.g. Thematic: Other, International) => benchmark N/A with a reason. Excess = fund CAGR − benchmark CAGR over the same windows; returns are already net of fees so TER is not deducted again.',
      'Fees (TER), AUM, fund managers, exit load and riskometer are AMFI/SEBI disclosures via tigzig, each stamped with the disclosure as-of date; a field missing from the disclosure is null. If a source is down, the prior committed value is carried forward and marked stale:true.',
      'inceptionDate is the fund\'s TRUE launch (tigzig ssd_allotment_date); inceptionBasis="nav" marks funds where that was unavailable and the first Direct-plan NAV date (navSince) is used instead. Returns/risk are always computed from the NAV history (navSince onward) and are unaffected.',
      'Lead fund manager is the FIRST-listed manager (tigzig lists the lead first; sleeve/co-managers follow). The `since` date is a SEBI (re-)notification date, so tenure is a floor computed against data_as_of (deterministic). When the lead\'s tenure can\'t be trusted (unknown, or a recent re-notification on a long-record fund) the manager pillar is null (insufficient data) rather than a fabricated/penalised score.',
      'Composite score (fund.score): each pillar is the fund\'s percentile within its peer group (Manager pillar is an absolute tenure mapping). The browser recombines pillars with adjustable weights; a pillar with no usable inputs is null and excluded. A composite needs >= 3 scored pillars (or pillars covering >= 50% of weight), else it is null ("partial") so a thinly-evidenced fund is not ranked against a fully-evidenced one. Research only — not investment advice.',
      'vs-category is N/A when the peer group is too small to be meaningful (sample size < 5) or when a negative fund return would produce a misleading negative "×" multiple (the percentage-point gap is still shown). Duplicate share-classes (same fund, two scheme codes, near-identical NAV) are collapsed so category averages are not double-counted.',
      'alerts.json is the "what\'s new" feed: each build diffs the previous committed funds.json against the new data and records plain-English change events (deduped, newest first, ~90 days / 500 max).',
    ],
  };

  // 6) "What's new" alerts: diff the previous committed funds.json against the new data.
  const priorAlerts = readPriorAlerts();
  const alertResult = computeAlertEvents(priorFunds, funds, status, new Set((priorAlerts.events || []).map((e) => e.id)), droppedCodes);
  const alertsOut = mergeAlerts(priorAlerts, alertResult, status.generated_at);
  const alertsPath = writeJson('alerts.json', alertsOut);
  log(`Alerts: ${alertResult.baseline ? 'baseline (first run)' : alertResult.events.length + ' new event(s)'}; ${alertsOut.count} in feed`);

  const fundsPath = writeJson('funds.json', funds);
  const catsPath = writeJson('categories.json', categories);
  const statusPath = writeJson('status.json', status);

  const sizeKB = (p) => (readFileSync(p).length / 1024).toFixed(1);
  log('');
  log(`Wrote ${fundsPath} (${sizeKB(fundsPath)} KB)`);
  log(`Wrote ${catsPath} (${sizeKB(catsPath)} KB)`);
  log(`Wrote ${benchPath} (${sizeKB(benchPath)} KB)`);
  log(`Wrote ${alertsPath} (${sizeKB(alertsPath)} KB)`);
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
