// Shared UI behaviour + table helpers for the 3 dashboards (source: dashboards/shared/, copied by sync-shared.ps1).
// Loaded before app.js. Section 0 defines globals every app.js uses; the app supplies `state`
// (sort / filters / pageLimit per table type) and renderTable(type).

// 0) App helpers: error boundary, toast, SSE reader, sort / paging / filters
window.onerror = function(msg, src, line, col, err) {
  const el = document.getElementById('toast');
  if (el) { el.textContent = 'Error: ' + msg; el.className = 'show error'; setTimeout(() => el.className = '', 5000); }
  console.error('Unhandled error:', msg, src, line, col, err);
  return true;
};
window.onunhandledrejection = function(e) {
  const msg = e.reason?.message || String(e.reason);
  const el = document.getElementById('toast');
  if (el) { el.textContent = 'Error: ' + msg; el.className = 'show error'; setTimeout(() => el.className = '', 5000); }
  console.error('Unhandled rejection:', e.reason);
};

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PAGE_SIZE = 20; // rows per page; "Show more" adds another page
const PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
// Date columns keep the day as a number (YYYYMMDD) so sort and the column filter treat it like a metric.
const dateNum = iso => /^\d{4}-\d{2}-\d{2}/.test(iso || '') ? Number(iso.slice(0, 10).replace(/-/g, '')) : 0;
const numIso = n => { const s = String(n); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : ''; };
const fmtDay = n => n ? new Date(numIso(n) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
// Operators of a date column: the ones Shopify's report filter offers on a date dimension (measured 2026-11-16)
const DATE_OPS = [['gt', 'after'], ['lt', 'before'], ['gte', 'after or on'], ['lte', 'before or on']];
// operators per kind of column = Shopify report filters (measured 2026-11-19)
const TEXT_OPS = [['contains', 'contains'], ['notContains', 'does not contain'], ['eq', 'is'], ['ne', 'is not']];
const NUM_OPS = [['eq', 'is'], ['ne', 'is not'], ['between', 'between'], ['gt', 'greater than'], ['lt', 'less than'], ['gte', 'greater than or equal to'], ['lte', 'less than or equal to']];
const empty = cols => `<tr><td colspan="${cols}"><div class="state-box">No data</div></td></tr>`;

let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3500);
}

// Error detail from the server: text, or an object with a message (Meta async report details)
function formatErrorDetail(detail) {
  if (detail == null || detail === '') return '';
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'object') {
    if (detail.message) return detail.message;
    try { return JSON.stringify(detail); } catch { return String(detail); }
  }
  return String(detail);
}

// Error for a non-2xx answer: the server's { error, detail } when it sent JSON, else the HTTP status
async function httpError(res) {
  const text = await res.text().catch(() => '');
  let body;
  try { body = JSON.parse(text); } catch { body = text || null; }
  const err = new Error(body?.error || `HTTP ${res.status} ${res.statusText}`);
  Object.assign(err, { status: res.status, statusText: res.statusText, body, detail: body?.detail });
  return err;
}

