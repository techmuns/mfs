// charts.js — ECharts renderers. Colourful, legible tooltips, de-cluttered axes, no
// scatter/bubble. ECharts is loaded as a global <script> (window.echarts).

import { groupColor, orderGroups, pct, num } from './meta.js';

const registry = new Set();
function ec() { return window.echarts; }

function chartOn(el) {
  if (!ec()) return null;
  let inst = ec().getInstanceByDom(el);
  if (!inst) {
    inst = ec().init(el);
    registry.add(inst);
    // The Tailwind CDN applies the grid layout asynchronously, so a chart can be init'd while
    // its container is still full-width and then shrink. A ResizeObserver re-fits the chart to
    // the container whenever it settles (also covers responsive + tab show/hide resizes).
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => { if (!inst.isDisposed()) inst.resize(); });
      ro.observe(el);
      el.__ro = ro;
    }
  }
  return inst;
}
export function disposeChart(el) {
  if (el && el.__ro) { el.__ro.disconnect(); delete el.__ro; }
  const inst = el && ec() && ec().getInstanceByDom(el);
  if (inst) { registry.delete(inst); inst.dispose(); }
}
window.addEventListener('resize', () => { for (const c of registry) c.resize(); });

// Shared tooltip look.
const TT = {
  backgroundColor: 'rgba(255,255,255,0.97)',
  borderColor: '#e2e8f0', borderWidth: 1,
  textStyle: { color: '#0f172a', fontFamily: 'Inter, sans-serif', fontSize: 12 },
  extraCssText: 'box-shadow:0 10px 30px rgba(2,6,23,.12);border-radius:12px;padding:10px 12px;',
};
const AXIS_LABEL = { color: '#64748b', fontFamily: 'Inter, sans-serif', fontSize: 11 };
const grad = (from, to) => ({ type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: from }, { offset: 1, color: to }] });

