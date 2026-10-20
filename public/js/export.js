// export.js — CSV (current view) + a self-contained Excel analysis workbook.
// The Excel file is a proper Excel TABLE (ListObject) with AutoFilter on every column and a
// SUBTOTAL summary that recalculates as the user filters INSIDE Excel — so the dashboard's
// filtering carries over. ExcelJS is loaded as a global <script> (window.ExcelJS).

import { scoreOf } from './score.js';

// ---- column spec: the single source of truth for the Funds sheet + CSV ------
// type drives the number format & grading. get(fund, cats, visibleSet) -> raw value.
const COLSPEC = [
  { header: 'Fund', type: 'text', width: 34, get: (f) => f.name, desc: 'Scheme name (Direct plan, Growth option).' },
  { header: 'AMC', type: 'text', width: 22, get: (f) => f.amc || '', desc: 'Asset management company.' },
  { header: 'Peer Group', type: 'text', width: 22, get: (f) => f.peerGroup, desc: 'Group used for every “vs category” comparison (thematic funds are split by theme).' },
  { header: 'AMFI Category', type: 'text', width: 20, get: (f) => f.category, desc: 'Raw SEBI/AMFI category.' },
  { header: 'Score', type: 'num0', width: 8, grade: 'high', get: (f) => scoreNum(f), desc: 'Composite 0–100: percentile vs peer group across performance, consistency, risk, cost, manager.' },
  { header: '1Y', type: 'pct', width: 9, grade: 'high', get: (f) => f.returns.y1, desc: '1-year return (absolute).' },
  { header: '3Y CAGR', type: 'pct', width: 10, grade: 'high', get: (f) => f.returns.y3, desc: '3-year annualised return (CAGR).' },
  { header: '5Y CAGR', type: 'pct', width: 10, grade: 'high', get: (f) => f.returns.y5, desc: '5-year annualised return (CAGR).' },
  { header: '10Y CAGR', type: 'pct', width: 10, grade: 'high', get: (f) => f.returns.y10, desc: '10-year annualised return (CAGR).' },
  { header: 'Since Inception', type: 'pct', width: 13, grade: 'high', get: (f) => f.returns.si, desc: 'Annualised return since launch.' },
  { header: '3Y Rolling Avg', type: 'pct', width: 12, grade: 'high', get: (f) => (f.rolling.y3 ? f.rolling.y3.avg : null), desc: 'Average 3-year return across many start dates (consistency).' },
  { header: '5Y Rolling Avg', type: 'pct', width: 12, grade: 'high', get: (f) => (f.rolling.y5 ? f.rolling.y5.avg : null), desc: 'Average 5-year return across many start dates.' },
  { header: '3Y % Positive', type: 'pct', width: 11, grade: 'high', get: (f) => (f.rolling.y3 ? f.rolling.y3.pctPositive : null), desc: 'Share of 3-year windows that ended in a gain.' },
  { header: '5Y vs Category', type: 'ratio', width: 13, grade: 'high', get: (f) => (f.vsCategory.y5 ? f.vsCategory.y5.ratio : null), desc: 'Fund ÷ peer-group average over 5Y. Above 1.00× = beat peers.' },
  { header: '10Y vs Category', type: 'ratio', width: 14, grade: 'high', get: (f) => (f.vsCategory.y10 ? f.vsCategory.y10.ratio : null), desc: 'Fund ÷ peer-group average over 10Y.' },
  { header: '5Y Benchmark Excess', type: 'pct', width: 17, grade: 'high', get: (f) => (f.benchmark && f.benchmark.excess ? f.benchmark.excess.y5 : null), desc: '5Y return minus benchmark Total Return Index over the same window. Source: NSE Indices TRI.' },
  { header: 'Sharpe', type: 'num2', width: 9, grade: 'high', get: (f) => f.risk.sharpe, desc: 'Return per unit of risk (higher is better).' },
  { header: 'Sortino', type: 'num2', width: 9, grade: 'high', get: (f) => f.risk.sortino, desc: 'Like Sharpe but penalises only downside swings.' },
  { header: 'Volatility', type: 'pct', width: 10, grade: 'low', get: (f) => f.risk.volatility, desc: 'Annualised standard deviation of returns (lower is calmer).' },
  { header: 'Category Volatility', type: 'pct', width: 16, get: (f, cats) => (cats[f.peerGroup] ? cats[f.peerGroup].mean.volatility : null), desc: 'Average volatility of the peer group.' },
  { header: 'Max Drawdown', type: 'pct', width: 12, grade: 'high', get: (f) => f.risk.maxDrawdown, desc: 'Worst fall from a previous peak (closer to 0% is better).' },
  { header: 'TER Direct', type: 'terpct', width: 10, grade: 'low', get: (f) => (f.costs ? f.costs.terDirect : null), desc: 'Direct-plan expense ratio, already reflected in returns. Source: SEBI/AMFI via tigzig.' },
  { header: 'TER Regular', type: 'terpct', width: 11, grade: 'low', get: (f) => (f.costs ? f.costs.terRegular : null), desc: 'Regular-plan expense ratio.' },
  { header: 'AUM (cr)', type: 'cr', width: 13, get: (f) => (f.aum ? f.aum.cr : null), desc: 'Fund size in ₹ crore (all plans). Source: AMFI via tigzig.' },
  { header: 'Age (yrs)', type: 'num1', width: 9, get: (f) => f.ageYears, desc: 'Years since launch.' },
  { header: 'Benchmark', type: 'text', width: 22, get: (f) => (f.benchmark ? f.benchmark.indexName || '' : ''), desc: 'Total Return Index the fund is compared against.' },
  { header: 'Riskometer', type: 'text', width: 16, get: (f) => f.riskometer || '', desc: 'SEBI riskometer rating.' },
  { header: 'Manager(s)', type: 'text', width: 28, get: (f) => (f.manager ? f.manager.names.map((n) => n.name).join('; ') : ''), desc: 'Fund manager(s).' },
  { header: 'Inception', type: 'text', width: 12, get: (f) => f.inceptionDate || '', desc: 'Launch date.' },
  { header: 'Latest NAV', type: 'nav', width: 11, get: (f) => f.latestNav, desc: 'Most recent NAV (₹).' },
  { header: 'On Dashboard', type: 'text', width: 12, get: (f, cats, vis) => (vis && vis.has(f.schemeCode) ? 'Yes' : 'No'), desc: 'Yes = this fund passed your dashboard filters at export time. Filter to Yes to reproduce the dashboard view.' },
];

