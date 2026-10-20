// app.js — the Phase-1 screener page (vanilla ES module, no framework, no build step).
//
// It reads the three pre-computed JSON files written by the nightly pipeline and renders a
// sortable, filterable table plus a data-status card. The browser does ZERO number
// crunching — every figure is already computed in funds.json / categories.json.

const DATA = {
  funds: './data/funds.json',
  categories: './data/categories.json',
  status: './data/status.json',
};

// Distinct, tasteful colour per category (hex -> inline styles, so no JIT dependency).
const CAT_COLOR = {
  'Flexi Cap': '#6366f1', 'Large Cap': '#0ea5e9', 'Large & Mid Cap': '#06b6d4',
  'Mid Cap': '#8b5cf6', 'Small Cap': '#d946ef', 'Multi Cap': '#3b82f6',
  'ELSS': '#10b981', 'Focused': '#f59e0b', 'Value/Contra': '#f43f5e',
  'Dividend Yield': '#14b8a6', 'Sectoral/Thematic': '#a855f7',
};

const state = {
  funds: [],
  categories: {},
  status: null,
  filterCategory: '',
  search: '',
  sort: { key: 'y3', dir: 'desc' }, // default: best 3Y first
};

// ---- formatting helpers ----------------------------------------------------
const pct = (x, dp = 1) => (x == null ? null : (x * 100).toFixed(dp) + '%');
const signed = (x, dp = 1) => (x == null ? null : (x >= 0 ? '+' : '') + (x * 100).toFixed(dp));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

// Colour class for a return-style value: emerald up / rose down / slate flat.
const signClass = (x) => (x == null ? 'v-na' : x > 0.00005 ? 'v-pos' : x < -0.00005 ? 'v-neg' : 'v-zero');

// ---- column definitions ----------------------------------------------------
// type drives both the cell renderer and the sort comparator.
const COLUMNS = [
  { key: 'name', label: 'Fund', type: 'text', get: (f) => f.name },
  { key: 'amc', label: 'AMC', type: 'text', get: (f) => f.amc || '' },
  { key: 'category', label: 'Category', type: 'cat', get: (f) => f.category },
  { key: 'aum', label: 'AUM', type: 'soon' },
  { key: 'ter', label: 'TER', type: 'soon' },
  { key: 'y1', label: '1Y', type: 'ret', get: (f) => f.returns.y1 },
  { key: 'y3', label: '3Y', type: 'ret', get: (f) => f.returns.y3 },
  { key: 'y5', label: '5Y', type: 'ret', get: (f) => f.returns.y5 },
  { key: 'y10', label: '10Y', type: 'ret', get: (f) => f.returns.y10 },
  { key: 'roll3y', label: '3Y Roll', type: 'ret', title: 'Average of 3-year rolling returns (monthly window starts)', get: (f) => (f.rolling.y3 ? f.rolling.y3.avg : null) },
  { key: 'vs5y', label: '5Y vs Cat', type: 'vs', title: 'This fund\'s 5Y CAGR vs its category mean (× and percentage-point gap)', get: (f) => f.vsCategory.y5, sortGet: (f) => f.vsCategory.y5 && f.vsCategory.y5.ppGap },
  { key: 'sharpe', label: 'Sharpe', type: 'sharpe', title: '3Y risk-adjusted return (higher is better)', get: (f) => f.risk.sharpe },
  { key: 'vol', label: 'Volatility', type: 'volpct', title: 'Annualised volatility over a 3Y lookback (lower is calmer)', get: (f) => f.risk.volatility },
  { key: 'maxdd', label: 'Max DD', type: 'ddpct', title: 'Largest peak-to-trough fall over the 3Y lookback', get: (f) => f.risk.maxDrawdown },
];

