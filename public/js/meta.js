// meta.js — shared constants, formatters, heat-map colour grading, column definitions,
// the plain-English metric glossary and inline SVG icons.

import { scoreOf } from './score.js';

// ---- palette (matches the Phase-1 design tokens) ---------------------------
export const C = {
  indigo: '#6366f1', indigoDeep: '#4f46e5', purple: '#a855f7', pink: '#f472b6',
  sky: '#38bdf8', emerald: '#10b981', amber: '#f59e0b', rose: '#f43f5e', slate: '#64748b',
};

// A distinct colour per peer group (diversified + thematic). Falls back to slate.
export const GROUP_COLOR = {
  'Flexi Cap': '#6366f1', 'Large Cap': '#0ea5e9', 'Large & Mid Cap': '#06b6d4',
  'Mid Cap': '#8b5cf6', 'Small Cap': '#d946ef', 'Multi Cap': '#3b82f6',
  'ELSS': '#10b981', 'Focused': '#f59e0b', 'Value/Contra': '#f43f5e',
  'Dividend Yield': '#14b8a6',
  'Thematic: Banking & Financial': '#2563eb', 'Thematic: Technology': '#7c3aed',
  'Thematic: Pharma & Healthcare': '#059669', 'Thematic: Energy & Power': '#ea580c',
  'Thematic: Infrastructure': '#ca8a04', 'Thematic: Consumption': '#db2777',
  'Thematic: Auto': '#0891b2', 'Thematic: Metals & Commodities': '#9333ea',
  'Thematic: Manufacturing': '#4f46e5', 'Thematic: International': '#0d9488',
  'Thematic: Realty': '#e11d48', 'Thematic: MNC': '#7c3aed', 'Thematic: ESG': '#16a34a',
  'Thematic: Other': '#64748b',
  // passive index peer groups
  'Index: Large Cap': '#0284c7', 'Index: Broad Market': '#4338ca', 'Index: Mid & Small Cap': '#9333ea',
  'Index: Sectoral': '#0d9488', 'Index: Factor / Smart-Beta': '#c026d3', 'Index: International': '#0891b2',
  'Index: Other': '#64748b',
};
export const groupColor = (g) => GROUP_COLOR[g] || C.slate;
export const isThematic = (g) => typeof g === 'string' && g.startsWith('Thematic:');
export const isIndex = (g) => typeof g === 'string' && g.startsWith('Index:');