const FMT = { num0: '0', num1: '0.0', num2: '0.00', pct: '0.0%', ratio: '0.00"×"', terpct: '0.00"%"', cr: '#,##0" cr"', nav: '"₹"#,##0.00' };
const scoreNum = (f) => { const v = scoreOf(f); return v == null || !isFinite(v) ? null : Math.round(v); };

function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function cellVal(col, f, cats, vis) {
  const v = col.get(f, cats, vis);
  if (col.type === 'text') return v == null ? '' : v;
  return v == null || !isFinite(v) ? null : v;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- CSV (the funds currently in view) -------------------------------------
export function exportCSV(funds, cats, dataAsOf) {
  if (!funds.length) return;
  const cols = COLSPEC.filter((c) => c.header !== 'On Dashboard');
  const vis = new Set();
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csvCell = (col, f) => {
    const v = col.get(f, cats, vis);
    if (v == null || (col.type !== 'text' && !isFinite(v))) return '';
    if (col.type === 'pct') return (v * 100).toFixed(2);
    if (col.type === 'terpct') return v.toFixed(2);
    if (col.type === 'ratio') return v.toFixed(2);
    if (col.type === 'cr') return v.toFixed(0);
    if (col.type === 'nav') return v.toFixed(2);
    if (col.type === 'num0') return v.toFixed(0);
    if (col.type === 'num1') return v.toFixed(1);
    if (col.type === 'num2') return v.toFixed(2);
    return v;
  };
  const head = cols.map((c) => (c.type === 'pct' || c.type === 'terpct' ? c.header + ' (%)' : c.header));
  const lines = [head.map(esc).join(',')];
  for (const f of funds) lines.push(cols.map((c) => esc(csvCell(c, f))).join(','));
  download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `mf-screener_${dataAsOf || 'export'}.csv`);
}

