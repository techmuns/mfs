// metrics.mjs — all per-fund financial computations, from a clean NAV series.
//
// Input everywhere is a NAV series sorted OLDEST -> NEWEST: [{ t: <UTC ms>, nav }, ...].
// Golden rule: NEVER interpolate a missing day. "NAV on/before date D" means the nearest
// available trading day at or before D (navOnOrBefore). A metric that needs history the
// fund doesn't have returns null (N/A), never 0.
//
// Return convention: everything is a DECIMAL fraction. 0.1234 == +12.34%. CAGR uses a
// 365.25-day year; annualisation of daily volatility uses 252 trading days.

import { DAYS_PER_YEAR, daysBetween, monthsBefore, yearsAfter, yearsBefore } from './dates.mjs';

const TRADING_DAYS_PER_YEAR = 252;

/**
 * NAV on or before targetMs: the latest series point whose date is <= targetMs.
 * Returns null when targetMs precedes the fund's very first NAV (insufficient history).
 * Binary search; series is ascending by t.
 */
export function navOnOrBefore(series, targetMs) {
  if (series.length === 0 || targetMs < series[0].t) return null;
  let lo = 0, hi = series.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= targetMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return series[ans];
}

/**
 * Return between the NAV on/before `targetMs` and `latest`.
 *  - annualize=false -> ABSOLUTE return: navLatest/navThen - 1   (used for periods <= 12 months)
 *  - annualize=true  -> CAGR: (navLatest/navThen)^(365.25/actualDays) - 1  (periods > 12 months)
 * The exponent uses the ACTUAL days between the two trading days, not the nominal period.
 */
export function periodReturn(series, latest, targetMs, annualize) {
  const then = navOnOrBefore(series, targetMs);
  if (!then || then.nav <= 0) return null;
  const ratio = latest.nav / then.nav;
  if (!annualize) return ratio - 1;
  const days = daysBetween(then.t, latest.t);
  if (days <= 0) return null;
  return Math.pow(ratio, DAYS_PER_YEAR / days) - 1;
}

function sinceInception(series, latest) {
  const first = series[0];
  const days = daysBetween(first.t, latest.t);
  if (first.nav <= 0 || days <= 0) return null;
  const ratio = latest.nav / first.nav;
  // Same rule as trailing periods: <= 12 months absolute, otherwise CAGR.
  return days <= DAYS_PER_YEAR ? ratio - 1 : Math.pow(ratio, DAYS_PER_YEAR / days) - 1;
}

/** Trailing returns at 1M / 3M / 6M / 1Y / 3Y / 5Y / 10Y / since-inception. */
function trailingReturns(series, latest) {
  const L = latest.t;
  return {
    m1: periodReturn(series, latest, monthsBefore(L, 1), false),
    m3: periodReturn(series, latest, monthsBefore(L, 3), false),
    m6: periodReturn(series, latest, monthsBefore(L, 6), false),
    y1: periodReturn(series, latest, yearsBefore(L, 1), false), // exactly 12 months => absolute
    y3: periodReturn(series, latest, yearsBefore(L, 3), true),
    y5: periodReturn(series, latest, yearsBefore(L, 5), true),
    y10: periodReturn(series, latest, yearsBefore(L, 10), true),
    si: sinceInception(series, latest),
  };
}

function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = n >> 1;
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/**
 * Rolling returns for a fixed window length (`windowYears`, e.g. 3 or 5).
 *
 * Convention: window starts step MONTHLY. The most recent start is (latest - windowYears)
 * so the final window ends exactly on the latest NAV; we then step back one calendar month
 * at a time until the start would precede inception. Each window's return is the CAGR over
 * that window's actual span (nearest trading day on/before each end of the window).
 *
 * Returns { avg, median, min, max, pctPositive, n }, or null if not a single full window
 * fits (i.e. the fund has < windowYears of history). `n` is the window count and doubles as
 * the confidence signal — fewer than ~12 windows should be read as low-confidence.
 */
function rollingReturns(series, latest, windowYears) {
  const firstMs = series[0].t;
  const cagrs = [];
  let start = yearsBefore(latest.t, windowYears);
  while (start >= firstMs) {
    const startPt = navOnOrBefore(series, start);
    const endPt = navOnOrBefore(series, yearsAfter(start, windowYears));
    if (startPt && endPt && startPt.nav > 0) {
      const days = daysBetween(startPt.t, endPt.t);
      if (days > 0) cagrs.push(Math.pow(endPt.nav / startPt.nav, DAYS_PER_YEAR / days) - 1);
    }
    start = monthsBefore(start, 1);
  }
  const n = cagrs.length;
  if (n < 1) return null;
  cagrs.sort((a, b) => a - b);
  const sum = cagrs.reduce((s, x) => s + x, 0);
  const positive = cagrs.filter((x) => x > 0).length;
  return {
    avg: sum / n,
    median: median(cagrs),
    min: cagrs[0],
    max: cagrs[n - 1],
    pctPositive: positive / n,
    n,
  };
}