// ---- cell renderers --------------------------------------------------------
function renderCell(col, f) {
  switch (col.type) {
    case 'text':
      return `<td class="px-3 py-2.5 ${col.key === 'name' ? 'font-semibold text-slate-800' : 'text-slate-500'}">${esc(col.get(f))}</td>`;
    case 'cat': {
      const c = CAT_COLOR[f.category] || '#64748b';
      return `<td class="px-3 py-2.5"><span class="pill" style="background:${c}1a;color:${c}">${esc(f.category)}</span></td>`;
    }
    case 'soon':
      return `<td class="num px-3 py-2.5"><span class="v-dim" title="coming soon">—</span></td>`;
    case 'ret': {
      const v = col.get(f);
      return `<td class="num px-3 py-2.5 ${signClass(v)} v-strong">${v == null ? '<span class="v-na">N/A</span>' : esc(pct(v))}</td>`;
    }
    case 'volpct': {
      const v = col.get(f);
      return `<td class="num px-3 py-2.5 text-slate-600">${v == null ? '<span class="v-na">N/A</span>' : esc(pct(v))}</td>`;
    }
    case 'ddpct': {
      const v = col.get(f);
      return `<td class="num px-3 py-2.5 ${v == null ? '' : 'v-neg'}">${v == null ? '<span class="v-na">N/A</span>' : esc(pct(v))}</td>`;
    }
    case 'sharpe': {
      const v = col.get(f);
      const cls = v == null ? 'v-na' : v >= 1 ? 'v-pos' : v >= 0 ? 'v-zero' : 'v-neg';
      return `<td class="num px-3 py-2.5 ${cls} v-strong">${v == null ? '<span class="v-na">N/A</span>' : esc(v.toFixed(2))}</td>`;
    }
    case 'vs': {
      const vs = col.get(f);
      if (!vs || vs.ratio == null) return `<td class="num px-3 py-2.5"><span class="v-na">N/A</span></td>`;
      const cls = vs.ppGap > 0.00005 ? 'badge-up' : vs.ppGap < -0.00005 ? 'badge-down' : 'badge-flat';
      return `<td class="num px-3 py-2.5"><span class="badge ${cls}">${vs.ratio.toFixed(2)}× <span style="opacity:.8">${esc(signed(vs.ppGap))}pp</span></span></td>`;
    }
    default:
      return '<td class="px-3 py-2.5"></td>';
  }
}

// ---- sorting ---------------------------------------------------------------
function comparator(col, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  const getter = col.sortGet || col.get;
  if (col.type === 'text' || col.type === 'cat') {
    return (a, b) => mul * String(getter(a)).localeCompare(String(getter(b)));
  }
  // Numeric: nulls always sort to the bottom regardless of direction.
  return (a, b) => {
    const va = getter(a), vb = getter(b);
    const na = va == null || !isFinite(va), nb = vb == null || !isFinite(vb);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return mul * (va - vb);
  };
}

// ---- rendering -------------------------------------------------------------
function renderHead() {
  const head = document.getElementById('table-head');
  head.innerHTML = COLUMNS.map((col) => {
    const sortable = col.type !== 'soon';
    const isActive = state.sort.key === col.key;
    const caret = !sortable ? '' : isActive ? (state.sort.dir === 'asc' ? 'sort-asc' : 'sort-desc') : 'sort-caret';
    const align = (col.type === 'text' || col.type === 'cat') ? '' : 'num';
    const cls = `px-3 py-2.5 ${align} ${sortable ? 'sortable' : ''} ${caret} ${isActive ? 'text-indigo-600' : ''}`;
    const title = col.title ? ` title="${esc(col.title)}"` : '';
    return `<th class="${cls}" data-key="${col.key}"${title}>${esc(col.label)}</th>`;
  }).join('');

  head.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const col = COLUMNS.find((c) => c.key === key);
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.key = key;
        // text defaults ascending (A–Z); numbers default descending (best first).
        state.sort.dir = (col.type === 'text' || col.type === 'cat') ? 'asc' : 'desc';
      }
      renderHead();
      renderBody();
    });
  });
}

function visibleFunds() {
  const q = state.search.trim().toLowerCase();
  let rows = state.funds.filter((f) => {
    if (state.filterCategory && f.category !== state.filterCategory) return false;
    if (q && !(f.name.toLowerCase().includes(q) || (f.amc || '').toLowerCase().includes(q))) return false;
    return true;
  });
  const col = COLUMNS.find((c) => c.key === state.sort.key) || COLUMNS[0];
  rows.sort(comparator(col, state.sort.dir));
  return rows;
}