// ---- Excel workbook --------------------------------------------------------
const INK = { header: 'FF4F46E5', headerAlt: 'FFA855F7', border: 'FFE2E8F0', label: 'FF475569', title: 'FF0F172A' };
const SCALE_HIGH = [{ argb: 'FFF8696B' }, { argb: 'FFFFEB84' }, { argb: 'FF63BE7B' }]; // low=red … high=green
const SCALE_LOW = [{ argb: 'FF63BE7B' }, { argb: 'FFFFEB84' }, { argb: 'FFF8696B' }]; // low=green … high=red
const thin = (argb) => ({ style: 'thin', color: { argb } });
const borderAll = (argb) => ({ top: thin(argb), left: thin(argb), bottom: thin(argb), right: thin(argb) });

export async function exportExcel(allFunds, visibleCodes, cats, status, filterDesc) {
  const ExcelJS = window.ExcelJS;
  if (!ExcelJS) { exportCSV([...allFunds].filter((f) => !visibleCodes || visibleCodes.has(f.schemeCode)), cats, status && status.data_as_of); return; }
  const vis = visibleCodes || new Set();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MF Screener'; wb.created = new Date();

  buildFundsSheet(wb, allFunds, cats, vis, status, filterDesc);
  buildCategorySheet(wb, cats);
  buildMethodologySheet(wb, status);

  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `mf-screener_${(status && status.data_as_of) || 'export'}.xlsx`);
}

