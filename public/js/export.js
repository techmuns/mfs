// export.js — CSV + a colourful multi-sheet Excel workbook of the current filtered view.
// ExcelJS is loaded as a global <script> (window.ExcelJS).

const PCT = (v) => (v == null || !isFinite(v) ? '' : +(v * 100).toFixed(2));
const RAW = (v) => (v == null || !isFinite(v) ? '' : +v.toFixed(4));

// Columns for export (raw numbers; percentages carry a % number format in Excel).
function rows(funds, cats) {
  return funds.map((f) => ({
    Fund: f.name, AMC: f.amc || '', 'Peer Group': f.peerGroup, 'AMFI Category': f.category,
    '1Y': f.returns.y1, '3Y': f.returns.y3, '5Y': f.returns.y5, '10Y': f.returns.y10, 'Since Incep.': f.returns.si,
    '3Y Rolling': f.rolling.y3 ? f.rolling.y3.avg : null, '5Y Rolling': f.rolling.y5 ? f.rolling.y5.avg : null,
    '% Positive (3Y)': f.rolling.y3 ? f.rolling.y3.pctPositive : null,
    '5Y vs Cat (x)': f.vsCategory.y5 ? f.vsCategory.y5.ratio : null,
    '10Y vs Cat (x)': f.vsCategory.y10 ? f.vsCategory.y10.ratio : null,
    Sharpe: f.risk.sharpe, Sortino: f.risk.sortino,
    Volatility: f.risk.volatility, 'Category Volatility': cats[f.peerGroup] ? cats[f.peerGroup].mean.volatility : null,
    'Max Drawdown': f.risk.maxDrawdown, Age: f.ageYears, Inception: f.inceptionDate, 'Latest NAV': f.latestNav,
  }));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const PCT_COLS = new Set(['1Y', '3Y', '5Y', '10Y', 'Since Incep.', '3Y Rolling', '5Y Rolling', '% Positive (3Y)', 'Volatility', 'Category Volatility', 'Max Drawdown']);

export function exportCSV(funds, cats, dataAsOf) {
  const data = rows(funds, cats);
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const head = headers.map((h) => (PCT_COLS.has(h) ? h + ' (%)' : h));
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [head.join(',')];
  for (const r of data) lines.push(headers.map((h) => esc(PCT_COLS.has(h) ? PCT(r[h]) : (typeof r[h] === 'number' ? RAW(r[h]) : r[h]))).join(','));
  download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `mf-screener_${dataAsOf || 'export'}.csv`);
}

export async function exportExcel(funds, cats, status) {
  const ExcelJS = window.ExcelJS;
  if (!ExcelJS) { exportCSV(funds, cats, status && status.data_as_of); return; }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MF Screener'; wb.created = new Date();

  // --- Funds sheet ---
  const ws = wb.addWorksheet('Funds', { views: [{ state: 'frozen', ySplit: 1 }] });
  const data = rows(funds, cats);
  const headers = data.length ? Object.keys(data[0]) : ['Fund'];
  ws.columns = headers.map((h) => ({ header: h, key: h, width: h === 'Fund' ? 34 : h === 'AMC' ? 24 : h === 'Peer Group' ? 22 : 13 }));
  ws.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } }; c.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 11 }; c.alignment = { vertical: 'middle' }; });
  ws.getRow(1).height = 22;

  for (const r of data) {
    const row = ws.addRow(r);
    for (const h of headers) {
      const cell = row.getCell(h);
      if (PCT_COLS.has(h)) { cell.numFmt = '0.0%'; }
      else if (h.endsWith('(x)')) { cell.numFmt = '0.00"×"'; }
      else if (h === 'Sharpe' || h === 'Sortino' || h === 'Age') { cell.numFmt = '0.00'; }
      else if (h === 'Latest NAV') { cell.numFmt = '₹0.00'; }
      // Heat-tint the headline return columns so the sheet "speaks" like the table.
      if ((h === '5Y' || h === '10Y' || h === '3Y') && typeof r[h] === 'number') {
        const t = Math.max(0, Math.min(1, (r[h] + 0.05) / 0.30));
        const g = Math.round(120 + 90 * t), rr = Math.round(250 - 120 * t);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + [rr, g, 120].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase() + '' } };
      }
    }
  }
  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + headers.length)}1` };

  // --- Peer Groups sheet ---
  const pg = wb.addWorksheet('Peer Groups', { views: [{ state: 'frozen', ySplit: 1 }] });
  pg.columns = [
    { header: 'Peer Group', key: 'g', width: 28 }, { header: 'Funds', key: 'n', width: 8 },
    { header: 'Mean 5Y', key: 'm5', width: 12 }, { header: 'Median 5Y', key: 'md5', width: 12 },
    { header: 'Mean 10Y', key: 'm10', width: 12 }, { header: 'Mean Vol', key: 'vol', width: 12 }, { header: 'Mean Sharpe', key: 'sh', width: 12 },
  ];
  pg.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA855F7' } }; c.font = { color: { argb: 'FFFFFFFF' }, bold: true }; });
  for (const [g, v] of Object.entries(cats).sort((a, b) => (b[1].mean.y5 ?? -9) - (a[1].mean.y5 ?? -9))) {
    const row = pg.addRow({ g, n: v.n, m5: v.mean.y5, md5: v.median.y5, m10: v.mean.y10, vol: v.mean.volatility, sh: v.mean.sharpe });
    ['m5', 'md5', 'm10', 'vol'].forEach((k) => (row.getCell(k).numFmt = '0.0%'));
    row.getCell('sh').numFmt = '0.00';
  }

  // --- About sheet ---
  const ab = wb.addWorksheet('About');
  ab.columns = [{ width: 24 }, { width: 90 }];
  const add = (k, v) => ab.addRow([k, v]);
  add('MF Screener', 'Indian equity mutual fund screener — research only');
  if (status) {
    add('Data as of', status.data_as_of);
    add('Generated', status.generated_at);
    add('Funds', status.counts.equityDirectGrowth);
    add('Risk-free rate', `${(status.riskFreeRate.annual_rate * 100).toFixed(2)}% — ${status.riskFreeRate.source} (${status.riskFreeRate.as_of})`);
    (status.sources || []).forEach((s) => add('Source', `${s.name} — ${s.url} (as of ${s.asOf})`));
    (status.notes || []).forEach((n) => add('Note', n));
  }
  ab.getColumn(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `mf-screener_${(status && status.data_as_of) || 'export'}.xlsx`);
}