// "Refreshed today at 3:28 PM" / "Refreshed yesterday at …" / "Refreshed Nov 17 at …" (Shopify report title bar)
function refreshedText(iso) {
  const d = new Date(iso), day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 864e5);
  const when = diff === 0 ? 'today' : diff === 1 ? 'yesterday' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  return `Refreshed ${when} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

// Load buttons are locked while a load runs: one load at a time per page (a second browser
// asking for the same data joins the running load on the server)
function lockLoadButtons(locked) {
  $$('.topbar-actions .btn, .topbar-actions .drp-btn').forEach(b => { b.disabled = locked; });
}

// /api/dashboard is an event stream: onMessage(obj) runs for every "data: {json}" line.
async function readSSE(res, onMessage) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let msg;
      try { msg = JSON.parse(line.slice(6)); }
      catch (e) { console.warn('[SSE parse error]', e.message, 'on line:', line); continue; }
      onMessage(msg);
    }
  }
}

function sortTable(type, key) {
  const s = state.sort[type];
  s.dir = s.key === key ? s.dir * -1 : 1;
  s.key = key;
  state.pageLimit[type] = PAGE_SIZE;
  renderTable(type);
}

function showMore(type) {
  state.pageLimit[type] += PAGE_SIZE;
  renderTable(type);
}

// Re-filter + re-render (called from the Filters in the Controls panel)
function filterTable(type) {
  state.pageLimit[type] = PAGE_SIZE;
  renderTable(type);
}

// Rows matching every filter of the Controls panel (state.filters[type])
function applyFilters(type, rows) {
  const filters = Object.entries(state.filters[type]);
  if (!filters.length) return rows;
  return rows.filter(row => {
    for (const [col, f] of filters) {
      if (f.kind === 'select') { // value(s) of a list ('__none__' = empty); is / is one of, is not / is not one of
        const isIn = [].concat(f.val1).includes(String(row[col] || '__none__'));
        if (f.op === 'is' || f.op === 'isOneOf' ? !isIn : isIn) return false;
        continue;
      }
      if (f.kind === 'text') {
        const s = String(row[col] || '').toLowerCase(), q = String(f.val1).toLowerCase();
        const ok = f.op === 'contains' ? s.includes(q) : f.op === 'notContains' ? !s.includes(q) : f.op === 'eq' ? s === q : s !== q;
        if (!ok) return false;
        continue;
      }
      const v = parseFloat(row[col] || 0);
      if (f.kind === 'date' && !v) return false; // no date: never matches a date filter
      // "is" / "is not" on numbers shown with 2 decimals at most
      if (f.op === 'eq' && !(Math.abs(v - f.val1) < 0.005)) return false;
      if (f.op === 'ne' && Math.abs(v - f.val1) < 0.005) return false;
      if (f.op === 'gte' && !(v >= f.val1)) return false;
      if (f.op === 'lte' && !(v <= f.val1)) return false;
      if (f.op === 'gt' && !(v > f.val1)) return false;
      if (f.op === 'lt' && !(v < f.val1)) return false;
      if (f.op === 'between' && !(v >= f.val1 && v <= f.val2)) return false;
      if (f.op === 'notBetween' && !(v < f.val1 || v > f.val2)) return false;
    }
    return true;
  });
}

// 1) Topbar: transparent at the top of the page, white + 1px line once scrolled (Shopify page-header).
(() => {
  const update = () => document.body.classList.toggle('scrolled', window.scrollY > 0);
  window.addEventListener('scroll', update, { passive: true });
  update();
})();

// 2) Shopify-style dropdown over native <select>.
// The native select stays in the DOM (hidden) as the source of truth: app code
// keeps reading/writing .value and listening to onchange. A pill button + menu
// mirror it; option changes (innerHTML/text) and programmatic .value writes re-render.
(() => {
  const ICONS = {
    calendar: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="4.5" width="13" height="12" rx="2.5"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/></svg>',
    compare:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 4.5 16 7l-2.5 2.5M16 7H6.5a2.5 2.5 0 0 0-2.5 2.5M6.5 15.5 4 13l2.5-2.5M4 13h9.5a2.5 2.5 0 0 0 2.5-2.5"/></svg>',
    person:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="7" r="3"/><path d="M4.5 16c.8-2.6 3-4 5.5-4s4.7 1.4 5.5 4"/></svg>',
  };
  const CHECK = '<svg class="dd-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 10.5 3.2 3L15 6.5"/></svg>';
  const CHEVRON = '<svg class="dd-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m6 8 4 4 4-4"/></svg>';
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  let openDd = null;

  function close(dd) {
    if (!dd) return;
    dd.classList.remove('open');
    dd.querySelector('.dd-menu').hidden = true;
    if (openDd === dd) openDd = null;
  }

  function enhance(sel) {
    if (sel.closest('.dd')) return;
    const dd = document.createElement('div');
    dd.className = `dd dd-${sel.id || 'select'}${sel.dataset.dd ? ' dd-' + sel.dataset.dd : ''}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    for (const a of ['data-tip', 'data-tip-title']) if (sel.hasAttribute(a)) btn.setAttribute(a, sel.getAttribute(a));
    const menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.hidden = true;
    sel.parentNode.insertBefore(dd, sel);
    dd.append(btn, menu, sel);
    sel.hidden = true;

    const render = () => {
      const cur = sel.options[sel.selectedIndex];
      const icon = ICONS[sel.dataset.icon] || '';
      btn.innerHTML = `${icon}<span class="dd-label"></span>${CHEVRON}`;
      btn.querySelector('.dd-label').textContent = cur ? cur.textContent : '';
      menu.innerHTML = '';
      for (const opt of sel.options) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dd-item' + (opt.selected ? ' selected' : '');
        item.textContent = opt.textContent;
        if (opt.selected) item.insertAdjacentHTML('beforeend', CHECK);
        item.addEventListener('click', () => {
          close(dd);
          if (sel.value === opt.value) return;
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        menu.appendChild(item);
      }
    };

    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); render(); },
    });
    new MutationObserver(render).observe(sel, { childList: true, subtree: true, characterData: true });

    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (dd.classList.contains('open')) return close(dd);
      close(openDd);
      dd.classList.add('open');
      menu.hidden = false;
      menu.style.left = ''; menu.style.right = '';
      if (menu.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
        menu.style.left = 'auto'; menu.style.right = '0';
      }
      openDd = dd;
    });
    menu.addEventListener('click', e => e.stopPropagation());
    render();
  }

  document.addEventListener('click', () => close(openDd));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(openDd); });
  document.querySelectorAll('select').forEach(enhance);
})();

// 3) Tooltips like Shopify admin: dark card, bold title + description, below the element
//    (above when there is no room). Any element with data-tip (and optional data-tip-title).
(() => {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  let cur = null;
  const hide = () => { tip.hidden = true; cur = null; };
  const show = el => {
    cur = el;
    tip.innerHTML = '';
    const t = el.getAttribute('data-tip-title');
    if (t) { const h = document.createElement('div'); h.className = 'tip-title'; h.textContent = t; tip.appendChild(h); }
    const b = document.createElement('div'); b.className = 'tip-body'; b.textContent = el.getAttribute('data-tip'); tip.appendChild(b);
    tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, vw = document.documentElement.clientWidth;
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    tip.style.top = top + 'px';
    tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8)) + 'px';
  };
  // Sortable column name without its own tip: the order a click gives (Shopify "Highest to lowest"),
  // a small label above the header
  const showSort = el => {
    cur = el;
    const th = el.closest('th'), type = th.closest('table').id.replace(/Table$/, '');
    const desc = !(th.classList.contains('sorted') && state.sort[type]?.dir === 1);
    const order = desc ? 'highest to lowest' : 'lowest to highest';
    const label = el.querySelector('.th-label');
    const cut = label && label.scrollWidth > label.clientWidth;
    tip.className = cut ? 'tip tip-sm tip-wrap' : 'tip tip-sm';
    tip.textContent = cut ? `${label.textContent}, ${order}` : order[0].toUpperCase() + order.slice(1);
    tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.top = Math.max(8, r.top - h - 6) + 'px';
    tip.style.left = Math.max(8, r.left + r.width / 2 - w / 2) + 'px';
  };
  // Table cell whose text ends in … (fixed column, shared.css): the full text above it (Shopify product
  // title cell, 2026-11-20); a link gives its whole address
  const cutOf = t => {
    const cell = t.closest && t.closest('tbody td, .link-cell');
    const x = cell && (cell.querySelector('.link-cell') || cell);
    return x && x.scrollWidth > x.clientWidth ? x : null;
  };
  const showCut = x => {
    cur = x;
    tip.className = 'tip tip-sm tip-wrap';
    tip.textContent = x.matches('a[href]') ? x.href : x.textContent.trim();
    tip.hidden = false;
    const r = x.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, vw = document.documentElement.clientWidth;
    tip.style.top = Math.max(8, r.top - h - 6) + 'px';
    tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8)) + 'px';
  };
  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    const sortEl = !el && e.target.closest && e.target.closest('thead th[data-sort] .th-content');
    const cutEl = !el && !sortEl && cutOf(e.target);
    if (el && el !== cur) { tip.className = 'tip'; show(el); }
    else if (sortEl && sortEl !== cur) showSort(sortEl);
    else if (cutEl && cutEl !== cur) showCut(cutEl);
    else if (!el && !sortEl && !cutEl && cur) hide();
  });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', hide);
})();