function buildFundsSheet(wb, allFunds, cats, vis, status, filterDesc) {
  const ws = wb.addWorksheet('Funds');
  const ncol = COLSPEC.length, lastCol = colLetter(ncol);
  const HEADER_ROW = 7, firstData = HEADER_ROW + 1;

  // Dashboard-visible funds first, then by score — so the file opens "as seen", yet holds everyone.
  const funds = [...allFunds].sort((a, b) => {
    const av = vis.has(a.schemeCode) ? 0 : 1, bv = vis.has(b.schemeCode) ? 0 : 1;
    if (av !== bv) return av - bv;
    return (scoreNum(b) ?? -1) - (scoreNum(a) ?? -1);
  });
  const lastData = firstData + funds.length - 1;

  ws.columns = COLSPEC.map((c) => ({ width: c.width }));

  // Title + filter note.
  ws.mergeCells(`A1:${colLetter(Math.min(ncol, 12))}1`);
  ws.getCell('A1').value = 'MF Screener — Funds';
  ws.getCell('A1').font = { name: 'Calibri', bold: true, size: 15, color: { argb: INK.title } };
  ws.mergeCells(`A2:${lastCol}2`);
  ws.getCell('A2').value = `Use the ▼ dropdowns to filter — the summary recalculates automatically. All ${funds.length} funds are included; filter “On Dashboard” to Yes to reproduce your dashboard view.`
    + (filterDesc ? `  (dashboard filter at export: ${filterDesc})` : '  (no dashboard filter applied at export)');
  ws.getCell('A2').font = { name: 'Calibri', size: 10, color: { argb: INK.label } };

  // Summary strip (SUBTOTAL over the table body — recalcs when the table is filtered in Excel).
  const col = (h) => colLetter(COLSPEC.findIndex((c) => c.header === h) + 1);
  const range = (h) => `${col(h)}${firstData}:${col(h)}${lastData}`;
  const summary = [
    ['Visible funds', `SUBTOTAL(103,${range('Fund')})`, '#,##0'],
    ['Avg Score', `SUBTOTAL(101,${range('Score')})`, '0.0'],
    ['Avg 5Y CAGR', `SUBTOTAL(101,${range('5Y CAGR')})`, '0.0%'],
    ['Avg 10Y CAGR', `SUBTOTAL(101,${range('10Y CAGR')})`, '0.0%'],
    ['Avg Sharpe', `SUBTOTAL(101,${range('Sharpe')})`, '0.00'],
    ['Avg Volatility', `SUBTOTAL(101,${range('Volatility')})`, '0.0%'],
    ['Avg TER', `SUBTOTAL(101,${range('TER Direct')})`, '0.00"%"'],
    ['Total AUM', `SUBTOTAL(109,${range('AUM (cr)')})`, '#,##0" cr"'],
  ];
  summary.forEach(([label, formula, fmt], i) => {
    const L = colLetter(i + 1);
    const lc = ws.getCell(`${L}4`); lc.value = label; lc.font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK.label } };
    lc.alignment = { horizontal: 'left' }; lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }; lc.border = borderAll(INK.border);
    const vc = ws.getCell(`${L}5`); vc.value = { formula }; vc.numFmt = fmt;
    vc.font = { name: 'Calibri', size: 13, bold: true, color: { argb: INK.header } }; vc.border = borderAll(INK.border);
  });

  // The table (ListObject) with a filter button on every column.
  ws.addTable({
    name: 'FundsTable', ref: `A${HEADER_ROW}`, headerRow: true,
    style: { theme: 'TableStyleLight1', showRowStripes: true },
    columns: COLSPEC.map((c) => ({ name: c.header, filterButton: true })),
    rows: funds.map((f) => COLSPEC.map((c) => cellVal(c, f, cats, vis))),
  });

  // Header row: bold, indigo, white — frozen & always visible.
  const hr = ws.getRow(HEADER_ROW); hr.height = 26;
  for (let i = 1; i <= ncol; i++) {
    const cell = ws.getCell(HEADER_ROW, i);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK.header } };
    cell.font = { name: 'Calibri', bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = borderAll(INK.border);
  }

  // Body: number formats, borders, alignment.
  for (let r = firstData; r <= lastData; r++) {
    for (let i = 0; i < ncol; i++) {
      const c = COLSPEC[i], cell = ws.getCell(r, i + 1);
      if (FMT[c.type]) cell.numFmt = FMT[c.type];
      cell.border = borderAll(INK.border);
      cell.alignment = { horizontal: c.type === 'text' ? 'left' : 'right' };
      cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF334155' } };
    }
  }

  // Colour-grade the numeric analysis columns (3-colour scale, recalculates on filter).
  COLSPEC.forEach((c, i) => {
    if (!c.grade) return;
    const L = colLetter(i + 1);
    ws.addConditionalFormatting({
      ref: `${L}${firstData}:${L}${lastData}`,
      rules: [{ type: 'colorScale', cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }], color: c.grade === 'low' ? SCALE_LOW : SCALE_HIGH }],
    });
  });

  // Gridlines OFF; freeze the summary + header rows and the Fund column.
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: HEADER_ROW, showGridLines: false }];
}

