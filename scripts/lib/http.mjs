// http.mjs — resilient fetch helpers (retries + a small concurrency pool).
//
// Node 22 ships a global `fetch`, so we take no npm dependencies. MFAPI is a free,
// single-maintainer service, so we treat every request as potentially flaky: time it
// out, retry transient failures with exponential backoff, and never let one bad
// response crash the whole build.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fetch with an AbortController timeout. */
async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch `url` and return parsed JSON, with retries.
 *
 * - 404 is treated as "not found": returns null immediately, no retry.
 * - Other non-2xx responses and network/timeout errors are retried with exponential
 *   backoff (0.5s, 1s, 2s, 4s ...). After the last attempt the error is thrown.
 */
export async function fetchJson(url, { retries = DEFAULT_RETRIES, timeoutMs } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Fetch `url` and return the response body as text, with retries. */
export async function fetchText(url, { retries = DEFAULT_RETRIES, timeoutMs = 60_000, headers } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * Run `worker(item, index)` over `items` with at most `concurrency` in flight.
 * Never rejects: each result is `{ ok: true, value }` or `{ ok: false, error, item }`,
 * so one failing item can be logged and skipped without failing the batch.
 * `onProgress(done, total)` is called after each item settles.
 */
export async function pool(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;

  async function runOne() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error, item: items[i] };
      }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(runners);
  return results;
}
