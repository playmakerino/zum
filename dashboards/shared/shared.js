// Shared UI behaviour + table helpers for the 3 dashboards (source: dashboards/shared/, copied by sync-shared.ps1).
// Loaded before app.js. Section 0 defines globals every app.js uses; the app supplies `state`
// (sort / filters / pageLimit per table type) and renderTable(type).

// 0) App helpers: error boundary, toast, SSE reader, sort / paging / filters, column filter popup
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
const PAGE_SIZE = 100; // rows per page; "Show more" adds another page
const FILTER_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5h13L9 8v5l-2 1.5V8z"/></svg>';
const PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
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

// Load buttons are locked while a load runs: one load at a time per page (a second browser
// asking for the same data joins the running load on the server)
function lockLoadButtons(locked) {
  $$('.topbar-actions .btn').forEach(b => { b.disabled = locked; });
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

// Re-filter + re-render (called from the header search fields and the filter popup)
function filterTable(type) {
  state.pageLimit[type] = PAGE_SIZE;
  renderTable(type);
}

// Rows matching every header search field (substring, any case) and column filter (state.filters[type])
function applyFilters(type, rows) {
  const metricFilters = Object.entries(state.filters[type]);
  const textFilters = [...$$(`#${type}Table thead input[data-col]`)]
    .map(el => [el.dataset.col, el.value.trim().toLowerCase()])
    .filter(([, v]) => v);
  if (!textFilters.length && !metricFilters.length) return rows;
  return rows.filter(row => {
    for (const [col, v] of textFilters) if (!String(row[col] || '').toLowerCase().includes(v)) return false;
    for (const [col, f] of metricFilters) {
      const v = parseFloat(row[col] || 0);
      if (f.op === 'gt' && !(v > f.val1)) return false;
      if (f.op === 'lt' && !(v < f.val1)) return false;
      if (f.op === 'between' && !(v >= f.val1 && v <= f.val2)) return false;
      if (f.op === 'notBetween' && !(v < f.val1 || v > f.val2)) return false;
    }
    return true;
  });
}

// Column filter popup (#filterPopup), opened by a header filter button
let _fpState = { type: null, col: null, btn: null };

function openFilterPopup(type, col, btn) {
  const popup = $('filterPopup');
  _fpState = { type, col, btn };
  const existing = state.filters[type][col];
  $('filterOp').value = existing?.op || 'gt';
  $('filterVal1').value = existing?.val1 ?? '';
  $('filterVal2').value = existing?.val2 ?? '';
  $('filterPopupTitle').textContent = (btn.closest('th')?.textContent || col).replace(/[▴▾]/g, '').trim(); // column label as shown in the header
  onFilterOpChange();
  // below the button, above it when there is no room; always inside the viewport
  const rect = btn.getBoundingClientRect();
  popup.style.display = 'block';
  const popH = popup.offsetHeight;
  const popW = popup.offsetWidth;
  const top = rect.bottom + 4 + popH > window.innerHeight ? rect.top - popH - 4 : rect.bottom + 4;
  popup.style.top = Math.max(4, top) + 'px';
  popup.style.left = Math.min(rect.left, window.innerWidth - popW - 8) + 'px';
  setTimeout(() => document.addEventListener('mousedown', _fpOutsideClick), 0);
}

function _fpOutsideClick(e) {
  if (!$('filterPopup').contains(e.target) && e.target !== _fpState.btn) cancelFilter();
}

function onFilterOpChange() {
  const op = $('filterOp').value;
  const isBetween = op === 'between' || op === 'notBetween';
  $('filterAnd').style.display = isBetween ? '' : 'none';
  $('filterVal2').style.display = isBetween ? '' : 'none';
}

function applyFilter() {
  const { type, col } = _fpState;
  const op = $('filterOp').value;
  const val1 = parseFloat($('filterVal1').value);
  if (isNaN(val1)) { cancelFilter(); return; }
  const filter = { op, val1 };
  if (op === 'between' || op === 'notBetween') {
    const val2 = parseFloat($('filterVal2').value);
    if (isNaN(val2)) { cancelFilter(); return; }
    filter.val2 = val2;
  }
  state.filters[type][col] = filter;
  cancelFilter();
  filterTable(type);
  updateFilterBtns(type);
}

function clearCurrentFilter() {
  const { type, col } = _fpState;
  delete state.filters[type][col];
  cancelFilter();
  filterTable(type);
  updateFilterBtns(type);
}

function cancelFilter() {
  $('filterPopup').style.display = 'none';
  document.removeEventListener('mousedown', _fpOutsideClick);
}

// Header filter buttons show the active filter ("> 200", "10–50")
function updateFilterBtns(type) {
  const opLabels = { gt: '>', lt: '<', between: '', notBetween: '!' };
  $$(`#${type}Table .col-filter-btn`).forEach(btn => {
    const f = state.filters[type][btn.dataset.col];
    btn.classList.toggle('active', !!f);
    if (!f) { btn.innerHTML = FILTER_SVG; return; }
    const valStr = f.op === 'between' || f.op === 'notBetween' ? `${f.val1}–${f.val2}` : `${opLabels[f.op]}${f.val1}`;
    btn.innerHTML = `${FILTER_SVG} ${valStr}`;
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
      btn.innerHTML = `${icon}<span class="dd-label"></span>${sel.dataset.dd === 'chip' ? '' : CHEVRON}`;
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

// 3) Column filter popup chips (Shopify report Filters): the value chip shows the current
//    value(s) or "Add value"; clicking it opens the editor (input + Clear/Apply). The app's
//    own openFilterPopup/applyFilter keep working on #filterOp/#filterVal1/#filterVal2.
(() => {
  const popup = document.getElementById('filterPopup');
  const chip = document.getElementById('filterValueChip');
  if (!popup || !chip) return;
  const v1 = document.getElementById('filterVal1'), v2 = document.getElementById('filterVal2');
  const op = document.getElementById('filterOp');
  const between = () => op.value === 'between' || op.value === 'notBetween';
  const label = () => {
    const a = v1.value.trim(), b = v2.value.trim();
    const txt = !a ? '' : between() ? a + ' and ' + (b || '…') : a;
    chip.textContent = txt || 'Add value';
    chip.classList.toggle('empty', !txt);
  };
  const edit = on => { popup.classList.toggle('editing', on); if (on) setTimeout(() => v1.focus(), 0); };
  chip.addEventListener('click', () => edit(!popup.classList.contains('editing')));
  [v1, v2].forEach(i => i.addEventListener('input', label));
  op.addEventListener('change', label);
  // popup opened by app code (style.display = 'block'): refresh chip, open editor if no value yet
  new MutationObserver(() => {
    if (popup.style.display !== 'block') { delete popup.dataset.shown; return; }
    if (popup.dataset.shown) return;
    popup.dataset.shown = '1';
    label();
    edit(!v1.value.trim());
  }).observe(popup, { attributes: true, attributeFilter: ['style'] });
})();

// 4) Tooltips like Shopify admin: dark card, bold title + description, below the element
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
  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && el !== cur) show(el); else if (!el && cur) hide();
  });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', hide);
})();