function buildCategorySheet(wb, cats) {
  const ws = wb.addWorksheet('Category Averages');
  ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  const cols = [
    { header: 'Peer Group', key: 'g', width: 28, type: 'text' },
    { header: 'Funds', key: 'n', width: 8, type: 'num0' },
    { header: 'Mean 5Y', key: 'm5', width: 11, type: 'pct' },
    { header: 'Median 5Y', key: 'md5', width: 11, type: 'pct' },
    { header: 'Mean 10Y', key: 'm10', width: 11, type: 'pct' },
    { header: 'Mean 3Y Rolling', key: 'mroll', width: 14, type: 'pct' },
    { header: 'Mean Sharpe', key: 'sh', width: 12, type: 'num2' },
    { header: 'Mean Volatility', key: 'vol', width: 13, type: 'pct' },
    { header: 'Median TER', key: 'ter', width: 11, type: 'terpct' },
    { header: 'Mean 5Y Bench Excess', key: 'ex5', width: 18, type: 'pct' },
  ];
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));
  ws.getRow(1).values = cols.map((c) => c.header);
  const hr = ws.getRow(1); hr.height = 22;
  hr.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK.headerAlt } }; cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } }; cell.border = borderAll(INK.border); cell.alignment = { vertical: 'middle', wrapText: true }; });

  const entries = Object.entries(cats).sort((a, b) => (b[1].mean.y5 ?? -9) - (a[1].mean.y5 ?? -9));
  entries.forEach(([g, v]) => {
    const row = ws.addRow({
      g, n: v.n, m5: v.mean.y5, md5: v.median.y5, m10: v.mean.y10, mroll: v.mean.rolling3yAvg,
      sh: v.mean.sharpe, vol: v.mean.volatility, ter: v.median.terDirect, ex5: v.mean.excess5y,
    });
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (FMT[c.type]) cell.numFmt = FMT[c.type];
      cell.border = borderAll(INK.border);
      cell.alignment = { horizontal: c.type === 'text' ? 'left' : 'right' };
      cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF334155' } };
    });
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

function buildMethodologySheet(wb, status) {
  const ws = wb.addWorksheet('Methodology & Sources');
  ws.views = [{ showGridLines: false }];
  ws.columns = [{ width: 24 }, { width: 100 }];
  const H = (t) => { const r = ws.addRow([t, '']); r.getCell(1).font = { name: 'Calibri', bold: true, size: 12, color: { argb: INK.header } }; ws.mergeCells(`A${r.number}:B${r.number}`); };
  const KV = (k, v) => { const r = ws.addRow([k, v]); r.getCell(1).font = { name: 'Calibri', bold: true, size: 10, color: { argb: INK.label } }; r.getCell(1).alignment = { vertical: 'top' }; r.getCell(2).font = { name: 'Calibri', size: 10, color: { argb: 'FF334155' } }; r.getCell(2).alignment = { wrapText: true, vertical: 'top' }; };

  H('MF Screener — research only, not investment advice');
  KV('Universe', 'Open-ended EQUITY schemes · Direct plan · Growth option.');
  if (status) {
    KV('Data as of', status.data_as_of);
    KV('Rebuilt', new Date(status.generated_at).toUTCString());
    KV('Funds', String((status.counts && status.counts.equityDirectGrowth) || ''));
    KV('Risk-free rate', `${(status.riskFreeRate.annual_rate * 100).toFixed(2)}% — ${status.riskFreeRate.source} (as of ${status.riskFreeRate.as_of})`);
  }
  ws.addRow([]);
  H('What each column means');
  COLSPEC.forEach((c) => KV(c.header, c.desc || ''));
  ws.addRow([]);
  H('Data sources & as-of dates');
  (status && status.sources || []).forEach((s) => KV(s.name, `${s.url}${s.asOf ? ' · as of ' + s.asOf : ''} — ${s.note || ''}`));
  ws.addRow([]);
  H('Method notes');
  (status && status.notes || []).slice(0, 6).forEach((n, i) => KV(`Note ${i + 1}`, n));
  ws.addRow([]);
  KV('Fees & returns', 'NAV returns are already net of fees, so the expense ratio (TER) is shown for information and is NOT deducted again.');
  ws.addRow([]);
  // light borders on the used block
  for (let r = 1; r <= ws.rowCount; r++) for (let cI = 1; cI <= 2; cI++) ws.getCell(r, cI).border = { bottom: thin('FFF1F5F9') };
}
