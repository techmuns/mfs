// amfi.mjs — fetch + parse the official AMFI NAVAll universe.
//
// AMFI publishes the full classified scheme list as a semicolon-delimited text file.
// It is NOT CORS-enabled, so it is only ever fetched server-side (in CI), never by the
// browser. The file is organised in sections:
//
//     Open Ended Schemes(Equity Scheme - Flexi Cap Fund)   <- section header: "<type>(<category>)"
//                                                          <- blank line
//     PPFAS Mutual Fund                                    <- AMC name
//                                                          <- blank line
//     122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;90.3546;19-Oct-2026
//     ...more scheme rows...
//     Axis Mutual Fund                                     <- next AMC, same category
//     ...
//     Open Ended Schemes(Equity Schemes - Large Cap Fund)  <- next category section
//
// So the parser walks line-by-line, tracking the "current" scheme type, category and AMC,
// and tags every data row with them.
//
// Two real-world quirks this parser handles:
//  1. AMFI uses BOTH "Equity Scheme - X" (singular) and "Equity Schemes - X" (plural)
//     headers in the same file, with slightly different sub-category names
//     (e.g. "Sectoral/ Thematic" vs separate "Sectoral Fund" / "Thematic Fund").
//     normalizeEquityCategory() folds these into canonical SEBI categories.
//  2. The column layout is read from the header row, so if AMFI adds/removes columns
//     (it recently added explicit Plan/Option columns) we still map fields correctly,
//     and fall back to name-based Direct/Growth detection when those columns are absent.

import { parseAmfiDate } from './dates.mjs';
import { fetchText } from './http.mjs';

export const AMFI_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';

export function fetchAmfiNavAll(opts) {
  return fetchText(AMFI_URL, opts);
}

const DIVIDEND_MARKERS = /idcw|dividend|payout|reinvest|bonus/;

// AMFI files passive INDEX funds under "Other Scheme - Index Funds" (not an Equity header), so
// they are picked up as a separate pass. We keep only EQUITY index funds — debt / target-maturity
// / commodity index trackers are excluded by name.
// gold/silver are commodities (excluded); "Nifty Commodities" is an EQUITY sector index (kept),
// so we do NOT exclude on "commodit" — only on the precious-metal names (FIX 7).
const INDEX_EXCLUDE = /target maturity|g-?sec|gilt|\bsdl\b|\bbond\b|liquid|overnight|1d rate|money market|t-?bill|duration|debt|psu.*debt|banking.*psu|aaa|credit|corporate bond|floater|bharat bond|gold|silver/i;

/** True for the "Other Scheme - Index Funds" section header (open-endedness is checked separately). */
function isIndexFundSection(rawCategory) {
  return /index\s*fund/i.test(rawCategory);
}

/**
 * Fold an AMFI equity sub-category label into a canonical SEBI category.
 * Returns null when the label is not a recognised equity category (so non-equity
 * sections are ignored). Order matters: "large & mid" is checked before "large"/"mid".
 */
export function normalizeEquityCategory(rawCategory) {
  // We only care about equity sections. Both "Equity Scheme - X" and "Equity Schemes - X".
  if (!/^equity schemes?\s*-/i.test(rawCategory)) return null;
  const r = rawCategory.toLowerCase();
  if (r.includes('flexi cap')) return 'Flexi Cap';
  if (r.includes('large & mid') || r.includes('large and mid')) return 'Large & Mid Cap';
  if (r.includes('large cap')) return 'Large Cap';
  if (r.includes('mid cap')) return 'Mid Cap';
  if (r.includes('small cap')) return 'Small Cap';
  if (r.includes('multi cap')) return 'Multi Cap';
  if (r.includes('elss')) return 'ELSS';
  if (r.includes('focused')) return 'Focused';
  if (r.includes('value') || r.includes('contra')) return 'Value/Contra';
  if (r.includes('dividend yield')) return 'Dividend Yield';
  if (r.includes('sectoral') || r.includes('thematic')) return 'Sectoral/Thematic';
  return null; // an equity header we don't recognise — skip rather than mis-bucket.
}

/** Build a header-name -> column-index map from the AMFI header row fields. */
function mapColumns(fields) {
  const idx = { schemeCode: 0, isinGrowth: 1, isinReinvest: 2, name: 3, plan: -1, option: -1, nav: -1, date: -1 };
  fields.forEach((raw, i) => {
    const h = raw.toLowerCase();
    if (h.includes('scheme code')) idx.schemeCode = i;
    else if (h.includes('isin') && (h.includes('payout') || h.includes('growth'))) idx.isinGrowth = i;
    else if (h.includes('isin') && h.includes('reinvest')) idx.isinReinvest = i;
    else if (h.includes('scheme name')) idx.name = i;
    else if (h === 'plan') idx.plan = i;
    else if (h === 'option') idx.option = i;
    else if (h.includes('net asset value')) idx.nav = i;
    else if (h === 'date') idx.date = i;
  });
  // If NAV/Date columns were not found by name (unexpected), assume they are the last two.
  if (idx.nav < 0) idx.nav = fields.length - 2;
  if (idx.date < 0) idx.date = fields.length - 1;
  return idx;
}

