// state.js — app state, the filter + elimination-funnel logic, and localStorage
// persistence (shortlist + saved presets). Pure data; no DOM.

import { COL_BY_KEY, DEFAULT_COLS } from './meta.js';
import { scoreOf } from './score.js';

const LS = {
  shortlist: 'mfs.shortlist.v1',
  presets: 'mfs.presets.v1',
};
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode / quota */ }
}

export const DEFAULT_FILTERS = () => ({
  peerGroup: '', search: '',
  min5y: null, min10y: null, minSharpe: null, maxVol: null,
  beats5y: false, beats10y: false, has5y: false, has10y: false,
  ageMin: null, ageMax: null,
});

// The elimination funnel: an ordered list of independent rules, each toggleable, some
// carrying a slider value. Applied in this order to the filter-bar-filtered base.
export const DEFAULT_FUNNEL = () => ({
  has5y: { enabled: false },
  beats5y: { enabled: false },
  beats10y: { enabled: false },
  rollPos: { enabled: false },
  sharpe: { enabled: false, min: 0.5 },
  volCat: { enabled: false },
  maxdd: { enabled: false, min: -0.25 },
  minScore: { enabled: false, min: 60 },
});

export const FUNNEL_RULES = [
  { key: 'has5y', label: 'Has ≥ 5Y history', test: (f) => f.history.has5y },
  { key: 'beats5y', label: '5Y beats category', test: (f) => f.vsCategory.y5 && f.vsCategory.y5.ratio != null && f.vsCategory.y5.ratio >= 1 },
  { key: 'beats10y', label: '10Y beats category', test: (f) => f.vsCategory.y10 && f.vsCategory.y10.ratio != null && f.vsCategory.y10.ratio >= 1 },
  { key: 'rollPos', label: '3Y rolling always positive', test: (f) => f.rolling.y3 && f.rolling.y3.pctPositive === 1 },
  { key: 'sharpe', label: (fn) => `Sharpe ≥ ${fn.sharpe.min.toFixed(1)}`, test: (f, fn) => f.risk.sharpe != null && f.risk.sharpe >= fn.sharpe.min },
  { key: 'volCat', label: 'Volatility ≤ category avg', test: (f, fn, cats) => f.risk.volatility != null && cats[f.peerGroup] && cats[f.peerGroup].mean.volatility != null && f.risk.volatility <= cats[f.peerGroup].mean.volatility },
  { key: 'maxdd', label: (fn) => `Max drawdown ≥ ${(fn.maxdd.min * 100).toFixed(0)}%`, test: (f, fn) => f.risk.maxDrawdown != null && f.risk.maxDrawdown >= fn.maxdd.min },
  { key: 'minScore', label: (fn) => `Composite score ≥ ${fn.minScore.min}`, test: (f, fn) => { const s = scoreOf(f); return s != null && s >= fn.minScore.min; } },
];

export const state = {
  funds: [], categories: {}, status: null, benchmarks: {}, alerts: { events: [] },
  filters: DEFAULT_FILTERS(),
  funnel: DEFAULT_FUNNEL(),
  sort: { key: 'y5', dir: 'desc' },
  cols: [...DEFAULT_COLS],
  shortlist: new Set(lsGet(LS.shortlist, [])),
  compareFunds: [],
  presets: lsGet(LS.presets, []),
  activeTab: 'screener',
  listeners: new Set(),
};

export function subscribe(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }
export function emit() { for (const fn of state.listeners) fn(); }

// ---- filter bar ------------------------------------------------------------
export function passesFilters(f, flt, cats) {
  if (flt.peerGroup && f.peerGroup !== flt.peerGroup) return false;
  if (flt.search) {
    const q = flt.search.toLowerCase();
    if (!f.name.toLowerCase().includes(q) && !(f.amc || '').toLowerCase().includes(q)) return false;
  }
  if (flt.min5y != null && !(f.returns.y5 != null && f.returns.y5 >= flt.min5y)) return false;
  if (flt.min10y != null && !(f.returns.y10 != null && f.returns.y10 >= flt.min10y)) return false;
  if (flt.minSharpe != null && !(f.risk.sharpe != null && f.risk.sharpe >= flt.minSharpe)) return false;
  if (flt.maxVol != null && !(f.risk.volatility != null && f.risk.volatility <= flt.maxVol)) return false;
  if (flt.beats5y && !(f.vsCategory.y5 && f.vsCategory.y5.ratio >= 1)) return false;
  if (flt.beats10y && !(f.vsCategory.y10 && f.vsCategory.y10.ratio >= 1)) return false;
  if (flt.has5y && !f.history.has5y) return false;
  if (flt.has10y && !f.history.has10y) return false;
  if (flt.ageMin != null && !(f.ageYears >= flt.ageMin)) return false;
  if (flt.ageMax != null && !(f.ageYears <= flt.ageMax)) return false;
  return true;
}

export function filteredBase() {
  return state.funds.filter((f) => passesFilters(f, state.filters, state.categories));
}

