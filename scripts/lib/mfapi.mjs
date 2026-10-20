// mfapi.mjs — client for MFAPI.in (free, no key, CORS-enabled NAV history + metadata).
//
//   GET https://api.mfapi.in/mf/{schemeCode}
//     -> { meta: {...}, data: [ { date: "DD-MM-YYYY", nav: "224.07300" }, ... ], status }
//   data is newest-first; history runs back to ~2006/2013 depending on the scheme.

import { parseMfApiDate } from './dates.mjs';
import { fetchJson } from './http.mjs';

export function fetchScheme(schemeCode, opts) {
  return fetchJson(`https://api.mfapi.in/mf/${schemeCode}`, opts);
}

/**
 * Convert a raw MFAPI payload into a clean NAV series sorted OLDEST -> NEWEST:
 *   [ { t: <UTC ms>, nav: <number> }, ... ]
 * Invalid points (unparseable date, non-finite or non-positive NAV) are dropped, and
 * duplicate dates are collapsed (last value wins). Returns [] if there is no usable data.
 */
export function toNavSeries(raw) {
  if (!raw || !Array.isArray(raw.data)) return [];
  const pts = [];
  for (const row of raw.data) {
    const t = parseMfApiDate(row && row.date);
    const nav = Number(row && row.nav);
    if (t == null || !Number.isFinite(nav) || nav <= 0) continue;
    pts.push({ t, nav });
  }
  pts.sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1].t === p.t) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}