// 4) Date range picker = Shopify Analytics date picker (measured 2026-11-19): grey pill button;
//    popover with a #f7f7f7 sidebar (Today, Yesterday | Last, Period to date | Quarters | Custom range;
//    Shopify's Black Friday / Cyber Monday left out, user 2026-11-19), the chosen option's controls
//    ("Last [30] [Days] [x] Include today"), two months, and a footer with the dates + Cancel / Apply.
//    The choice is kept per dashboard (localStorage) as a rule, so "Last 30 days" moves with the
//    calendar. DateRange.mount returns { get } → { since, until, label, key }.
const DateRange = (() => {
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const fmt = (d, yr = true) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(yr ? { year: 'numeric' } : {}) });
  const rangeText = (a, b) => {
    if (a === b) return fmt(parse(a));
    const A = parse(a), B = parse(b);
    return A.getFullYear() === B.getFullYear() ? `${fmt(A, false)} – ${fmt(B)}` : `${fmt(A)} – ${fmt(B)}`;
  };
  const TODATE = { week: 'Week to date', month: 'Month to date', quarter: 'Quarter to date', year: 'Year to date' };
  const UNITS = { days: 'day', weeks: 'week', months: 'month' };
  const DEFAULT = { mode: 'last', n: 30, unit: 'days', today: true };

  function resolve(s) {
    const t = today0();
    let a, b = t, label;
    switch (s.mode) {
      case 'today': a = t; label = 'Today'; break;
      case 'yesterday': a = b = addDays(t, -1); label = 'Yesterday'; break;
      case 'last': {
        const n = Math.max(1, Math.floor(s.n) || 1);
        // Shopify counts back from today, then drops today when "Include today" is off:
        // Last 30 days on Nov 19 = Oct 20 – Nov 19 (measured 2026-11-19)
        b = s.today ? t : addDays(t, -1);
        if (s.unit === 'weeks') a = addDays(t, -7 * n);
        else if (s.unit === 'months') a = new Date(t.getFullYear(), t.getMonth() - n, t.getDate());
        else a = addDays(t, -n);
        label = `Last ${n} ${n === 1 ? UNITS[s.unit] : s.unit}`;
        break;
      }
      case 'todate': {
        const p = s.period;
        a = p === 'week' ? addDays(t, -t.getDay())
          : p === 'month' ? new Date(t.getFullYear(), t.getMonth(), 1)
          : p === 'quarter' ? new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1)
          : new Date(t.getFullYear(), 0, 1);
        label = TODATE[p];
        break;
      }
      case 'quarter': {
        a = new Date(s.y, (s.q - 1) * 3, 1);
        const end = new Date(s.y, s.q * 3, 0);
        b = end > t ? t : end;
        label = `Q${s.q} ${s.y}`;
        break;
      }
      default: { // custom
        a = parse(s.since); b = parse(s.until);
        if (b > t) b = t;
        if (a > b) a = b;
        label = rangeText(iso(a), iso(b));
      }
    }
    const since = iso(a), until = iso(b);
    return { since, until, label, key: `${since}_${until}` };
  }

  const ICON_CAL = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="4.5" width="13" height="12" rx="2.5"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/></svg>';
  const CHEVRON = '<svg class="dd-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m6 8 4 4 4-4"/></svg>';
  const ARROW = d => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const CHECK = '<svg class="drp-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 10.5 3.2 3L15 6.5"/></svg>';

  // isLoaded(range) / onLoad(range): the footer button reads "Load Data" (and loads) when the chosen
  // range has no saved result yet or is the range on screen (refresh); "Apply" otherwise.
  function mount(host, { storageKey, onChange, isLoaded, onLoad, tip }) {
    let cur;
    try { cur = JSON.parse(localStorage.getItem(storageKey)) || DEFAULT; } catch { cur = DEFAULT; }
    if (!cur.mode) cur = DEFAULT;
    let draft = null, view = null, picking = false, hover = null;

    host.classList.add('drp');
    host.innerHTML = `<button type="button" class="dd-btn drp-btn"${tip ? ` data-tip-title="${esc(tip[0])}" data-tip="${esc(tip[1])}"` : ''}>${ICON_CAL}<span class="dd-label"></span>${CHEVRON}</button>`
      + '<div class="drp-pop" hidden><div class="drp-side"></div><div class="drp-main"><div class="drp-body"><div class="drp-controls"></div><div class="drp-cal"></div></div>'
      + '<div class="drp-foot"><span class="drp-range"></span><span class="drp-sp"></span><button type="button" class="drp-cancel">Cancel</button><button type="button" class="drp-apply">Apply</button></div></div></div>';
    const btn = host.querySelector('.drp-btn'), pop = host.querySelector('.drp-pop');
    const side = host.querySelector('.drp-side'), controls = host.querySelector('.drp-controls'), cal = host.querySelector('.drp-cal');
    const applyBtn = host.querySelector('.drp-apply');

    const label = () => { btn.querySelector('.dd-label').textContent = resolve(cur).label; };
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

    function renderSide() {
      const it = (m, text) => `<li><button type="button" class="drp-opt${draft.mode === m ? ' on' : ''}" data-m="${m}"><span>${text}</span>${draft.mode === m ? CHECK : ''}</button></li>`;
      side.innerHTML = `<ul>${it('today', 'Today')}${it('yesterday', 'Yesterday')}</ul><hr>`
        + `<ul>${it('last', 'Last')}${it('todate', 'Period to date')}</ul><hr>`
        + `<ul>${it('quarter', 'Quarters')}</ul><hr><ul>${it('custom', 'Custom range')}</ul>`;
    }

    function renderControls() {
      const r = resolve(draft);
      let h = '';
      if (draft.mode === 'last') {
        h = `<span>Last</span><input class="drp-input drp-n" type="number" min="1" value="${draft.n}">`
          + `<select class="drp-select drp-unit">${Object.keys(UNITS).map(u => `<option value="${u}"${u === draft.unit ? ' selected' : ''}>${u[0].toUpperCase() + u.slice(1)}</option>`).join('')}</select>`
          + `<label class="drp-cb"><input type="checkbox" class="drp-today"${draft.today ? ' checked' : ''}><span class="rp-box"></span>Include today</label>`;
      } else if (draft.mode === 'todate') {
        h = `<select class="drp-select drp-period">${Object.entries(TODATE).map(([k, v]) => `<option value="${k}"${k === draft.period ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
      } else if (draft.mode === 'quarter') {
        const t = today0(), opts = [];
        let y = t.getFullYear(), q = Math.floor(t.getMonth() / 3) + 1;
        for (let i = 0; i < 8; i++) { opts.push([y, q]); if (--q === 0) { q = 4; y--; } }
        h = `<select class="drp-select drp-q">${opts.map(([y, q]) => `<option value="${y}-${q}"${y === draft.y && q === draft.q ? ' selected' : ''}>Q${q} ${y}</option>`).join('')}</select>`;
      } else if (draft.mode === 'custom') {
        h = `<input class="drp-input drp-date drp-since" value="${r.since}" placeholder="YYYY-MM-DD"><span class="drp-arrow">${ARROW('M4 10h12M11 5l5 5-5 5')}</span><input class="drp-input drp-date drp-until" value="${r.until}" placeholder="YYYY-MM-DD">`;
      }
      controls.innerHTML = h;
      controls.hidden = !h;
    }

    function renderCal() {
      const r = resolve(draft), t = iso(today0());
      let lo = r.since, hi = r.until;
      if (picking && hover) { lo = draft.since < hover ? draft.since : hover; hi = draft.since < hover ? hover : draft.since; }
      const month = (y, m, nav) => {
        const lead = new Date(y, m, 1).getDay(), n = new Date(y, m + 1, 0).getDate();
        const cells = Array(lead).fill('<span class="drp-cell"></span>');
        for (let d = 1; d <= n; d++) {
          const day = `${y}-${pad(m + 1)}-${pad(d)}`, fut = day > t;
          const inR = day >= lo && day <= hi, edge = day === lo || day === hi;
          const cls = ['drp-cell', inR && 'in', day === lo && 'start', day === hi && 'end'].filter(Boolean).join(' ');
          cells.push(`<span class="${cls}"><button type="button" class="drp-day${edge ? ' sel' : ''}" data-d="${day}"${fut ? ' disabled' : ''}>${d}</button></span>`);
        }
        const title = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long' });
        const prev = nav < 0 ? `<button type="button" class="drp-nav" data-step="-1" aria-label="Previous month">${ARROW('m12 5-5 5 5 5')}</button>` : '<span></span>';
        const next = nav > 0 ? `<button type="button" class="drp-nav" data-step="1" aria-label="Next month">${ARROW('m8 5 5 5-5 5')}</button>` : '<span></span>';
        return `<div class="drp-month"><div class="drp-mhead">${prev}<span class="drp-mtitle"><span>${title}</span><span>${y}</span></span>${next}</div>`
          + `<div class="drp-grid">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(w => `<span class="drp-wd">${w}</span>`).join('')}${cells.join('')}</div></div>`;
      };
      const left = new Date(view.getFullYear(), view.getMonth() - 1, 1);
      cal.innerHTML = month(left.getFullYear(), left.getMonth(), -1) + month(view.getFullYear(), view.getMonth(), 1);
      host.querySelector('.drp-range').textContent = picking ? `${fmt(parse(draft.since))} – …` : rangeText(r.since, r.until);
      const load = !!onLoad && (same(draft, cur) || !isLoaded(r));
      applyBtn.textContent = load ? 'Load Data' : 'Apply';
      applyBtn.dataset.load = load ? '1' : '';
      applyBtn.disabled = picking || (!onLoad && same(draft, cur));
    }

    const renderAll = () => { renderSide(); renderControls(); renderCal(); };
    const viewOf = s => { const u = parse(resolve(s).until); return new Date(u.getFullYear(), u.getMonth(), 1); };

    function open() {
      draft = { ...cur }; picking = false; hover = null;
      view = viewOf(draft);
      pop.hidden = false; host.classList.add('open');
      renderAll();
      pop.style.left = ''; pop.style.right = '';
      if (pop.getBoundingClientRect().right > document.documentElement.clientWidth - 8) { pop.style.left = 'auto'; pop.style.right = '0'; }
    }
    function close() { pop.hidden = true; host.classList.remove('open'); }

    btn.addEventListener('click', e => { e.stopPropagation(); if (pop.hidden) open(); else close(); });
    pop.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => { if (!pop.hidden) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) close(); });

    side.addEventListener('click', e => {
      const b = e.target.closest('.drp-opt');
      if (!b) return;
      const m = b.dataset.m, r = resolve(draft), t = today0();
      picking = false;
      if (m === 'last') draft = draft.mode === 'last' ? draft : { ...DEFAULT };
      else if (m === 'todate') draft = { mode: 'todate', period: draft.period || 'month' };
      else if (m === 'quarter') draft = { mode: 'quarter', y: t.getFullYear(), q: Math.floor(t.getMonth() / 3) + 1 };
      else if (m === 'custom') draft = { mode: 'custom', since: r.since, until: r.until };
      else draft = { mode: m };
      view = viewOf(draft);
      renderAll();
    });
    controls.addEventListener('change', e => {
      const el = e.target;
      if (el.classList.contains('drp-n')) draft.n = Math.max(1, parseInt(el.value, 10) || 1);
      else if (el.classList.contains('drp-unit')) draft.unit = el.value;
      else if (el.classList.contains('drp-today')) draft.today = el.checked;
      else if (el.classList.contains('drp-period')) draft.period = el.value;
      else if (el.classList.contains('drp-q')) { const [y, q] = el.value.split('-').map(Number); draft = { mode: 'quarter', y, q }; }
      else if (el.classList.contains('drp-date')) {
        const s = controls.querySelector('.drp-since').value.trim(), u = controls.querySelector('.drp-until').value.trim();
        const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(parse(v));
        if (ok(s) && ok(u)) { draft = { mode: 'custom', since: s < u ? s : u, until: s < u ? u : s }; picking = false; }
      }
      view = viewOf(draft);
      renderControls(); renderCal();
    });
    controls.addEventListener('input', e => { if (e.target.classList.contains('drp-n')) { draft.n = Math.max(1, parseInt(e.target.value, 10) || 1); renderCal(); } });
    controls.addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.dispatchEvent(new Event('change', { bubbles: true })); if (!applyBtn.disabled) applyBtn.click(); } });

    cal.addEventListener('click', e => {
      const nav = e.target.closest('.drp-nav'), day = e.target.closest('.drp-day');
      if (nav) { view = new Date(view.getFullYear(), view.getMonth() + Number(nav.dataset.step), 1); renderCal(); return; }
      if (!day || day.disabled) return;
      const d = day.dataset.d;
      if (!picking) { draft = { mode: 'custom', since: d, until: d }; picking = true; hover = d; }
      else { const a = draft.since; draft = { mode: 'custom', since: a < d ? a : d, until: a < d ? d : a }; picking = false; hover = null; }
      renderSide(); renderControls(); renderCal();
    });
    cal.addEventListener('mouseover', e => {
      const day = e.target.closest('.drp-day');
      if (!picking || !day || day.disabled || day.dataset.d === hover) return;
      hover = day.dataset.d; renderCal();
    });

    host.querySelector('.drp-cancel').addEventListener('click', close);
    applyBtn.addEventListener('click', () => {
      const load = applyBtn.dataset.load === '1', changed = !same(draft, cur);
      cur = { ...draft }; close(); label();
      try { localStorage.setItem(storageKey, JSON.stringify(cur)); } catch {}
      if (changed && onChange) onChange(resolve(cur));
      if (load) onLoad(resolve(cur));
    });

    label();
    return { get: () => resolve(cur) };
  }
  return { mount, resolve };
})();

