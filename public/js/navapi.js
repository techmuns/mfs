// navapi.js — the one live browser fetch: per-fund NAV history, cached per session. Plus small
// helpers to window, rebase and align series for the growth charts.
//
// NAV comes from MFAPI (api.mfapi.in), but MFAPI's GET responses stopped sending a CORS header, so
// the browser can't fetch it directly any more. We go through a SAME-ORIGIN proxy ("/nav/:code", a
// Cloudflare Pages Function — see functions/nav/[code].js) which fetches MFAPI server-side (no CORS)
// and edge-caches it. A direct MFAPI hit is kept as a fallback for local dev / if MFAPI restores CORS.
// MFAPI cache misses can take 20s+ or fail transiently, so each attempt has a timeout (a hung request
// is aborted and retried) and a couple of backoff retries, so a slow/flaky response self-heals instead
// of leaving the chart stuck on "Could not load live NAV".

const cache = new Map();

async function fetchJsonWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function fetchNavJson(schemeCode, timeoutMs) {
  try {
    return await fetchJsonWithTimeout(`/nav/${schemeCode}`, timeoutMs);
  } catch (err) {
    // Fall back to a direct MFAPI hit only when the proxy ROUTE is absent (404 — e.g. local dev or the
    // function isn't deployed). On a timeout/upstream error a direct hit would just fail on CORS too.
    if (String(err && err.message).includes('404')) return fetchJsonWithTimeout(`https://api.mfapi.in/mf/${schemeCode}`, timeoutMs);
    throw err;
  }
}

export async function fetchNav(schemeCode, { retries = 2, timeoutMs = 13000 } = {}) {
  if (cache.has(schemeCode)) return cache.get(schemeCode);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await fetchNavJson(schemeCode, timeoutMs);
      const pts = (raw.data || []).map((d) => {
        const [dd, mm, yy] = d.date.split('-').map(Number);
        return [Date.UTC(yy, mm - 1, dd), Number(d.nav)];
      }).filter((p) => isFinite(p[0]) && isFinite(p[1]) && p[1] > 0).sort((a, b) => a[0] - b[0]);
      if (!pts.length) throw new Error('empty NAV series');
      cache.set(schemeCode, pts);
      return pts;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Keep points within the last `years` (null = all). */
export function sliceYears(pts, years) {
  if (!years || !pts.length) return pts;
  const cut = pts[pts.length - 1][0] - years * 365.25 * 86400000;
  return pts.filter((p) => p[0] >= cut);
}
/** Keep points on/after a timestamp. */
export function sliceFrom(pts, fromMs) {
  return pts.filter((p) => p[0] >= fromMs);
}
/** Rebase a series so its first value equals `base`. */
export function rebase(pts, base = 100) {
  if (!pts.length) return pts;
  const first = pts[0][1];
  return first > 0 ? pts.map(([t, v]) => [t, (v / first) * base]) : pts;
}

/** Linear-interpolate a [[ts,val]] series at timestamp `ts` (clamped at the ends). */
function interpAt(series, ts) {
  if (!series.length) return null;
  if (ts <= series[0][0]) return series[0][1];
  if (ts >= series[series.length - 1][0]) return series[series.length - 1][1];
  for (let i = 1; i < series.length; i++) {
    if (series[i][0] >= ts) { const [t0, v0] = series[i - 1], [t1, v1] = series[i]; return t1 === t0 ? v1 : v0 + (v1 - v0) * ((ts - t0) / (t1 - t0)); }
  }
  return series[series.length - 1][1];
}

/** Rebase one series to `base` at an explicit anchor timestamp (interpolating onto it), starting
 *  the output exactly at [anchorTs, base]. Used to align the monthly benchmark to the fund's start. */
export function rebaseAt(series, anchorTs, base = 100) {
  if (!series || !series.length) return [];
  const b = interpAt(series, anchorTs);
  if (!(b > 0)) return [];
  return [[anchorTs, base], ...series.filter((p) => p[0] > anchorTs).map(([t, v]) => [t, (v / b) * base])];
}

/**
 * Align a daily fund series and a (monthly) benchmark series to ONE common anchor so both start at
 * `base` on the SAME date (FIX 4). Anchor A = max(fundStart, benchStart); the benchmark is
 * interpolated onto the fund's anchor point so the on-chart excess isn't distorted by a ~10–30 day gap.
 */
export function alignRebase(fund, bench, base = 100) {
  if (!fund || !fund.length) return { fund: [], bench: [] };
  if (!bench || !bench.length) return { fund: rebase(fund, base), bench: [] };
  const A = Math.max(fund[0][0], bench[0][0]);
  const fi = fund.findIndex((p) => p[0] >= A);
  if (fi < 0) return { fund: rebase(fund, base), bench: [] };
  const anchorTs = fund[fi][0], fundBase = fund[fi][1], benchBase = interpAt(bench, anchorTs);
  if (!(fundBase > 0) || !(benchBase > 0)) return { fund: rebase(fund.slice(fi), base), bench: [] };
  return {
    fund: fund.slice(fi).map(([t, v]) => [t, (v / fundBase) * base]),
    bench: [[anchorTs, base], ...bench.filter((p) => p[0] > anchorTs).map(([t, v]) => [t, (v / benchBase) * base])],
  };
}
/** Convert a benchmarks.json monthly series [{date,value}] to [[ts, value]]. */
export function benchToSeries(bench) {
  if (!bench || !bench.series) return [];
  return bench.series.map((p) => {
    const [y, m, d] = p.date.split('-').map(Number);
    return [Date.UTC(y, m - 1, d), p.value];
  });
}