/** Scope = funds in the selected peer group only (ignores the other filters). */
export function scopeCount() {
  const pg = state.filters.peerGroup;
  return pg ? state.funds.filter((f) => f.peerGroup === pg).length : state.funds.length;
}

// ---- elimination funnel ----------------------------------------------------
// Applies the enabled funnel rules in order to `base`, returning the step-by-step survivor
// counts and the final survivor set. Disabled rules are shown greyed with their would-be count.
export function runFunnel(base) {
  const fn = state.funnel, cats = state.categories;
  const steps = [];
  let current = base;
  for (const rule of FUNNEL_RULES) {
    const enabled = fn[rule.key].enabled;
    const label = typeof rule.label === 'function' ? rule.label(fn) : rule.label;
    if (enabled) {
      current = current.filter((f) => rule.test(f, fn, cats));
      steps.push({ key: rule.key, label, enabled: true, count: current.length });
    } else {
      // Preview count if this rule alone were applied to the current survivors.
      const preview = current.filter((f) => rule.test(f, fn, cats)).length;
      steps.push({ key: rule.key, label, enabled: false, count: preview });
    }
  }
  return { steps, survivors: current };
}

/** The final visible set = funnel survivors on top of the filter-bar base. */
export function visibleFunds() {
  return runFunnel(filteredBase()).survivors;
}

// ---- shortlist -------------------------------------------------------------
export function inShortlist(code) { return state.shortlist.has(code); }
export function toggleShortlist(code) {
  if (state.shortlist.has(code)) state.shortlist.delete(code); else state.shortlist.add(code);
  lsSet(LS.shortlist, [...state.shortlist]);
}
export function addManyToShortlist(codes) {
  for (const c of codes) state.shortlist.add(c);
  lsSet(LS.shortlist, [...state.shortlist]);
}
export function removeShortlist(code) { state.shortlist.delete(code); lsSet(LS.shortlist, [...state.shortlist]); }
export function clearShortlist() { state.shortlist.clear(); lsSet(LS.shortlist, []); }

// ---- presets ---------------------------------------------------------------
export function savePreset(name) {
  const preset = { name, filters: structuredClone(state.filters), funnel: structuredClone(state.funnel) };
  state.presets = [...state.presets.filter((p) => p.name !== name), preset];
  lsSet(LS.presets, state.presets);
}
export function loadPreset(name) {
  const p = state.presets.find((x) => x.name === name);
  if (!p) return;
  state.filters = { ...DEFAULT_FILTERS(), ...p.filters };
  state.funnel = { ...DEFAULT_FUNNEL(), ...structuredClone(p.funnel) };
}
export function deletePreset(name) {
  state.presets = state.presets.filter((p) => p.name !== name);
  lsSet(LS.presets, state.presets);
}

export function resetFilters() { state.filters = DEFAULT_FILTERS(); state.funnel = DEFAULT_FUNNEL(); }

/** List of active filter chips for the UI: [{key, label}]. */
export function activeChips() {
  const f = state.filters, chips = [];
  if (f.peerGroup) chips.push({ key: 'peerGroup', label: f.peerGroup });
  if (f.search) chips.push({ key: 'search', label: `“${f.search}”` });
  if (f.min5y != null) chips.push({ key: 'min5y', label: `5Y ≥ ${(f.min5y * 100).toFixed(0)}%` });
  if (f.min10y != null) chips.push({ key: 'min10y', label: `10Y ≥ ${(f.min10y * 100).toFixed(0)}%` });
  if (f.minSharpe != null) chips.push({ key: 'minSharpe', label: `Sharpe ≥ ${f.minSharpe.toFixed(1)}` });
  if (f.maxVol != null) chips.push({ key: 'maxVol', label: `Vol ≤ ${(f.maxVol * 100).toFixed(0)}%` });
  if (f.beats5y) chips.push({ key: 'beats5y', label: '5Y beats category' });
  if (f.beats10y) chips.push({ key: 'beats10y', label: '10Y beats category' });
  if (f.has5y) chips.push({ key: 'has5y', label: 'Has 5Y history' });
  if (f.has10y) chips.push({ key: 'has10y', label: 'Has 10Y history' });
  if (f.ageMin != null) chips.push({ key: 'ageMin', label: `Age ≥ ${f.ageMin}y` });
  if (f.ageMax != null) chips.push({ key: 'ageMax', label: `Age ≤ ${f.ageMax}y` });
  return chips;
}
export function clearChip(key) {
  const f = state.filters;
  if (key in f) f[key] = (typeof f[key] === 'boolean') ? false : (key === 'peerGroup' || key === 'search') ? '' : null;
}

// ---- column customiser ------------------------------------------------------
export function toggleColumn(key) {
  if (!COL_BY_KEY[key]) return;
  if (state.cols.includes(key)) state.cols = state.cols.filter((k) => k !== key);
  else {
    // Insert in the canonical COLUMNS order so the table stays tidy.
    const order = Object.keys(COL_BY_KEY);
    state.cols = order.filter((k) => state.cols.includes(k) || k === key);
  }
}