// 5) Report controls panel = Shopify report "Controls" panel (measured 2026-11-19 on Reports → Total
//    sales by product variant): sticky card on the right, sections with a grey title and a "+" button,
//    items as 28px text rows; hovering an item shows × (remove). "+" opens a popover with a search
//    field, a check list and Clear / Apply. The "Controls" button in the action bar shows / hides it.
const ReportPanel = (() => {
  const PLUS = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 4.5v11M4.5 10h11"/></svg>';
  const CROSS = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="m6 6 8 8M14 6l-8 8"/></svg>';
  const INFO = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M10 9.25v4"/><circle cx="10" cy="6.75" r=".9" fill="currentColor" stroke="none"/></svg>';
  const SEARCH = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5"/><path d="m12.3 12.3 3.7 3.7"/></svg>';
  let openPop = null;
  const closePop = () => { if (openPop) { openPop.remove(); openPop = null; } };
  document.addEventListener('click', closePop);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });

  // "+" popover: search + list (checkbox or radio) + Clear / Apply. picked = Set of keys.
  function popover(anchor, { title, options, picked, multi, onApply, search = true }) {
    closePop();
    const sel = new Set(picked);
    const pop = document.createElement('div');
    pop.className = 'rp-pop';
    pop.innerHTML = `<label class="rp-search">${SEARCH}<input type="text" placeholder="Search ${title.toLowerCase()}"></label><div class="rp-pop-list"></div>`
      + '<div class="rp-pop-foot"><button type="button" class="rp-clear">Clear</button><button type="button" class="rp-apply">Apply</button></div>';
    const list = pop.querySelector('.rp-pop-list'), input = pop.querySelector('input');
    if (!search) pop.querySelector('.rp-search').hidden = true;
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const shown = options.filter(o => o.label.toLowerCase().includes(q));
      list.innerHTML = (multi || q ? `<div class="rp-pop-head">${q ? 'Results' : 'Selected'}</div>` : '') + shown.map(o =>
        `<label class="rp-check"><input type="${multi ? 'checkbox' : 'radio'}" name="rp-pick" value="${esc(o.key)}"${sel.has(o.key) ? ' checked' : ''}><span class="rp-box"></span><span>${esc(o.label)}</span></label>`).join('')
        + (shown.length ? '' : '<div class="rp-none">No results</div>');
    };
    list.addEventListener('change', e => {
      if (!multi) sel.clear();
      if (e.target.checked) sel.add(e.target.value); else sel.delete(e.target.value);
    });
    input.addEventListener('input', draw);
    pop.querySelector('.rp-clear').addEventListener('click', () => { sel.clear(); draw(); });
    pop.querySelector('.rp-apply').addEventListener('click', () => { closePop(); onApply(sel); });
    pop.addEventListener('click', e => e.stopPropagation());
    draw();
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth;
    pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';
    pop.style.left = Math.max(8, Math.min(r.right - w, document.documentElement.clientWidth - w - 8)) + 'px';
    openPop = pop;
    if (search) setTimeout(() => input.focus(), 0);
  }

  // A section: title + "+" (when there is something to pick) + item rows.
  // options [{key,label}], value = Set of shown keys; multi = several at once (metrics) or one (dimension).
  function section(host, { title, options, value, multi = true, removable = multi, onChange }) {
    const shown = options.filter(o => value.has(o.key));
    host.className = 'rp-sec';
    host.innerHTML = `<div class="rp-head"><span>${esc(title)}</span>${options.length > 1 ? `<button type="button" class="rp-icon rp-add" aria-label="Add ${esc(title.toLowerCase())}">${PLUS}</button>` : ''}</div>`
      + shown.map(o => `<div class="rp-row" data-key="${esc(o.key)}"><span class="rp-label">${esc(o.label)}</span>`
        + (o.tip ? `<span class="rp-icon rp-info" data-tip-title="${esc(o.label)}" data-tip="${esc(o.tip)}" aria-label="About ${esc(o.label)}">${INFO}</span>` : '')
        + `${removable ? `<button type="button" class="rp-icon rp-del" aria-label="Remove ${esc(o.label)}">${CROSS}</button>` : ''}</div>`).join('')
      + (shown.length ? '' : '<div class="rp-empty">None</div>');
    host.querySelector('.rp-add')?.addEventListener('click', e => {
      e.stopPropagation();
      if (openPop && openPop.dataset.owner === title) return closePop();
      popover(e.currentTarget, { title, options, picked: value, multi, onApply: sel => { if (sel.size || multi) onChange(sel); } });
      openPop.dataset.owner = title;
    });
    host.querySelectorAll('.rp-del').forEach(b => b.addEventListener('click', () => {
      const next = new Set(value); next.delete(b.closest('.rp-row').dataset.key); onChange(next);
    }));
  }

  // "Controls" press button: shows / hides the panel (kept in this browser).
  function toggle(btn, layout, storageKey) {
    let on = true;
    try { on = localStorage.getItem(storageKey) !== '0'; } catch {}
    // the table's box changes width: resize its sideways scrollbar + edge shadows now (HScroll)
    const apply = () => { layout.classList.toggle('panel-off', !on); btn.setAttribute('aria-pressed', String(on)); HScroll.update(); };
    btn.addEventListener('click', () => { on = !on; apply(); try { localStorage.setItem(storageKey, on ? '1' : '0'); } catch {} });
    apply();
  }
  // Filters section = Shopify report Filters (measured 2026-11-19): "+" picks a column; each filter
  // is the column name and two grey chips. The operator chip opens a menu of the operators of that
  // kind of column (check on the current one); the value chip opens a small editor for that kind:
  //   number  input with "$" before (money) or "%" / "x" after (fmt), two inputs for "between"
  //   text    input ("contains" / "is" ...)
  //   select  list with search, one value ("is") or several ("is one of")
  //   date    a one-month calendar
  // Hover shows × (remove). A picked column with no value yet stays listed and filters nothing.
  // fields [{key,label,kind:'number'|'date'|'text'|'select',fmt?,options?}]; filters in state.filters[type].
  const pending = {}; // type → Map column → operator, for columns added without a value
  const SELECT_OPS = [['is', 'is'], ['isNot', 'is not'], ['isOneOf', 'is one of'], ['isNotOneOf', 'is not one of']];
  const opsOf = kind => kind === 'date' ? DATE_OPS : kind === 'text' ? TEXT_OPS : kind === 'select' ? SELECT_OPS : NUM_OPS; // 'gt' is "after" on a date
  const AFFIX = { money: ['$', ''], pct: ['', '%'], ratio: ['', 'x'] };
  const numText = (f, n) => { const [pre, suf] = AFFIX[f.fmt] || ['', '']; return pre + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }) + suf; };

  // small value editor: number / text inputs, or a one-month calendar for a date (Shopify s-date-picker,
  // measured 2026-11-16), then Clear / Apply (no "None" row: user removed it 2026-11-19)
  const CAL_ARROW = d => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  function valuePopover(anchor, f, op, x, onApply) {
    closePop();
    const two = op === 'between', isDate = f.kind === 'date';
    const [pre, suf] = AFFIX[f.fmt] || ['', ''];
    const input = (v, i) => `<label class="rp-input">${pre ? `<span class="rp-affix">${pre}</span>` : ''}<input type="${f.kind === 'number' ? 'number' : 'text'}" step="any" data-i="${i}" value="${esc(v ?? '')}" placeholder="${f.kind === 'number' ? '0' : ''}">${suf ? `<span class="rp-affix">${suf}</span>` : ''}</label>`;
    const pop = document.createElement('div');
    pop.className = 'rp-pop rp-valpop';
    pop.innerHTML = (isDate ? '<div class="fcal"></div>' : `<div class="rp-val-inputs">${input(x?.val1, 1)}${two ? `<span class="rp-and">and</span>${input(x?.val2, 2)}` : ''}</div>`)
      + '<div class="rp-pop-foot"><button type="button" class="rp-clear">Clear</button><button type="button" class="rp-apply">Apply</button></div>';
    const ins = [...pop.querySelectorAll('.rp-input input')];
    // calendar (dates): arrows + "November 2026", weekdays, days; today outlined, picked day black
    let day = isDate && x ? numIso(x.val1) : '';
    const cal = pop.querySelector('.fcal');
    let view = (() => { const d = day ? new Date(day + 'T00:00:00') : new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
    const pad = n => String(n).padStart(2, '0');
    const drawCal = () => {
      if (!cal) return;
      const y = view.getFullYear(), m = view.getMonth(), now = new Date();
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const cells = Array(new Date(y, m, 1).getDay()).fill('<span></span>');
      for (let d = 1; d <= new Date(y, m + 1, 0).getDate(); d++) {
        const iso = `${y}-${pad(m + 1)}-${pad(d)}`;
        cells.push(`<button type="button" class="${['fcal-day', iso === today && 'is-today', iso === day && 'selected'].filter(Boolean).join(' ')}" data-iso="${iso}">${d}</button>`);
      }
      cal.innerHTML = `<div class="fcal-head"><button type="button" class="fcal-nav" data-step="-1" aria-label="Previous month">${CAL_ARROW('m12 5-5 5 5 5')}</button>`
        + `<span class="fcal-title"><span>${view.toLocaleDateString('en-US', { month: 'long' })}</span><span>${y}</span></span>`
        + `<button type="button" class="fcal-nav" data-step="1" aria-label="Next month">${CAL_ARROW('m8 5 5 5-5 5')}</button></div>`
        + `<div class="fcal-grid">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(w => `<span class="fcal-wd">${w}</span>`).join('')}${cells.join('')}</div>`;
    };
    cal?.addEventListener('click', e => {
      const nav = e.target.closest('.fcal-nav'), d = e.target.closest('.fcal-day');
      if (nav) view = new Date(view.getFullYear(), view.getMonth() + Number(nav.dataset.step), 1);
      if (d) day = d.dataset.iso;
      drawCal();
    });
    const apply = () => {
      closePop();
      if (isDate) return onApply(day ? { val1: dateNum(day) } : null);
      const read = el => f.kind === 'number' ? parseFloat(el.value) : el.value.trim();
      const v1 = read(ins[0]), v2 = ins[1] ? read(ins[1]) : undefined;
      const bad = v => v === '' || (typeof v === 'number' && isNaN(v));
      if (bad(v1) || (two && bad(v2))) return onApply(null);
      onApply(two ? { val1: Math.min(v1, v2), val2: Math.max(v1, v2) } : { val1: v1 });
    };
    pop.querySelector('.rp-clear').addEventListener('click', () => { ins.forEach(i => { i.value = ''; }); day = ''; drawCal(); });
    pop.querySelector('.rp-apply').addEventListener('click', apply);
    ins.forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); }));
    pop.addEventListener('click', e => e.stopPropagation());
    drawCal();
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth;
    pop.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - w - 8)) + 'px';
    openPop = pop;
    if (ins[0]) setTimeout(() => ins[0].focus(), 0);
  }

  function filters(host, { type, fields }) {
    host._rpFilters = { type, fields };
    const cur = state.filters[type], pend = pending[type] ||= new Map();
    for (const k of Object.keys(cur)) pend.delete(k);
    const list = fields.filter(f => cur[f.key] || pend.has(f.key));
    const valText = (f, x) => {
      if (f.kind === 'select') return [].concat(x.val1).map(k => (f.options().find(o => o.key === k) || { label: k }).label).join(', ');
      const v = n => f.kind === 'date' ? fmtDay(n) : f.kind === 'number' ? numText(f, n) : n;
      return x.op === 'between' || x.op === 'notBetween' ? `${v(x.val1)} and ${v(x.val2)}` : v(x.val1);
    };
    const opOf = f => cur[f.key]?.op || pend.get(f.key) || opsOf(f.kind)[0][0];
    host.className = 'rp-sec';
    host.innerHTML = `<div class="rp-head"><span>Filters</span><button type="button" class="rp-icon rp-add" aria-label="Add filter">${PLUS}</button></div>`
      + list.map(f => {
        const x = cur[f.key], ops = opsOf(f.kind), op = (ops.find(o => o[0] === opOf(f)) || ops[0])[1];
        return `<div class="rp-filter" data-key="${esc(f.key)}"><div class="rp-row"><span class="rp-label">${esc(f.label)}</span>`
          + `<button type="button" class="rp-icon rp-del" aria-label="Remove ${esc(f.label)} filter">${CROSS}</button></div>`
          + `<div class="rp-chips"><button type="button" class="rp-chip rp-op" data-kind="${f.kind}" data-label="${esc(f.label)}">${esc(op)}</button>`
          + `<button type="button" class="rp-chip rp-val${x ? '' : ' empty'}" data-kind="${f.kind}" data-label="${esc(f.label)}">${esc(x ? valText(f, x) : f.kind === 'date' ? 'Select value' : 'Add value')}</button></div></div>`;
      }).join('');
    const redraw = () => filters(host, host._rpFilters);
    const done = () => { filterTable(type); redraw(); };

    host.querySelector('.rp-add').addEventListener('click', e => {
      e.stopPropagation();
      if (openPop && openPop.dataset.owner === 'Filters') return closePop();
      popover(e.currentTarget, {
        title: 'Filters', options: fields, picked: new Set(list.map(f => f.key)), multi: false,
        onApply: sel => {
          const key = [...sel][0];
          if (!key) return;
          if (!cur[key]) pend.set(key, opsOf(fields.find(f => f.key === key).kind)[0][0]);
          redraw();
          host.querySelector(`.rp-filter[data-key="${CSS.escape(key)}"] .rp-val`)?.click();
        },
      });
      openPop.dataset.owner = 'Filters';
    });

    // operator menu: the operators of this kind of column, check on the current one
    host.querySelectorAll('.rp-op').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const key = b.closest('.rp-filter').dataset.key, f = fields.find(x => x.key === key);
      if (openPop && openPop.dataset.owner === key + ':op') return closePop();
      popover(b, {
        title: f.label, options: opsOf(f.kind).map(([k, l]) => ({ key: k, label: l })), picked: new Set([opOf(f)]), multi: false, search: false,
        onApply: sel => {
          const op = [...sel][0], x = cur[key];
          if (!op) return;
          if (!x) { pend.set(key, op); redraw(); return; }
          const many = o => o === 'isOneOf' || o === 'isNotOneOf';
          if (f.kind === 'select' && many(x.op) !== many(op)) x.val1 = [].concat(x.val1).slice(0, many(op) ? undefined : 1);
          if (f.kind === 'select' && !many(op)) x.val1 = [].concat(x.val1)[0];
          x.op = op;
          if (op === 'between' && x.val2 == null) x.val2 = x.val1;
          done();
        },
      });
      openPop.dataset.owner = key + ':op';
    }));

    // value editor of this kind of column
    host.querySelectorAll('.rp-val').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const key = b.closest('.rp-filter').dataset.key, f = fields.find(x => x.key === key), x = cur[key], op = opOf(f);
      if (openPop && openPop.dataset.owner === key + ':val') return closePop();
      if (f.kind === 'select') {
        const many = op === 'isOneOf' || op === 'isNotOneOf';
        popover(b, {
          title: f.label, options: f.options(), picked: new Set(x ? [].concat(x.val1) : []), multi: many,
          onApply: sel => {
            const vals = [...sel];
            if (!vals.length) { delete cur[key]; pend.set(key, op); return done(); }
            cur[key] = { kind: 'select', op, val1: many ? vals : vals[0] };
            done();
          },
        });
      } else {
        valuePopover(b, f, op, x, v => {
          if (!v) { if (x) { delete cur[key]; pend.set(key, op); done(); } return; }
          cur[key] = { kind: f.kind, op, ...v };
          done();
        });
      }
      openPop.dataset.owner = key + ':val';
    }));

    host.querySelectorAll('.rp-filter .rp-del').forEach(b => b.addEventListener('click', () => {
      const key = b.closest('.rp-filter').dataset.key;
      pend.delete(key);
      if (cur[key]) { delete cur[key]; filterTable(type); }
      redraw();
    }));
  }
  return { section, toggle, filters };
})();