/** Order peer groups in clusters: diversified active, then "Thematic: *", then "Index: *" — each alphabetical. */
export function orderGroups(groups) {
  const rank = (g) => (isIndex(g) ? 2 : isThematic(g) ? 1 : 0);
  return [...groups].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ---- formatters ------------------------------------------------------------
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const pct = (v, dp = 1) => (v == null || !isFinite(v) ? null : (v * 100).toFixed(dp) + '%');
export const pctSigned = (v, dp = 1) => (v == null || !isFinite(v) ? null : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%');
export const num = (v, dp = 2) => (v == null || !isFinite(v) ? null : v.toFixed(dp));
export const ageFmt = (v) => (v == null || !isFinite(v) ? null : v.toFixed(1) + 'y');
// TER arrives already in percent (0.69 = 0.69%), so it is NOT multiplied by 100.
export const terFmt = (v) => (v == null || !isFinite(v) ? null : v.toFixed(2) + '%');
// Percentage-point gap (decimal in, e.g. 0.023 -> "+2.3pp").
export const ppFmt = (v) => (v == null || !isFinite(v) ? null : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + 'pp');
// AUM in ₹ crore -> compact Indian form (₹1.49L cr / ₹820cr).
export const aumFmt = (v) => {
  if (v == null || !isFinite(v)) return null;
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(2) + 'L cr';
  if (v >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'k cr';
  return '₹' + Math.round(v) + 'cr';
};

export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${mo[m - 1]} ${y}`;
}

/** "5Y vs category" cell text: "1.08× +0.9pp" (or "N/A"). */
export function vsFmt(vs) {
  if (!vs) return null;
  const pp = vs.ppGap == null ? null : `${vs.ppGap >= 0 ? '+' : ''}${(vs.ppGap * 100).toFixed(1)}pp`;
  if (vs.ratio == null) return pp; // × ratio N/A (negative return, or peer group too small) → show the pp gap alone
  return `${vs.ratio.toFixed(2)}×${pp ? ' ' + pp : ''}`;
}

// ---- heat-map grading ------------------------------------------------------
// t in [0,1]: 0 = worst (rose) → 0.5 (amber) → 1 = best (emerald). Returns a soft
// background tint + a readable text colour so numeric cells "speak" visually.
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
export function heat(t) {
  if (t == null || !isFinite(t)) return { bg: 'transparent', fg: '#94a3b8' };
  t = Math.max(0, Math.min(1, t));
  const stops = [[244, 63, 94], [245, 158, 11], [16, 185, 129]];
  const seg = t < 0.5 ? 0 : 1, lt = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const r = lerp(stops[seg][0], stops[seg + 1][0], lt);
  const g = lerp(stops[seg][1], stops[seg + 1][1], lt);
  const b = lerp(stops[seg][2], stops[seg + 1][2], lt);
  return { bg: `rgba(${r},${g},${b},0.16)`, fg: `rgb(${lerp(r, 30, 0.55)},${lerp(g, 30, 0.55)},${lerp(b, 30, 0.55)})` };
}

// ---- column definitions ----------------------------------------------------
// get(f, cats) -> raw value (object for vs columns); sortVal/gradeVal override for those.
// grade: 'high' (higher=better) | 'low' (lower=better) | 'vs' (ratio, 1.0 = neutral) | null.
// group: 'core' columns are on by default; 'extra' columns come from the column customiser.
const G = {
  y5cagr: '5Y CAGR = the average yearly growth over the last 5 years, compounded.',
  y10cagr: '10Y CAGR = the average yearly growth over the last 10 years, compounded.',
  roll3: '3Y Rolling = the average 3-year return measured from many start dates — shows consistency, not one lucky run.',
  vs: 'vs Category = this fund ÷ the average fund in its peer group. Above 1.00× means it beat its peers.',
  sharpe: 'Sharpe = return earned for the risk taken. Higher is better; above 1 is strong.',
  vol: 'Volatility = how much the value swings. Lower is a calmer ride.',
  catvol: 'Category Volatility = the average swing of funds in this peer group, for comparison.',
  maxdd: 'Max Drawdown = the worst fall from a previous high. Closer to 0% is better.',
  soonAum: 'Fund size (assets under management). Coming in Phase 3.',
  soonBench: 'Return above the fund’s benchmark index. Coming in Phase 3.',
  soonTer: 'The yearly fee the fund charges. Coming in Phase 3.',
};

export const COLUMNS = [
  { key: 'name', label: 'Fund', tip: 'Fund name — click a row for details.', align: 'left', group: 'core', w: 248, get: (f) => f.name, fmt: (v) => v },
  { key: 'score', label: 'Score', tip: 'Composite score 0–100 — the fund’s percentile vs its peer group across performance, consistency, risk, cost and manager. Re-weightable in Fund Details. Research only, not advice.', align: 'right', group: 'core', w: 68, get: (f) => scoreOf(f), fmt: (v) => (v == null ? null : Math.round(v).toString()), grade: 'high', naReason: () => 'not enough data' },
  { key: 'group', label: 'Category', tip: 'Peer group used for every “vs category” comparison.', align: 'left', group: 'core', w: 186, get: (f) => f.peerGroup, fmt: (v) => v },
  { key: 'catRaw', label: 'AMFI Category', tip: 'The raw SEBI/AMFI category.', align: 'left', group: 'extra', w: 150, get: (f) => f.category, fmt: (v) => v },
  { key: 'aum', label: 'AUM', tip: 'Fund size — assets under management across all plans. Source: AMFI, via tigzig.', align: 'right', group: 'core', w: 96, get: (f) => (f.aum ? f.aum.cr : null), fmt: aumFmt, grade: null, naReason: (f) => (f.aum ? '' : 'not disclosed') },
  { key: 'm1', label: '1M', tip: '1-month return (absolute).', align: 'right', group: 'extra', w: 80, get: (f) => f.returns.m1, fmt: pct, grade: 'high' },
  { key: 'm3', label: '3M', tip: '3-month return (absolute).', align: 'right', group: 'extra', w: 80, get: (f) => f.returns.m3, fmt: pct, grade: 'high' },
  { key: 'm6', label: '6M', tip: '6-month return (absolute).', align: 'right', group: 'extra', w: 80, get: (f) => f.returns.m6, fmt: pct, grade: 'high' },
  { key: 'y1', label: '1Y', tip: '1-year return (absolute).', align: 'right', group: 'extra', w: 80, get: (f) => f.returns.y1, fmt: pct, grade: 'high' },
  { key: 'y3', label: '3Y CAGR', tip: '3-year return, annualised (CAGR).', align: 'right', group: 'core', w: 84, get: (f) => f.returns.y3, fmt: pct, grade: 'high' },
  { key: 'y5', label: '5Y CAGR', tip: G.y5cagr, align: 'right', group: 'core', w: 84, get: (f) => f.returns.y5, fmt: pct, grade: 'high' },
  { key: 'y10', label: '10Y CAGR', tip: G.y10cagr, align: 'right', group: 'core', w: 88, get: (f) => f.returns.y10, fmt: pct, grade: 'high' },
  { key: 'si', label: 'Since Incep.', tip: 'Annualised return since the fund launched.', align: 'right', group: 'extra', w: 96, get: (f) => f.returns.si, fmt: pct, grade: 'high' },
  { key: 'roll3y', label: '3Y Rolling', tip: G.roll3, align: 'right', group: 'core', w: 92, get: (f) => (f.rolling.y3 ? f.rolling.y3.avg : null), fmt: pct, grade: 'high' },
  { key: 'roll5y', label: '5Y Rolling', tip: 'Average 5-year return across many start dates.', align: 'right', group: 'extra', w: 92, get: (f) => (f.rolling.y5 ? f.rolling.y5.avg : null), fmt: pct, grade: 'high' },
  { key: 'pctPos', label: '% Positive', tip: 'Share of 3-year windows that ended in a gain. 100% = never lost over 3 years.', align: 'right', group: 'extra', w: 96, get: (f) => (f.rolling.y3 ? f.rolling.y3.pctPositive : null), fmt: pct, grade: 'high' },
  { key: 'vs5y', label: '5Y vs Category', tip: G.vs, align: 'right', group: 'core', w: 128, get: (f) => f.vsCategory.y5, fmt: vsFmt, grade: 'vs', gradeVal: (f) => (f.vsCategory.y5 ? f.vsCategory.y5.ratio : null), sortVal: (f) => (f.vsCategory.y5 ? f.vsCategory.y5.ratio : null), naReason: (f) => (f.vsCategory.y5 && f.vsCategory.y5.reason) || 'no 5Y comparison' },
  { key: 'vs10y', label: '10Y vs Category', tip: G.vs, align: 'right', group: 'core', w: 132, get: (f) => f.vsCategory.y10, fmt: vsFmt, grade: 'vs', gradeVal: (f) => (f.vsCategory.y10 ? f.vsCategory.y10.ratio : null), sortVal: (f) => (f.vsCategory.y10 ? f.vsCategory.y10.ratio : null), naReason: (f) => (f.vsCategory.y10 && f.vsCategory.y10.reason) || 'no 10Y comparison' },
  { key: 'benchExcess', label: 'Benchmark Excess', tip: '5-year return minus the fund’s benchmark (Total Return Index) over the same period. Positive = beat the index. Source: NSE Indices TRI.', align: 'right', group: 'core', w: 128, get: (f) => (f.benchmark && f.benchmark.excess ? f.benchmark.excess.y5 : null), fmt: ppFmt, grade: 'high', naReason: (f) => (f.benchmark && f.benchmark.reason) || 'no 5Y benchmark' },
  { key: 'sharpe', label: 'Sharpe', tip: G.sharpe, align: 'right', group: 'core', w: 80, get: (f) => f.risk.sharpe, fmt: (v) => num(v, 2), grade: 'high' },
  { key: 'sortino', label: 'Sortino', tip: 'Like Sharpe but only penalises downside swings. Higher is better.', align: 'right', group: 'extra', w: 80, get: (f) => f.risk.sortino, fmt: (v) => num(v, 2), grade: 'high' },
  { key: 'vol', label: 'Volatility', tip: G.vol, align: 'right', group: 'core', w: 104, get: (f) => f.risk.volatility, fmt: pct, grade: 'low' },
  { key: 'catVol', label: 'Category Volatility', tip: G.catvol, align: 'right', group: 'core', w: 128, get: (f, cats) => (cats && cats[f.peerGroup] ? cats[f.peerGroup].mean.volatility : null), fmt: pct, grade: null },
  { key: 'maxdd', label: 'Max Drawdown', tip: G.maxdd, align: 'right', group: 'core', w: 112, get: (f) => f.risk.maxDrawdown, fmt: pct, grade: 'high' },
  { key: 'age', label: 'Age', tip: 'Years since the fund launched.', align: 'right', group: 'extra', w: 68, get: (f) => f.ageYears, fmt: ageFmt, grade: null },
  { key: 'ter', label: 'TER', tip: 'Direct-plan expense ratio — the yearly fee, already reflected in returns. Lower is cheaper. Source: SEBI/AMFI, via tigzig.', align: 'right', group: 'core', w: 76, get: (f) => (f.costs ? f.costs.terDirect : null), fmt: terFmt, grade: 'low', naReason: () => 'not disclosed' },
  // --- extra enriched columns (column customiser) ---
  { key: 'benchExcess3y', label: '3Y vs Benchmark', tip: '3-year return minus benchmark TRI.', align: 'right', group: 'extra', w: 128, get: (f) => (f.benchmark && f.benchmark.excess ? f.benchmark.excess.y3 : null), fmt: ppFmt, grade: 'high' },
  { key: 'benchName', label: 'Benchmark', tip: 'The Total Return Index this fund is compared against.', align: 'left', group: 'extra', w: 180, get: (f) => (f.benchmark ? f.benchmark.indexName : null), fmt: (v) => v || '—', grade: null },
  { key: 'terReg', label: 'TER (Regular)', tip: 'Regular-plan expense ratio.', align: 'right', group: 'extra', w: 104, get: (f) => (f.costs ? f.costs.terRegular : null), fmt: terFmt, grade: 'low' },
  { key: 'riskometer', label: 'Riskometer', tip: 'SEBI riskometer rating.', align: 'left', group: 'extra', w: 132, get: (f) => f.riskometer, fmt: (v) => v || '—', grade: null },
  { key: 'manager', label: 'Manager(s)', tip: 'Lead fund manager(s).', align: 'left', group: 'extra', w: 190, get: (f) => (f.manager ? f.manager.names.slice(0, 2).map((n) => n.name).join(', ') : null), fmt: (v) => v || '—', grade: null },
];
export const COL_BY_KEY = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
export const DEFAULT_COLS = COLUMNS.filter((c) => c.group === 'core').map((c) => c.key);

// ---- inline SVG icons (stroke=currentColor) --------------------------------
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5">${p}</svg>`;
export const ICON = {
  funds: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>'),
  filter: svg('<path d="M3 5h18l-7 8v6l-4-2v-4z"/>'),
  trophy: svg('<path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0zM7 4H4v2a3 3 0 0 0 3 3M17 4h3v2a3 3 0 0 1-3 3"/>'),
  scale: svg('<path d="M12 3v18M5 7h14M5 7l-2 6a3 3 0 0 0 6 0zM19 7l-2 6a3 3 0 0 0 6 0z"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  chart: svg('<path d="M4 20V4M4 20h16M8 16v-5M13 16V8M18 16v-9"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 4v16"/>'),
  star: svg('<path d="m12 3 2.6 5.3 5.9.9-4.2 4.1 1 5.9L12 17l-5.3 2.8 1-5.9L3.5 9.8l5.9-.9z"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  funnel: svg('<path d="M3 4h18l-7 8v7l-4-2v-5z"/>'),
  download: svg('<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  compare: svg('<path d="M4 7h7M4 12h7M4 17h7M17 4v16M14 7l3-3 3 3M20 17l-3 3-3-3"/>'),
};
