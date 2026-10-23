// alerts.js — the 🔔 "What's New" bell + panel + full view. Reads the committed alerts.json
// (state.alerts); unread = events newer than the last-seen marker kept in localStorage.

import { state } from './state.js';
import { esc, ICON } from './meta.js';

const SEV_COLOR = { info: '#64748b', notable: '#6366f1', warning: '#f59e0b' };
const TYPE_LABEL = {
  NEW_FUND: 'New fund', FUND_CLOSED: 'Closed', MANAGER_CHANGE: 'Manager', RECATEGORIZED: 'Recategorised',
  BENCHMARK_CHANGE: 'Benchmark', TER_CHANGE: 'Fees', RISKOMETER_CHANGE: 'Risk rating', EXIT_LOAD_CHANGE: 'Exit load',
  AUM_MOVE: 'Fund size', BIG_NAV_MOVE: 'NAV move', HISTORY_MILESTONE: 'Milestone', DATA_HEALTH: 'Data health', TRACKING_STARTED: 'Info',
  UNIVERSE_EXPANDED: 'Universe',
};
let openDetailFn = null;
export function setAlertsDetailHandler(fn) { openDetailFn = fn; }
let typeFilter = null;

const events = () => (state.alerts && state.alerts.events) || [];
function lastSeen() { try { return localStorage.getItem('mfs.alerts.lastSeen'); } catch { return null; } }
function markSeen() { try { const e = events(); if (e.length) localStorage.setItem('mfs.alerts.lastSeen', e[0].id); } catch { /* ignore */ } updateBadge(); }
export function unreadCount() {
  const e = events(); if (!e.length) return 0;
  const s = lastSeen(); if (!s) return Math.min(e.length, 99);
  const idx = e.findIndex((x) => x.id === s);
  return idx < 0 ? Math.min(e.length, 99) : idx;
}