// Hide table columns by their 1-based header position; the Total row starts with a 2-column cell,
// so its cells sit one to the left.
function hideColumns(tableId, positions) {
  const id = 'hide-' + tableId;
  let st = document.getElementById(id);
  if (!st) { st = document.createElement('style'); st.id = id; document.head.appendChild(st); }
  st.textContent = positions.map(p => `#${tableId} thead tr:first-child>:nth-child(${p}),#${tableId} tbody tr>td:not([colspan]):nth-child(${p}),#${tableId} tr.total-row>:nth-child(${p - 1}){display:none}`).join('\n');
  fitTable();
}

// Sideways scroll of a report table wider than its card (Polaris report, measured 2026-11-20): a
// scrollbar of its own under the table, stuck to the bottom of the screen; scrolling it (or the wheel /
// trackpad sideways, or shift + wheel, over the table) sets --sx, which shared.css turns into a
// translateX of the table and back for the image + first dimension column. Screens up to 1100px keep
// the plain scroller (shared.css). update() runs from fitTable (after every render) and whenever the
// table's box changes size (Controls panel shown / hidden, window resized).
const HScroll = (() => {
  const wide = matchMedia('(min-width:1101px)');
  const resized = new ResizeObserver(() => update());
  function barOf(box) {
    let bar = box.nextElementSibling;
    if (bar?.classList.contains('hscroll')) return bar;
    bar = document.createElement('div');
    bar.className = 'hscroll';
    bar.innerHTML = '<div></div>';
    box.after(bar);
    // edge shadows (shared.css), in the wrapper so they do not move with the table
    for (const side of ['start', 'end']) {
      const sh = document.createElement('div');
      sh.className = 'hs-' + side;
      box.parentElement.appendChild(sh);
    }
    bar.addEventListener('scroll', () => { box.style.setProperty('--sx', bar.scrollLeft + 'px'); shade(box, bar); });
    resized.observe(box);
    box.addEventListener('wheel', e => {
      if (!wide.matches || bar.hidden) return;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (!dx || (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY))) return;
      const before = bar.scrollLeft;
      bar.scrollLeft += dx;
      if (bar.scrollLeft !== before) e.preventDefault();
    }, { passive: false });
    return bar;
  }
  function shade(box, bar) {
    const wrap = box.parentElement, x = bar.scrollLeft;
    wrap.querySelector(':scope>.hs-start').classList.toggle('on', x > 0);
    wrap.querySelector(':scope>.hs-end').classList.toggle('on', x < bar.scrollWidth - bar.clientWidth - 1);
  }
  function place(box, over) {
    const wrap = box.parentElement, start = wrap.querySelector(':scope>.hs-start'), end = wrap.querySelector(':scope>.hs-end');
    start.hidden = end.hidden = !over;
    if (!over) return;
    const name = box.querySelector('thead tr:first-child th:nth-child(2)');
    for (const sh of [start, end]) { sh.style.top = box.offsetTop + 'px'; sh.style.height = box.offsetHeight + 'px'; }
    start.style.left = box.offsetLeft + (name ? name.offsetLeft + name.offsetWidth : 0) + 'px';
    end.style.left = box.offsetLeft + box.clientWidth - end.offsetWidth + 'px';
  }
  function update() {
    for (const box of document.querySelectorAll('.report-layout>.card .table-scroll')) {
      const table = box.querySelector('table');
      if (!table || !box.offsetParent) continue;
      // a column whose cells carry .col-fill takes the width left in the card (never under the table's
      // --fill-min), so the table neither scrolls nor leaves a gap on the right when it can fit
      const fill = table.querySelector('tbody td.col-fill');
      if (fill) {
        const min = parseFloat(getComputedStyle(table).getPropertyValue('--fill-min')) || 0;
        const rest = table.offsetWidth - fill.offsetWidth;
        table.style.setProperty('--fill-w', Math.max(min, box.clientWidth - rest) + 'px');
      }
      const bar = barOf(box);
      const over = wide.matches && table.offsetWidth > box.clientWidth + 1;
      bar.hidden = !over;
      bar.firstElementChild.style.width = table.offsetWidth + 'px';
      box.style.setProperty('--sx', (over ? bar.scrollLeft : 0) + 'px');
      place(box, over);
      shade(box, bar);
    }
  }
  wide.addEventListener('change', update);
  addEventListener('resize', update);
  return { update };
})();

// After each table render, page switch and column hide: column names of sortable headers get a
// .th-label (ends in … when longer than the fixed column, shared.css) and the sideways scrollbar is
// sized. Column widths themselves are fixed in CSS (user, 2026-11-20). A hidden table is skipped.
function fitTable() {
  for (const c of document.querySelectorAll('thead th[data-sort] .th-content')) {
    if (c.querySelector('.th-label')) continue;
    const t = c.firstChild;
    if (t?.nodeType !== 3 || !t.textContent.trim()) continue;
    const label = document.createElement('span');
    label.className = 'th-label';
    label.textContent = t.textContent.trim();
    c.replaceChild(label, t);
  }
  HScroll.update();
}
document.fonts?.ready.then(fitTable);
