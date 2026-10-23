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
  manager: { label: 'Manager', color: '#f59e0b', desc: 'Lead-manager tenure — longer is steadier. Left unscored (not penalised) when the disclosed date is only a SEBI re-notification and tenure can\'t be reliably dated.' },
};
export const PILLAR_KEYS = Object.keys(PILLAR_META);

let weights = { ...DEFAULT_WEIGHTS };
export const getWeights = () => weights;
export const setWeights = (w) => { weights = { ...w }; };
export const resetWeights = () => { weights = { ...DEFAULT_WEIGHTS }; };

/**
 * Weighted average of the available pillar scores (weights re-normalised over available pillars).
 * Evidence floor (FIX 5): needs >= 3 scored pillars OR pillars covering >= 50% of total weight,
 * else returns null ("partial") so a thinly-evidenced fund isn't ranked against a full one.
 */
export function composite(pillars, w = weights) {
  if (!pillars) return null;
  let wsum = 0, acc = 0, nScored = 0;
  for (const k of PILLAR_KEYS) {
    const p = pillars[k];
    if (p && p.score != null && isFinite(p.score) && (w[k] || 0) > 0) { acc += p.score * w[k]; wsum += w[k]; nScored++; }
  }
  const totalW = PILLAR_KEYS.reduce((s, k) => s + (w[k] || 0), 0);
  if (wsum <= 0 || !(nScored >= 3 || wsum >= totalW * 0.5)) return null;
  return acc / wsum;
}

export const scoreOf = (f) => (f && f.score ? composite(f.score.pillars) : null);
/** How many pillars carry a usable score (for honest "k/5 pillars" copy). */
export const scoredPillars = (f) => (f && f.score && f.score.pillars
  ? PILLAR_KEYS.filter((k) => { const p = f.score.pillars[k]; return p && p.score != null && isFinite(p.score); }).length : 0);

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
  if (key === 'manager') {
    const i = (pillar && pillar.inputs) || {};
    if (!pillar || pillar.score == null) {
      return i.primaryManager
        ? `${i.primaryManager} — the lead manager's tenure can't be reliably dated (the disclosed date is a SEBI re-notification), so manager stability isn't scored.`
        : 'Manager details not disclosed — manager stability isn\'t scored.';
    }
    return `${i.primaryManager || 'Lead manager'} — ${i.tenureYears != null ? i.tenureYears + ' yrs tenure' : 'tenure N/A'} (longer is steadier).`;
  }
  if (!pillar || pillar.score == null) return 'Not enough data to score this pillar for this fund.';
  return `Ranks better than ${Math.round(pillar.score)}% of funds in its peer group.`;
}