function relTime(dateStr) {
  const now = (state.status && state.status.data_as_of) || new Date().toISOString().slice(0, 10);
  const days = Math.round((Date.parse(now) - Date.parse(dateStr)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  return Math.round(days / 30) + 'mo ago';
}

function eventRow(e, unread) {
  const col = SEV_COLOR[e.severity] || '#64748b';
  const clickable = e.schemeCode ? `data-code="${e.schemeCode}" class="alert-row w-full cursor-pointer text-left"` : 'class="alert-row w-full text-left"';
  return `<button ${clickable}><div class="flex gap-2.5 px-3 py-2.5 hover:bg-slate-50 ${unread ? 'bg-indigo-50/40' : ''}">
    <span class="mt-1 h-2 w-2 shrink-0 rounded-full" style="background:${col}"></span>
    <div class="min-w-0 flex-1"><div class="text-sm font-medium leading-snug text-slate-700">${esc(e.title)}</div>
      ${e.detail ? `<div class="mt-0.5 text-xs text-slate-500">${esc(e.detail)}</div>` : ''}
      <div class="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">${esc(TYPE_LABEL[e.type] || e.type)} · ${relTime(e.date)}</div></div>
    ${unread ? '<span class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500"></span>' : ''}</div></button>`;
}

export function updateBadge() {
  const b = document.getElementById('bell-badge');
  if (!b) return;
  const n = unreadCount();
  b.textContent = n > 99 ? '99+' : n;
  b.classList.toggle('hidden', n === 0);
}

export function openBell() {
  const root = document.getElementById('bell-root');
  const ev = events();
  const seenId = lastSeen();
  let unreadIdx = seenId ? ev.findIndex((x) => x.id === seenId) : ev.length;
  if (unreadIdx < 0) unreadIdx = ev.length; // seen marker rolled off the feed → treat all as unread (mirror unreadCount)
  const recent = ev.slice(0, 20);
  const body = recent.length
    ? recent.map((e, i) => eventRow(e, i < unreadIdx)).join('')
    : `<div class="px-4 py-10 text-center text-sm text-slate-400">${ICON.star}<div class="mt-2">Nothing new yet. Changes to funds — managers, fees, risk, big NAV moves — will show up here each day.</div></div>`;
  root.innerHTML = `<div class="bell-backdrop fixed inset-0 z-[55]"></div>
    <div class="absolute right-0 top-11 z-[56] w-[360px] max-w-[92vw] overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
      <div class="flex items-center justify-between border-b border-slate-100 px-3 py-2.5"><h3 class="font-display text-sm font-bold text-slate-700">What’s new</h3>
        <div class="flex gap-1.5"><button id="bell-read" class="rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-200">Mark all read</button>
        <button id="bell-all" class="rounded-lg bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-600 hover:bg-indigo-100">See all</button></div></div>
      <div class="max-h-[60vh] divide-y divide-slate-50 overflow-y-auto">${body}</div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.bell-backdrop').addEventListener('click', close);
  root.querySelector('#bell-read').addEventListener('click', () => { markSeen(); close(); });
  root.querySelector('#bell-all').addEventListener('click', () => { close(); openAlertsModal(); });
  root.querySelectorAll('.alert-row[data-code]').forEach((b) => b.addEventListener('click', () => { const f = state.funds.find((x) => x.schemeCode === +b.dataset.code); markSeen(); close(); if (f && openDetailFn) openDetailFn(f); }));
  markSeen();
}

export function openAlertsModal() {
  const modal = document.getElementById('modal-root');
  const ev = events();
  const types = [...new Set(ev.map((e) => e.type))];
  const filtered = typeFilter ? ev.filter((e) => e.type === typeFilter) : ev;
  // group by date
  const byDate = {};
  for (const e of filtered) (byDate[e.date] = byDate[e.date] || []).push(e);
  const groups = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]));
  const chips = `<button data-tf="" class="alert-chip ${!typeFilter ? 'alert-chip-on' : ''}">All</button>` + types.map((t) => `<button data-tf="${t}" class="alert-chip ${typeFilter === t ? 'alert-chip-on' : ''}">${esc(TYPE_LABEL[t] || t)}</button>`).join('');
  const bodyHtml = groups.length
    ? groups.map(([date, list]) => `<div><div class="sticky top-0 bg-white/90 px-1 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400 backdrop-blur">${esc(date)}</div><div class="divide-y divide-slate-50 rounded-xl ring-1 ring-slate-100">${list.map((e) => eventRow(e, false)).join('')}</div></div>`).join('')
    : `<div class="py-12 text-center text-sm text-slate-400">No events${typeFilter ? ' of this type' : ''} in the last 90 days.</div>`;
  modal.innerHTML = `<div class="modal-backdrop fixed inset-0 z-[60] grid place-items-center bg-slate-900/40 p-4">
    <div class="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl bg-white shadow-2xl">
      <div class="flex items-center justify-between border-b border-slate-100 p-4"><h2 class="flex items-center gap-2 font-display text-lg font-bold text-slate-800">🔔 What’s new <span class="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-600">${ev.length}</span></h2>
        <button class="modal-x rounded-lg p-1 text-slate-400 hover:bg-slate-100">${ICON.close}</button></div>
      <div class="flex flex-wrap gap-1.5 border-b border-slate-100 p-3">${chips}</div>
      <div class="space-y-3 overflow-y-auto p-4">${bodyHtml}</div></div></div>`;
  const close = () => { modal.innerHTML = ''; };
  modal.querySelector('.modal-x').addEventListener('click', close);
  modal.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) close(); });
  modal.querySelectorAll('[data-tf]').forEach((b) => b.addEventListener('click', () => { typeFilter = b.dataset.tf || null; openAlertsModal(); }));
  modal.querySelectorAll('.alert-row[data-code]').forEach((b) => b.addEventListener('click', () => { const f = state.funds.find((x) => x.schemeCode === +b.dataset.code); close(); if (f && openDetailFn) openDetailFn(f); }));
}
