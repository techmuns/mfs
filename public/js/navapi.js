// navapi.js — the one live browser fetch: per-fund NAV history from MFAPI (CORS-enabled), cached
// per session. Plus small helpers to window, rebase and align series for the growth charts.

const cache = new Map();

export async function fetchNav(schemeCode) {
  if (cache.has(schemeCode)) return cache.get(schemeCode);
  const res = await fetch(`https://api.mfapi.in/mf/${schemeCode}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const raw = await res.json();
  const pts = (raw.data || []).map((d) => {
    const [dd, mm, yy] = d.date.split('-').map(Number);
    return [Date.UTC(yy, mm - 1, dd), Number(d.nav)];
  }).filter((p) => isFinite(p[0]) && isFinite(p[1]) && p[1] > 0).sort((a, b) => a[0] - b[0]);
  cache.set(schemeCode, pts);
  return pts;
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
/** Convert a benchmarks.json monthly series [{date,value}] to [[ts, value]]. */
export function benchToSeries(bench) {
  if (!bench || !bench.series) return [];
  return bench.series.map((p) => {
    const [y, m, d] = p.date.split('-').map(Number);
    return [Date.UTC(y, m - 1, d), p.value];
  });
}
