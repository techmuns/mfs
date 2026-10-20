// dates.mjs — date parsing + calendar helpers for the MF screener data pipeline.
//
// All dates are normalised to a UTC-midnight epoch-millisecond timestamp. We never
// deal in local time, so there is no DST / timezone drift between CI runs.

const MS_PER_DAY = 86_400_000;
export const DAYS_PER_YEAR = 365.25; // Julian year — the convention used for CAGR annualisation.

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse an MFAPI date string "DD-MM-YYYY" to a UTC-midnight timestamp (ms).
 * Returns null if the string is malformed.
 */
export function parseMfApiDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const day = +m[1], mon = +m[2], year = +m[3];
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, mon - 1, day);
}

/**
 * Parse an AMFI date string "DD-Mon-YYYY" (e.g. "19-Oct-2026") to a UTC-midnight
 * timestamp (ms). Returns null if malformed.
 */
export function parseAmfiDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const day = +m[1];
  const mon = MONTHS[m[2].toLowerCase()];
  const year = +m[3];
  if (mon === undefined || day < 1 || day > 31) return null;
  return Date.UTC(year, mon, day);
}

/** Format a UTC timestamp (ms) as an ISO date "YYYY-MM-DD". */
export function toISODate(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole/fractional days between two UTC timestamps (b - a). */
export function daysBetween(aMs, bMs) {
  return (bMs - aMs) / MS_PER_DAY;
}

/**
 * Timestamp exactly `n` calendar months before `ms`, preserving day-of-month where
 * possible (JS Date rolls a non-existent day, e.g. 31 Feb, forward — acceptable here
 * because the metric code then walks back to the nearest available trading day).
 */
export function monthsBefore(ms, n) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, d.getUTCDate());
}

/** Timestamp exactly `n` calendar years before `ms` (same calendar date). */
export function yearsBefore(ms, n) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear() - n, d.getUTCMonth(), d.getUTCDate());
}

/** Timestamp exactly `n` calendar years after `ms` (same calendar date). */
export function yearsAfter(ms, n) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate());
}
