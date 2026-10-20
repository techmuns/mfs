// score.js — recombine the committed per-pillar percentiles into a composite with LIVE,
// user-adjustable weights. Pillar percentiles are computed in CI (stable); only the weighting is
// interactive. A pillar with no usable inputs is excluded and the weights re-normalise — the
// score is never fabricated. Leaf module (no app imports) to avoid cycles.

export const DEFAULT_WEIGHTS = { performance: 30, consistency: 25, risk: 25, cost: 10, manager: 10 };

export const PILLAR_META = {
  performance: { label: 'Performance', color: '#6366f1', desc: '5Y & 10Y returns and excess over the benchmark, ranked against peers.' },
  consistency: { label: 'Consistency', color: '#a855f7', desc: 'How reliably 3-year returns stayed positive, and how narrow the range, vs peers.' },
  risk: { label: 'Risk', color: '#38bdf8', desc: 'Reward for risk (Sharpe), calmness (low volatility) and shallow worst fall, vs peers.' },
  cost: { label: 'Cost', color: '#10b981', desc: 'Expense ratio vs peers — cheaper ranks higher.' },
  manager: { label: 'Manager', color: '#f59e0b', desc: 'Lead-manager tenure (longer is steadier); penalised when the record predates them.' },
};
export const PILLAR_KEYS = Object.keys(PILLAR_META);

let weights = { ...DEFAULT_WEIGHTS };
export const getWeights = () => weights;
export const setWeights = (w) => { weights = { ...w }; };
export const resetWeights = () => { weights = { ...DEFAULT_WEIGHTS }; };

/** Weighted average of the available pillar scores (weights re-normalised over available pillars). */
export function composite(pillars, w = weights) {
  if (!pillars) return null;
  let wsum = 0, acc = 0;
  for (const k of PILLAR_KEYS) {
    const p = pillars[k];
    if (p && p.score != null && isFinite(p.score)) { acc += p.score * (w[k] || 0); wsum += (w[k] || 0); }
  }
  return wsum > 0 ? acc / wsum : null;
}

export const scoreOf = (f) => (f && f.score ? composite(f.score.pillars) : null);

/** 0–100 → a traffic-light-ish colour for bars/badges. */
export function scoreColor(v) {
  if (v == null) return '#cbd5e1';
  if (v >= 75) return '#10b981';
  if (v >= 60) return '#84cc16';
  if (v >= 45) return '#f59e0b';
  if (v >= 30) return '#fb923c';
  return '#f43f5e';
}

/** Plain-English explanation for one pillar. */
export function explainPillar(key, pillar) {
  if (!pillar || pillar.score == null) return 'Not enough data to score this pillar for this fund.';
  if (key === 'manager') {
    const i = pillar.inputs;
    return `${i.primaryManager || 'Lead manager'} — ${i.tenureYears != null ? i.tenureYears + ' yrs tenure' : 'tenure N/A'}${i.predatesRecord ? '. Much of the multi-year record predates them, so this pillar is penalised.' : '.'}`;
  }
  return `Ranks better than ${Math.round(pillar.score)}% of funds in its peer group.`;
}
