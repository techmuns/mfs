// alerts.mjs — the "What's New" feed. Each build diffs the PREVIOUS committed funds.json against
// the freshly computed data and records plain-English change events, deduped by a stable id so
// re-runs never duplicate. The very first run (no previous data) writes a single baseline note
// instead of flooding 574 "new fund" events.

const MAX_EVENTS = 500;
const MAX_DAYS = 90;

const mgrSet = (f) => new Set(((f.manager && f.manager.names) || []).map((m) => m.name));
function primaryManager(f) {
  if (!f.manager || !f.manager.names || !f.manager.names.length) return null;
  return [...f.manager.names].sort((a, b) => (b.tenureYears || 0) - (a.tenureYears || 0))[0].name;
}
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const pct1 = (x) => (x * 100).toFixed(1);

/**
 * Diff old → new and return the list of NEW events (not already in `priorIds`).
 * @param oldArr previous funds.json array (empty/undefined on first run)
 * @param newArr newly computed funds array
 * @param status new status.json (for data-health + as-of date)
 * @param priorIds Set of event ids already recorded
 */
export function computeAlertEvents(oldArr, newArr, status, priorIds) {
  const today = (status && status.data_as_of) || new Date().toISOString().slice(0, 10);
  const out = [];
  const add = (ev) => { if (!priorIds.has(ev.id) && !out.some((e) => e.id === ev.id)) out.push({ date: today, ...ev }); };

  if (!oldArr || oldArr.length === 0) {
    return { baseline: true, events: [{ id: `TRACKING_STARTED:${today}`, date: today, type: 'TRACKING_STARTED', severity: 'info', title: '🔔 Alerts tracking started', detail: `Now monitoring ${newArr.length} funds — changes will appear here from the next refresh.` }] };
  }

  const oldByCode = new Map(oldArr.map((f) => [f.schemeCode, f]));
  const newByCode = new Map(newArr.map((f) => [f.schemeCode, f]));

  for (const f of newArr) if (!oldByCode.has(f.schemeCode)) {
    add({ id: `NEW_FUND:${f.schemeCode}`, type: 'NEW_FUND', severity: 'notable', schemeCode: f.schemeCode, fundName: f.name, title: `🆕 New fund added — ${f.name}`, detail: `${f.peerGroup}${f.amc ? ' · ' + f.amc : ''}` });
  }
  for (const f of oldArr) if (!newByCode.has(f.schemeCode)) {
    add({ id: `FUND_CLOSED:${f.schemeCode}`, type: 'FUND_CLOSED', severity: 'warning', schemeCode: f.schemeCode, fundName: f.name, title: `⚠ Fund no longer listed — ${f.name}`, detail: 'The scheme dropped out of the universe (merged or closed).' });
  }

  for (const nf of newArr) {
    const of = oldByCode.get(nf.schemeCode);
    if (!of) continue;
    const base = { schemeCode: nf.schemeCode, fundName: nf.name };

    // MANAGER_CHANGE
    if (of.manager && nf.manager) {
      const oldM = mgrSet(of), newM = mgrSet(nf);
      if (!eqSet(oldM, newM)) {
        const joined = [...newM].filter((m) => !oldM.has(m)), left = [...oldM].filter((m) => !newM.has(m));
        const leadChanged = primaryManager(of) !== primaryManager(nf);
        add({ id: `MANAGER_CHANGE:${nf.schemeCode}:${[...newM].sort().join('|')}`, type: 'MANAGER_CHANGE', severity: leadChanged ? 'notable' : 'info', ...base, title: `👤 Manager change — ${nf.name}`, detail: [joined.length ? 'Joined: ' + joined.join(', ') : '', left.length ? 'Left: ' + left.join(', ') : '', leadChanged ? `Lead manager now ${primaryManager(nf)}` : ''].filter(Boolean).join(' · ') });
      }
    }
    // RECATEGORIZED
    if (of.category !== nf.category || of.peerGroup !== nf.peerGroup) {
      add({ id: `RECATEGORIZED:${nf.schemeCode}:${nf.peerGroup}`, type: 'RECATEGORIZED', severity: 'notable', ...base, title: `🔀 Recategorised — ${nf.name}`, detail: `${of.peerGroup} → ${nf.peerGroup}` });
    }
    // BENCHMARK_CHANGE
    const ob = of.benchmark || {}, nb = nf.benchmark || {};
    if ((ob.indexName || null) !== (nb.indexName || null) || (ob.filed || null) !== (nb.filed || null)) {
      add({ id: `BENCHMARK_CHANGE:${nf.schemeCode}:${nb.indexName || nb.filed || 'na'}`, type: 'BENCHMARK_CHANGE', severity: 'info', ...base, title: `🎯 Benchmark changed — ${nf.name}`, detail: `${ob.indexName || ob.filed || 'N/A'} → ${nb.indexName || nb.filed || 'N/A'}` });
    }
    // TER_CHANGE (>= 0.03pp)
    const ot = of.costs && of.costs.terDirect, nt = nf.costs && nf.costs.terDirect;
    if (ot != null && nt != null && Math.abs(nt - ot) >= 0.03) {
      add({ id: `TER_CHANGE:${nf.schemeCode}:${ot}->${nt}`, type: 'TER_CHANGE', severity: 'info', ...base, title: `💰 Expense ratio changed — ${nf.name}`, detail: `TER (direct) ${ot}% → ${nt}% (${nt > ot ? 'up' : 'down'} ${Math.abs(nt - ot).toFixed(2)}pp)` });
    }
    // RISKOMETER_CHANGE
    if (of.riskometer && nf.riskometer && of.riskometer !== nf.riskometer) {
      add({ id: `RISKOMETER_CHANGE:${nf.schemeCode}:${nf.riskometer}`, type: 'RISKOMETER_CHANGE', severity: 'notable', ...base, title: `🌡 Risk rating changed — ${nf.name}`, detail: `${of.riskometer} → ${nf.riskometer}` });
    }
    // EXIT_LOAD_CHANGE
    if (of.exitLoad && nf.exitLoad && of.exitLoad.text && of.exitLoad.text !== nf.exitLoad.text) {
      add({ id: `EXIT_LOAD_CHANGE:${nf.schemeCode}:${(nf.exitLoad.asOf || '')}`, type: 'EXIT_LOAD_CHANGE', severity: 'info', ...base, title: `🚪 Exit load changed — ${nf.name}`, detail: 'The exit-load terms were updated.' });
    }
    // AUM_MOVE (>= +-20%)
    const oa = of.aum && of.aum.cr, na = nf.aum && nf.aum.cr;
    if (oa != null && na != null && oa > 0) {
      const chg = (na - oa) / oa;
      if (Math.abs(chg) >= 0.20) add({ id: `AUM_MOVE:${nf.schemeCode}:${nf.aum.asOf || today}`, type: 'AUM_MOVE', severity: 'info', ...base, title: `📊 Fund size moved — ${nf.name}`, detail: `AUM ₹${Math.round(oa)}cr → ₹${Math.round(na)}cr (${chg >= 0 ? '+' : ''}${pct1(chg)}%)` });
    }
    // BIG_NAV_MOVE (>= +-4% vs previous latest NAV, new date)
    if (of.latestNav != null && nf.latestNav != null && of.latestNav > 0 && of.latestNavDate !== nf.latestNavDate) {
      const chg = (nf.latestNav - of.latestNav) / of.latestNav;
      if (Math.abs(chg) >= 0.04) add({ id: `BIG_NAV_MOVE:${nf.schemeCode}:${nf.latestNavDate}`, type: 'BIG_NAV_MOVE', severity: chg <= -0.04 ? 'notable' : 'info', ...base, title: `${chg >= 0 ? '📈' : '📉'} Big NAV move — ${nf.name}`, detail: `${chg >= 0 ? '+' : ''}${pct1(chg)}% on ${nf.latestNavDate}` });
    }
    // HISTORY_MILESTONE
    if (of.history && nf.history) {
      if (!of.history.has5y && nf.history.has5y) add({ id: `HISTORY5Y:${nf.schemeCode}`, type: 'HISTORY_MILESTONE', severity: 'info', ...base, title: `📈 ${nf.name} now has a 5-year track record`, detail: 'A 5-year return history is now available.' });
      if (!of.history.has10y && nf.history.has10y) add({ id: `HISTORY10Y:${nf.schemeCode}`, type: 'HISTORY_MILESTONE', severity: 'info', ...base, title: `📈 ${nf.name} now has a 10-year track record`, detail: 'A 10-year return history is now available.' });
    }
  }

  // DATA_HEALTH — operational (a source failed / data went stale)
  for (const w of (status && status.enrichmentWarnings) || []) {
    add({ id: `DATA_HEALTH:${today}:${String(w).slice(0, 48)}`, type: 'DATA_HEALTH', severity: 'warning', title: '⚠ Data health notice', detail: String(w) });
  }

  return { baseline: false, events: out };
}

/** Merge new events into the prior feed: newest-first, deduped, capped by count and age. */
export function mergeAlerts(prior, result, generatedAt) {
  const priorEvents = (prior && prior.events) || [];
  const all = [...result.events, ...priorEvents];
  const seen = new Set();
  const deduped = all.filter((e) => (seen.has(e.id) ? false : seen.add(e.id)));
  deduped.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const cutoff = new Date(Date.now() - MAX_DAYS * 86400000).toISOString().slice(0, 10);
  const kept = deduped.filter((e) => (e.date || '') >= cutoff).slice(0, MAX_EVENTS);
  return { generated_at: generatedAt, count: kept.length, events: kept };
}