function classifyPlan(planRaw, name) {
  const p = (planRaw || '').toLowerCase();
  const n = (name || '').toLowerCase();
  let isDirect;
  if (p.includes('direct')) isDirect = true;
  else if (p.includes('regular')) isDirect = false;
  else isDirect = n.includes('direct'); // fallback: derive from the scheme name
  return { isDirect, plan: isDirect ? 'Direct' : 'Regular' };
}

function classifyOption(optionRaw, name) {
  const o = (optionRaw || '').toLowerCase();
  const n = (name || '').toLowerCase();
  let isGrowth;
  if (o) isGrowth = o.includes('growth') && !DIVIDEND_MARKERS.test(o);
  else isGrowth = !DIVIDEND_MARKERS.test(n); // name fallback: no dividend markers => Growth
  return { isGrowth, option: isGrowth ? 'Growth' : 'IDCW' };
}

function cleanIsin(s) {
  const v = (s || '').trim();
  return v && v !== '-' ? v : null;
}

/**
 * Parse the NAVAll text and return the universe:
 * OPEN-ENDED, DIRECT plan, GROWTH option — ACTIVE equity schemes (every equity sub-category) PLUS
 * passive EQUITY index funds (category "Index Fund", `isIndex:true`; debt/commodity index funds
 * excluded by name). Index funds are additive — they live in their own peer groups downstream.
 * Each entry: { schemeCode, name, amc, rawCategory, category, isIndex, plan, option, isin, amfiNav, amfiDate }.
 */
export function parseAmfiEquityUniverse(text) {
  const lines = text.split(/\r?\n/);
  let cols = mapColumns(['Scheme Code', 'ISIN', 'ISIN Reinvest', 'Scheme Name', 'Plan', 'Option', 'Net Asset Value', 'Date']);
  let schemeType = null;
  let rawCategory = null;
  let category = null;
  let amc = null;

  const funds = [];
  const seen = new Set(); // de-dupe by schemeCode (AMFI's dual conventions can list a fund twice)

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.includes(';')) {
      const f = raw.split(';').map((x) => x.trim());
      if (!/^\d+$/.test(f[cols.schemeCode] ?? '')) {
        // Not a numeric scheme code in the code column => this is the header row.
        cols = mapColumns(f);
        continue;
      }
      // Only rows inside an Open-Ended, recognised-equity section are in scope.
      if (!(schemeType && schemeType.startsWith('Open Ended'))) continue;
      if (!category) continue;

      const name = f[cols.name] || '';
      const { isDirect, plan } = classifyPlan(cols.plan >= 0 ? f[cols.plan] : '', name);
      const { isGrowth, option } = classifyOption(cols.option >= 0 ? f[cols.option] : '', name);
      if (!isDirect || !isGrowth) continue; // keep only Direct + Growth
      // Under "Index Funds", keep EQUITY index trackers only — drop debt / target-maturity / commodity.
      const isIndex = category === 'Index Fund';
      if (isIndex && INDEX_EXCLUDE.test(name)) continue;

      const schemeCode = Number(f[cols.schemeCode]);
      if (seen.has(schemeCode)) continue;
      seen.add(schemeCode);

      const navNum = Number(f[cols.nav]);
      funds.push({
        schemeCode,
        name,
        amc: amc || null,
        rawCategory,
        category,
        isIndex,
        plan,
        option,
        isin: cleanIsin(f[cols.isinGrowth]),
        amfiNav: Number.isFinite(navNum) && navNum > 0 ? navNum : null,
        amfiDate: parseAmfiDate(f[cols.date]),
      });
      continue;
    }

    // Non-data line: a section header "<type>(<category>)" or an AMC name.
    const headerMatch = line.match(/^(.*?)\((.+)\)\s*$/);
    if (headerMatch && /scheme/i.test(headerMatch[1])) {
      schemeType = headerMatch[1].trim();
      rawCategory = headerMatch[2].trim();
      category = normalizeEquityCategory(rawCategory);
      if (!category && isIndexFundSection(rawCategory)) category = 'Index Fund'; // passive index funds
      amc = null; // the AMC name appears on the next non-blank line
    } else {
      amc = line;
    }
  }

  return funds;
}
