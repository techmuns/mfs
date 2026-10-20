// categories.mjs — category-level means/medians and each fund's "vs category" comparison.
//
// Policy (documented and surfaced in status.json): averages are taken over the
// Direct-Growth funds in the Phase-1 universe ONLY, so every distinct portfolio counts
// exactly once (no Direct/Regular double-counting). A fund contributes to a given metric
// only when it has enough history to have a non-null value for it, so the sample size `n`
// differs per metric and is reported per metric in `sampleSize`.

// Metrics aggregated per category.
export const CATEGORY_METRICS = ['y1', 'y3', 'y5', 'y10', 'volatility', 'sharpe', 'rolling3yAvg'];

function metricValue(f, metric) {
  switch (metric) {
    case 'y1': return f.returns.y1;
    case 'y3': return f.returns.y3;
    case 'y5': return f.returns.y5;
    case 'y10': return f.returns.y10;
    case 'volatility': return f.risk.volatility;
    case 'sharpe': return f.risk.sharpe;
    case 'rolling3yAvg': return f.rolling.y3 ? f.rolling.y3.avg : null;
    default: return null;
  }
}

function stats(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { mean: null, median: null, n: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const mid = n >> 1;
  const median = n % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { mean, median, n };
}

/**
 * Build the per-category aggregate object:
 *   { [category]: { n, mean:{metric->val}, median:{metric->val}, sampleSize:{metric->n}, asOf } }
 * `n` is the number of funds in the category; `sampleSize[metric]` is how many had history.
 */
export function computeCategories(funds, asOf) {
  const groups = new Map();
  for (const f of funds) {
    if (!groups.has(f.category)) groups.set(f.category, []);
    groups.get(f.category).push(f);
  }

  const out = {};
  for (const [cat, members] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const mean = {}, median = {}, sampleSize = {};
    for (const metric of CATEGORY_METRICS) {
      const s = stats(members.map((f) => metricValue(f, metric)));
      mean[metric] = s.mean;
      median[metric] = s.median;
      sampleSize[metric] = s.n;
    }
    out[cat] = { n: members.length, mean, median, sampleSize, asOf };
  }
  return out;
}

function vs(fundVal, categoryMean) {
  if (fundVal == null || categoryMean == null) return { ratio: null, ppGap: null };
  return {
    ratio: categoryMean > 0 ? fundVal / categoryMean : null, // N/A when category mean <= 0
    ppGap: fundVal - categoryMean, // decimal difference; the page renders it as percentage points
  };
}

/** Attach `vsCategory` (ratio + percentage-point gap vs the category MEAN) for 3Y/5Y/10Y. */
export function attachVsCategory(funds, categories) {
  for (const f of funds) {
    const mean = categories[f.category] ? categories[f.category].mean : null;
    f.vsCategory = {
      y3: vs(f.returns.y3, mean ? mean.y3 : null),
      y5: vs(f.returns.y5, mean ? mean.y5 : null),
      y10: vs(f.returns.y10, mean ? mean.y10 : null),
    };
  }
}