function renderBody() {
  const rows = visibleFunds();
  const body = document.getElementById('table-body');
  document.getElementById('result-count').textContent =
    `${rows.length} fund${rows.length === 1 ? '' : 's'}`;

  if (rows.length === 0) {
    body.innerHTML = `<tr><td class="p-8 text-center text-slate-400" colspan="${COLUMNS.length}">No funds match your filters.</td></tr>`;
    return;
  }
  // Build the whole tbody as one HTML string — fast even for ~600 rows.
  body.innerHTML = rows.map((f) => `<tr>${COLUMNS.map((c) => renderCell(c, f)).join('')}</tr>`).join('');
}

function renderCategoryOptions() {
  const sel = document.getElementById('category-select');
  const cats = Object.keys(state.categories).sort();
  for (const cat of cats) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = `${cat} (${state.categories[cat].n})`;
    sel.appendChild(opt);
  }
}

function tile(label, value, accent = '#4f46e5', sub = '') {
  return `<div class="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
    <div class="text-xs font-medium text-slate-400">${esc(label)}</div>
    <div class="mt-0.5 font-display text-xl font-extrabold tnum" style="color:${accent}">${esc(value)}</div>
    ${sub ? `<div class="mt-0.5 text-[11px] text-slate-400">${esc(sub)}</div>` : ''}
  </div>`;
}

function renderStatus() {
  const s = state.status;
  const c = s.counts;
  const rf = s.riskFreeRate;
  document.getElementById('updated-chip').textContent = `Updated ${fmtDate(s.data_as_of)}`;
  document.getElementById('sources-line').innerHTML =
    s.sources.map((src) => `<a href="${esc(src.url)}" target="_blank" rel="noopener" class="underline decoration-dotted hover:text-indigo-500">${esc(src.name)}</a> <span class="text-slate-300">(as of ${esc(fmtDate(src.asOf))})</span>`).join(' · ');

  document.getElementById('status-grid').innerHTML = [
    tile('Equity funds', String(c.equityDirectGrowth), '#4f46e5', 'Direct · Growth'),
    tile('≥ 3Y history', String(c.with3y), '#0ea5e9'),
    tile('≥ 5Y history', String(c.with5y), '#8b5cf6'),
    tile('≥ 10Y history', String(c.with10y), '#d946ef'),
    tile('Categories', String(Object.keys(state.categories).length), '#10b981'),
    tile('Risk-free rate', pct(rf.annual_rate, 2), '#f59e0b', 'Sharpe input'),
  ].join('');

  document.getElementById('status-note').innerHTML =
    `Risk-free rate ${esc(pct(rf.annual_rate, 2))} — ${esc(rf.source)}, as of ${esc(fmtDate(rf.as_of))}. ` +
    `${c.failures} fund${c.failures === 1 ? '' : 's'} skipped this run. ` +
    `Generated ${esc(new Date(s.generated_at).toUTCString())}. ` +
    `Category averages cover Direct-Growth funds only; figures with insufficient history show N/A.`;
}

function wireControls() {
  document.getElementById('category-select').addEventListener('change', (e) => {
    state.filterCategory = e.target.value;
    renderBody();
  });
  let t;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.search = e.target.value; renderBody(); }, 120);
  });
}

function showError(msg) {
  document.getElementById('table-body').innerHTML =
    `<tr><td class="p-8 text-center text-rose-500" colspan="${COLUMNS.length}">${esc(msg)}</td></tr>`;
}

async function init() {
  try {
    const [funds, categories, status] = await Promise.all(
      Object.values(DATA).map(async (u) => {
        const r = await fetch(u, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`);
        return r.json();
      }),
    );
    state.funds = funds;
    state.categories = categories;
    state.status = status;

    renderCategoryOptions();
    renderHead();
    renderBody();
    renderStatus();
    wireControls();
  } catch (err) {
    console.error(err);
    showError('Could not load fund data. Please try again shortly.');
    document.getElementById('updated-chip').textContent = 'Data unavailable';
  }
}

init();
