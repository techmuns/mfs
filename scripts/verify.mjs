// verify.mjs — sanity-check the built data for a few well-known funds.
//
// For each fund it prints the computed trailing returns from funds.json, then does an
// INDEPENDENT recomputation of the 5Y CAGR straight from the raw MFAPI NAVs (re-implemented
// inline here, deliberately NOT importing metrics.mjs) so a bug in the metric code would
// show up as a mismatch. Run after build: `node scripts/verify.mjs`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchScheme } from './lib/mfapi.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const funds = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'data', 'funds.json'), 'utf8'));

const pct = (x) => (x == null ? 'N/A' : (x * 100).toFixed(2) + '%');
const WANT = ['Parag Parikh Flexi Cap', 'HDFC Flexi Cap', 'Quant Small Cap'];

// Independent raw-NAV helpers (no shared code with the pipeline).
function rawSeries(raw) {
  return raw.data
    .map((r) => {
      const [d, m, y] = r.date.split('-').map(Number);
      return { t: Date.UTC(y, m - 1, d), nav: Number(r.nav) };
    })
    .filter((p) => Number.isFinite(p.nav) && p.nav > 0)
    .sort((a, b) => a.t - b.t);
}
function navOnOrBefore(s, target) {
  let best = null;
  for (const p of s) { if (p.t <= target) best = p; else break; }
  return best;
}

for (const key of WANT) {
  const f = funds.find((x) => x.name.includes(key) && x.plan === 'Direct' && x.option === 'Growth');
  if (!f) { console.log(`\n### ${key}: NOT FOUND in funds.json`); continue; }

  console.log(`\n### ${f.name}  [${f.schemeCode}]  (${f.category})`);
  console.log(`    inception ${f.inceptionDate}  ageYears ${f.ageYears.toFixed(2)}  latestNav ${f.latestNav} @ ${f.latestNavDate}`);
  console.log(`    1Y ${pct(f.returns.y1)}   3Y ${pct(f.returns.y3)}   5Y ${pct(f.returns.y5)}   10Y ${pct(f.returns.y10)}   SI ${pct(f.returns.si)}`);
  console.log(`    3Y-roll avg ${f.rolling.y3 ? pct(f.rolling.y3.avg) : 'N/A'} (n=${f.rolling.y3?.n ?? 0})   vol ${pct(f.risk.volatility)}   Sharpe ${f.risk.sharpe?.toFixed(3) ?? 'N/A'}   maxDD ${pct(f.risk.maxDrawdown)}`);
  console.log(`    5Y vs category: ${f.vsCategory.y5.ratio?.toFixed(2) ?? 'N/A'}x  (${f.vsCategory.y5.ppGap != null ? (f.vsCategory.y5.ppGap >= 0 ? '+' : '') + (f.vsCategory.y5.ppGap * 100).toFixed(2) + 'pp' : 'N/A'})`);
  // Phase-3A enrichment
  const b = f.benchmark || {};
  console.log(`    benchmark: ${b.indexName || 'N/A'} (${b.basis || b.reason || ''}) | 5Y excess ${pct(b.excess?.y5)}  ratio ${b.ratio?.y5?.toFixed(2) ?? 'N/A'}`);
  console.log(`    TER direct ${f.costs?.terDirect ?? 'N/A'}%  regular ${f.costs?.terRegular ?? 'N/A'}%  | AUM ₹${f.aum?.cr ?? 'N/A'}cr (${f.aum?.asOf ?? ''})  | risk ${f.riskometer || 'N/A'}  | mgr ${f.manager ? f.manager.names[0].name : 'N/A'}`);
  const raw = await fetchScheme(f.schemeCode);
  const s = rawSeries(raw);
  const latest = s[s.length - 1];
  const d = new Date(latest.t);
  const target = Date.UTC(d.getUTCFullYear() - 5, d.getUTCMonth(), d.getUTCDate());
  const then = navOnOrBefore(s, target);
  if (then) {
    const days = (latest.t - then.t) / 86400000;
    const cagr = Math.pow(latest.nav / then.nav, 365.25 / days) - 1;
    const isoThen = new Date(then.t).toISOString().slice(0, 10);
    console.log(`    MANUAL 5Y check: NAV ${then.nav} @ ${isoThen}  ->  ${latest.nav} @ ${f.latestNavDate}  over ${days.toFixed(0)}d`);
    console.log(`                     (${latest.nav}/${then.nav})^(365.25/${days.toFixed(0)}) - 1 = ${pct(cagr)}  | stored ${pct(f.returns.y5)}  | delta ${(Math.abs(cagr - f.returns.y5) * 100).toFixed(4)}pp`);
  } else {
    console.log('    MANUAL 5Y check: insufficient history');
  }
}
