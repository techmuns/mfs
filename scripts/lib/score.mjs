// score.mjs — the explainable composite score. Each pillar is scored as the fund's PERCENTILE
// WITHIN ITS PEER GROUP ("better than X% of peers"), except Manager (absolute tenure mapping).
// Pillar percentiles are stable data computed here in CI; the browser recombines them live with
// user-adjustable weights (so re-weighting never needs the peer distribution). A pillar with no
// usable inputs is null (N/A) and excluded from the composite — never fabricated.

export const DEFAULT_WEIGHTS = { performance: 30, consistency: 25, risk: 25, cost: 10, manager: 10 };

// Percentile rank of v within values (higher v -> higher score). null if no data.
function pctHigh(v, values) {
  if (v == null || !isFinite(v) || !values.length) return null;
  let below = 0, eq = 0;
  for (const x of values) { if (x < v) below++; else if (x === v) eq++; }
  return (below + 0.5 * eq) / values.length * 100;
}
const pctLow = (v, values) => { const p = pctHigh(v, values); return p == null ? null : 100 - p; }; // lower v -> higher score
const collect = (members, get) => members.map(get).filter((x) => x != null && isFinite(x));
const avg = (arr) => { const a = arr.filter((x) => x != null && isFinite(x)); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };

function primaryManager(f) {
  if (!f.manager || !f.manager.names || !f.manager.names.length) return null;
  return [...f.manager.names].sort((a, b) => (b.tenureYears || 0) - (a.tenureYears || 0))[0];
}

// Manager pillar: absolute map of the primary manager's tenure (>=7y -> 100 down to <1y -> 20),
// with a penalty when the fund's multi-year record largely predates that manager.
function managerScore(f) {
  const pm = primaryManager(f);
  if (!pm || pm.tenureYears == null) return { score: null, inputs: { primaryManager: pm ? pm.name : null, tenureYears: pm ? pm.tenureYears : null, predatesRecord: null } };
  let s = Math.max(20, Math.min(100, (pm.tenureYears / 7) * 100));
  const predates = !!(f.history && f.history.has5y && pm.tenureYears < 3);
  if (predates) s *= 0.6;
  return { score: s, inputs: { primaryManager: pm.name, tenureYears: pm.tenureYears, predatesRecord: predates } };
}

export function compositeFromPillars(pillars, weights = DEFAULT_WEIGHTS) {
  let wsum = 0, acc = 0;
  for (const [k, w] of Object.entries(weights)) {
    const p = pillars[k];
    if (p && p.score != null && isFinite(p.score)) { acc += p.score * w; wsum += w; }
  }
  return wsum > 0 ? acc / wsum : null;
}

function scoreFund(f, V) {
  const spread = f.rolling.y3 ? f.rolling.y3.max - f.rolling.y3.min : null;
  const pillars = {
    performance: {
      score: avg([pctHigh(f.returns.y5, V.y5), pctHigh(f.returns.y10, V.y10), pctHigh(f.benchmark && f.benchmark.excess ? f.benchmark.excess.y5 : null, V.excess5y)]),
      inputs: { y5: f.returns.y5, y10: f.returns.y10, excess5y: f.benchmark && f.benchmark.excess ? f.benchmark.excess.y5 : null },
    },
    consistency: {
      score: avg([pctHigh(f.rolling.y3 ? f.rolling.y3.pctPositive : null, V.pctPos), pctHigh(f.rolling.y3 ? f.rolling.y3.min : null, V.min3y), pctLow(spread, V.spread)]),
      inputs: { pctPositive3y: f.rolling.y3 ? f.rolling.y3.pctPositive : null, min3y: f.rolling.y3 ? f.rolling.y3.min : null, spread3y: spread },
    },
    risk: {
      score: avg([pctHigh(f.risk.sharpe, V.sharpe), pctLow(f.risk.volatility, V.vol), pctHigh(f.risk.maxDrawdown, V.maxdd)]),
      inputs: { sharpe: f.risk.sharpe, volatility: f.risk.volatility, maxDrawdown: f.risk.maxDrawdown },
    },
    cost: {
      score: pctLow(f.costs ? f.costs.terDirect : null, V.ter),
      inputs: { terDirect: f.costs ? f.costs.terDirect : null },
    },
    manager: managerScore(f),
  };
  return { n: V.y5.length, pillars, composite: compositeFromPillars(pillars) };
}

/** Attach `score` to every fund (percentiles within each peer group). Mutates `funds`. */
export function computeScores(funds) {
  const groups = new Map();
  for (const f of funds) { if (!groups.has(f.peerGroup)) groups.set(f.peerGroup, []); groups.get(f.peerGroup).push(f); }
  for (const [, members] of groups) {
    const V = {
      y5: collect(members, (f) => f.returns.y5),
      y10: collect(members, (f) => f.returns.y10),
      excess5y: collect(members, (f) => (f.benchmark && f.benchmark.excess ? f.benchmark.excess.y5 : null)),
      pctPos: collect(members, (f) => (f.rolling.y3 ? f.rolling.y3.pctPositive : null)),
      min3y: collect(members, (f) => (f.rolling.y3 ? f.rolling.y3.min : null)),
      spread: collect(members, (f) => (f.rolling.y3 ? f.rolling.y3.max - f.rolling.y3.min : null)),
      sharpe: collect(members, (f) => f.risk.sharpe),
      vol: collect(members, (f) => f.risk.volatility),
      maxdd: collect(members, (f) => f.risk.maxDrawdown),
      ter: collect(members, (f) => (f.costs ? f.costs.terDirect : null)),
    };
    for (const f of members) f.score = scoreFund(f, V);
  }
}