/** Bar of average 5Y CAGR per peer group (hover shows mean, median, sample size). */
export function categoryBar(el, categories) {
  const inst = chartOn(el); if (!inst) return;
  const rows = orderGroups(Object.keys(categories))
    .map((g) => ({ g, ...categories[g] }))
    .filter((r) => r.mean && r.mean.y5 != null)
    .sort((a, b) => a.mean.y5 - b.mean.y5); // ascending -> highest ends up on top
  el.style.height = Math.max(260, rows.length * 24 + 70) + 'px';
  inst.resize();
  inst.setOption({
    grid: { left: 150, right: 56, top: 10, bottom: 24 },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, ...TT,
      formatter: (p) => {
        const r = rows[p[0].dataIndex];
        return `<b>${r.g}</b><br/>Avg 5Y CAGR: <b>${pct(r.mean.y5)}</b><br/>Median: ${pct(r.median.y5)}<br/>Funds (with 5Y): ${r.sampleSize.y5} of ${r.n}`;
      },
    },
    xAxis: { type: 'value', axisLabel: { ...AXIS_LABEL, formatter: (v) => (v * 100).toFixed(0) + '%' }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    yAxis: { type: 'category', data: rows.map((r) => r.g), axisLabel: { ...AXIS_LABEL }, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
    series: [{
      type: 'bar', barWidth: '62%',
      data: rows.map((r) => ({ value: r.mean.y5, itemStyle: { color: grad(groupColor(r.g) + 'cc', groupColor(r.g)), borderRadius: [0, 6, 6, 0] } })),
      label: { show: true, position: 'right', formatter: (p) => pct(p.value), color: '#475569', fontSize: 11, fontWeight: 600 },
    }],
  }, true);
}

/** Top-N funds in the selected scope by 5Y CAGR (horizontal bars). */
export function topFundsBar(el, funds, n = 10) {
  const inst = chartOn(el); if (!inst) return;
  const rows = funds.filter((f) => f.returns.y5 != null).sort((a, b) => b.returns.y5 - a.returns.y5).slice(0, n).reverse();
  el.style.height = Math.max(220, rows.length * 30 + 50) + 'px';
  inst.resize();
  inst.setOption({
    grid: { left: 8, right: 60, top: 8, bottom: 24, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...TT, formatter: (p) => `<b>${rows[p[0].dataIndex].name}</b><br/>${rows[p[0].dataIndex].peerGroup}<br/>5Y CAGR: <b>${pct(p[0].value)}</b>` },
    xAxis: { type: 'value', axisLabel: { ...AXIS_LABEL, formatter: (v) => (v * 100).toFixed(0) + '%' }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    yAxis: {
      type: 'category', data: rows.map((r) => (r.name.length > 34 ? r.name.slice(0, 32) + '…' : r.name)),
      axisLabel: { ...AXIS_LABEL, width: 220, overflow: 'truncate' }, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e2e8f0' } },
    },
    series: [{
      type: 'bar', barWidth: '64%',
      data: rows.map((r) => ({ value: r.returns.y5, itemStyle: { color: grad('#818cf8', '#6366f1'), borderRadius: [0, 6, 6, 0] } })),
      label: { show: true, position: 'right', formatter: (p) => pct(p.value), color: '#475569', fontSize: 11, fontWeight: 600 },
    }],
  }, true);
}

/**
 * Rolling-return RANGE: for the top funds, a floating bar from min to max 3Y rolling return
 * with the average marked. Implemented as a custom series (no scatter chart).
 */
export function rollingRange(el, funds, n = 10) {
  const inst = chartOn(el); if (!inst) return;
  const rows = funds.filter((f) => f.rolling.y3 && f.rolling.y3.n >= 1)
    .sort((a, b) => b.rolling.y3.avg - a.rolling.y3.avg).slice(0, n).reverse()
    .map((f) => ({ name: f.name, g: f.peerGroup, min: f.rolling.y3.min, max: f.rolling.y3.max, avg: f.rolling.y3.avg }));
  el.style.height = Math.max(220, rows.length * 32 + 56) + 'px';
  inst.resize();
  inst.setOption({
    grid: { left: 8, right: 56, top: 8, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'item', ...TT,
      formatter: (p) => { const r = rows[p.dataIndex]; return `<b>${r.name}</b><br/>Worst 3Y: ${pct(r.min)}<br/>Average 3Y: <b>${pct(r.avg)}</b><br/>Best 3Y: ${pct(r.max)}`; },
    },
    xAxis: { type: 'value', axisLabel: { ...AXIS_LABEL, formatter: (v) => (v * 100).toFixed(0) + '%' }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    yAxis: { type: 'category', data: rows.map((r) => (r.name.length > 34 ? r.name.slice(0, 32) + '…' : r.name)), axisLabel: { ...AXIS_LABEL, width: 220, overflow: 'truncate' }, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
    series: [{
      type: 'custom',
      renderItem: (params, api) => {
        const idx = api.value(0);
        const pMin = api.coord([api.value(1), idx]);
        const pMax = api.coord([api.value(2), idx]);
        const pAvg = api.coord([api.value(3), idx]);
        const bandH = api.size([0, 1])[1];
        const h = Math.min(16, bandH * 0.5);
        const y = pMin[1];
        const col = groupColor(rows[idx].g);
        return {
          type: 'group', children: [
            { type: 'rect', shape: { x: pMin[0], y: y - h / 2, width: Math.max(2, pMax[0] - pMin[0]), height: h, r: h / 2 }, style: { fill: col + '66' } },
            { type: 'circle', shape: { cx: pAvg[0], cy: y, r: Math.max(4, h / 2) }, style: { fill: col, stroke: '#fff', lineWidth: 2 } },
          ],
        };
      },
      encode: { x: [1, 2, 3], y: 0 },
      data: rows.map((r, i) => [i, r.min, r.max, r.avg]),
    }],
  }, true);
}

/** Live NAV growth line (area), from a [[ts, nav], ...] series. */
export function navLine(el, series) {
  const inst = chartOn(el); if (!inst) return;
  inst.setOption({
    grid: { left: 8, right: 14, top: 16, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'axis', ...TT,
      formatter: (p) => { const d = new Date(p[0].value[0]); return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}<br/>NAV: <b>₹${num(p[0].value[1], 2)}</b>`; },
    },
    xAxis: { type: 'time', axisLabel: { ...AXIS_LABEL }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
    yAxis: { type: 'value', scale: true, axisLabel: { ...AXIS_LABEL, formatter: (v) => '₹' + v }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [{
      type: 'line', showSymbol: false, smooth: true, data: series,
      lineStyle: { width: 2.5, color: '#6366f1' },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(99,102,241,0.35)' }, { offset: 1, color: 'rgba(99,102,241,0.02)' }] } },
    }],
  }, true);
}