function emptyRisk() {
  return { volatility: null, sharpe: null, maxDrawdown: null, sortino: null, lookbackYears: null };
}

/**
 * Risk metrics over a 3-YEAR lookback window (falling back to full history if the fund is
 * younger than 3y — `lookbackYears` then reports the shorter actual window).
 *
 *  - volatility   = sample stdev(daily simple returns) * sqrt(252)   (annualised)
 *  - sharpe       = (annualised return over the window - riskFree) / volatility
 *  - maxDrawdown  = largest peak-to-trough NAV decline in the window (negative fraction)
 *  - sortino      = (annualised return over the window - riskFree) / downside deviation,
 *                   downside deviation = sqrt(mean(min(0, r)^2)) * sqrt(252), MAR = 0.
 *
 * The Sharpe/Sortino numerator uses the annualised return over the SAME window as the
 * volatility (equal to the 3Y CAGR when >= 3y of history exists), so return and risk are
 * measured consistently. volatility/sharpe/sortino require >= 60 daily returns (~3 trading
 * months) to be considered robust, otherwise they are N/A.
 */
function riskMetrics(series, latest, riskFreeRate) {
  const target3y = yearsBefore(latest.t, 3);
  const startMs = series[0].t <= target3y ? target3y : series[0].t; // 3y, else full history
  const subset = series.filter((p) => p.t >= startMs);
  if (subset.length < 2) return emptyRisk();

  const startPt = subset[0];
  const lookbackDays = daysBetween(startPt.t, latest.t);
  const lookbackYears = lookbackDays / DAYS_PER_YEAR;
  const windowCagr = startPt.nav > 0 && lookbackDays > 0
    ? Math.pow(latest.nav / startPt.nav, DAYS_PER_YEAR / lookbackDays) - 1
    : null;

  const rets = [];
  for (let i = 1; i < subset.length; i++) {
    const r = subset[i].nav / subset[i - 1].nav - 1;
    if (Number.isFinite(r)) rets.push(r);
  }

  let volatility = null, sharpe = null, sortino = null;
  const MIN_RETURNS = 60;
  if (rets.length >= MIN_RETURNS) {
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
    volatility = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    if (volatility > 0 && windowCagr != null) sharpe = (windowCagr - riskFreeRate) / volatility;

    const downVar = rets.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / rets.length;
    const downDev = Math.sqrt(downVar) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    if (downDev > 0 && windowCagr != null) sortino = (windowCagr - riskFreeRate) / downDev;
  }

  let peak = subset[0].nav, maxDd = 0;
  for (const p of subset) {
    if (p.nav > peak) peak = p.nav;
    const dd = p.nav / peak - 1;
    if (dd < maxDd) maxDd = dd;
  }

  return { volatility, sharpe, maxDrawdown: maxDd, sortino, lookbackYears };
}

/** has3y / has5y / has10y: does the fund's first NAV reach back that far? */
function historyFlags(series, latest) {
  const first = series[0].t;
  return {
    has3y: first <= yearsBefore(latest.t, 3),
    has5y: first <= yearsBefore(latest.t, 5),
    has10y: first <= yearsBefore(latest.t, 10),
  };
}

/**
 * Compute the full metric bundle for one fund from its NAV series.
 * Returns null if there is not enough data (< 2 points) to compute anything.
 * All numbers are full precision here; rounding happens once at serialisation time.
 */
export function computeFundMetrics(series, riskFreeRate) {
  if (!series || series.length < 2) return null;
  const latest = series[series.length - 1];
  const first = series[0];
  return {
    latestNav: latest.nav,
    latestNavDate: latest.t,
    inceptionDate: first.t,
    ageYears: daysBetween(first.t, latest.t) / DAYS_PER_YEAR,
    returns: trailingReturns(series, latest),
    rolling: {
      y3: rollingReturns(series, latest, 3),
      y5: rollingReturns(series, latest, 5),
    },
    risk: riskMetrics(series, latest, riskFreeRate),
    history: historyFlags(series, latest),
  };
}
