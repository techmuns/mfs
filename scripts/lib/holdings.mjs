// holdings.mjs — parse AMC monthly portfolio disclosures (standard SEBI layout) into per-scheme
// holdings + sector allocation, and summarise concentration. Best-effort, per the Phase-3A spec:
// the hard part is each AMC serving its *current* file from a JS-rendered page (and PDF-only
// AMCs needing OCR), so this module provides the reusable parser/summary + an AMFI registry
// extractor; wiring each AMC's current-file fetcher (or a Bedrock fallback) is the extension point.
//
// Source stamp: "AMC monthly portfolio disclosure (SEBI-mandated)".

export const HOLDINGS_SOURCE = 'AMC monthly portfolio disclosure (SEBI-mandated)';

const norm = (s) => String(s || '').toLowerCase().replace(/\b(direct|regular|growth|idcw|dividend|plan|option|payout|reinvest(ment)?)\b/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Find the holdings header columns in a row, or null. */
function headerCols(row) {
  let name = -1, isin = -1, industry = -1, pct = -1;
  row.forEach((c, i) => {
    const s = String(c || '').toLowerCase();
    if (name < 0 && s.includes('name of the instrument')) name = i;
    else if (isin < 0 && s === 'isin') isin = i;
    else if (industry < 0 && (s.includes('industry') || s.includes('rating'))) industry = i;
    else if (pct < 0 && (s.includes('% to nav') || s.includes('% of nav') || s.includes('% to net'))) pct = i;
  });
  return name >= 0 && pct >= 0 ? { name, isin, industry, pct } : null;
}

/**
 * Parse one worksheet (rows = array of cell arrays) into scheme sections:
 * [{ scheme, holdings:[{name, isin, industry, pct}] }]. `pct` is the fraction to NAV (0.068 = 6.8%).
 */
export function parsePortfolioSheet(rows) {
  const schemes = [];
  let cur = null, cols = null;
  for (const row of rows) {
    if (!row || !row.length) continue;
    const joined = row.map((c) => (c == null ? '' : String(c))).join(' ');
    const sm = joined.match(/Name of the Scheme\s*:?\s*(.+)/i);
    if (sm) { cur = { scheme: sm[1].replace(/\s{2,}.*$/, '').trim(), holdings: [] }; schemes.push(cur); cols = null; continue; }
    const hc = headerCols(row);
    if (hc) { cols = hc; continue; }
    if (cur && cols) {
      const isin = cols.isin >= 0 ? String(row[cols.isin] || '').trim() : '';
      const pct = Number(row[cols.pct]);
      const name = String(row[cols.name] || '').trim();
      if (/^[A-Z]{2}[A-Z0-9]{9,10}$/i.test(isin) && Number.isFinite(pct) && pct > 0 && name) { // any ISIN (incl. foreign)
        cur.holdings.push({ name, isin, industry: (String(row[cols.industry] || '').trim() || null), pct });
      }
    }
  }
  return schemes.filter((s) => s.holdings.length);
}

/** Summarise one scheme's holdings into the committed shape. */
export function summarizeHoldings(holdings, month) {
  const sorted = [...holdings].sort((a, b) => b.pct - a.pct);
  const top10 = sorted.slice(0, 10).map((h) => ({ name: h.name, pct: h.pct }));
  const sum = (arr) => arr.reduce((s, h) => s + h.pct, 0);
  const sectorMap = {};
  for (const h of holdings) { const sec = h.industry || 'Unclassified'; sectorMap[sec] = (sectorMap[sec] || 0) + h.pct; }
  const sectors = Object.entries(sectorMap).map(([sector, pct]) => ({ sector, pct })).sort((a, b) => b.pct - a.pct);
  return {
    top10, top5Pct: sum(sorted.slice(0, 5)), top10Pct: sum(top10),
    largestPct: sorted.length ? sorted[0].pct : null, numSecurities: holdings.length,
    topSector: sectors[0] ? sectors[0].sector : null, sectors, month, source: HOLDINGS_SOURCE,
  };
}

/** Match a disclosed scheme name to one of our funds (by normalised name). */
export function matchFund(schemeName, funds) {
  const key = norm(schemeName);
  if (!key) return null;
  let best = null;
  for (const f of funds) {
    const fk = norm(f.name);
    if (fk === key) return f;
    if (!best && (fk.includes(key) || key.includes(fk))) best = f;
  }
  return best;
}

/** Extract an AMC → monthly-portfolio-disclosure-page registry from the AMFI aum-data HTML. */
export function buildAmcRegistry(amfiHtml) {
  const reg = {};
  for (const m of amfiHtml.matchAll(/"([^"]*amc[^"]*name[^"]*)"\s*:\s*"([^"]+)"[\s\S]{0,400}?"amc_monthly_portfolio_disclosure"\s*:\s*"([^"]+)"/gi)) {
    const url = m[3].replace(/\\\//g, '/').trim();
    if (url && /^https?:/i.test(url)) reg[m[2].trim()] = url;
  }
  // Fallback: just collect the disclosure URLs if AMC-name pairing failed.
  if (Object.keys(reg).length === 0) {
    const urls = [...amfiHtml.matchAll(/"amc_monthly_portfolio_disclosure"\s*:\s*"([^"]+)"/gi)].map((m) => m[1].replace(/\\\//g, '/')).filter((u) => /^https?:/i.test(u));
    [...new Set(urls)].forEach((u, i) => (reg[`amc_${i + 1}`] = u));
  }
  return reg;
}
