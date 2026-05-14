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

const PAGE_SIZE = 100;
const COLS = 6;
const state = {
  config: Object.fromEntries(['metaToken','accountId'].map(k => [k, localStorage.getItem(k) || ''])),
  ads: { data: [], period: null, cached_at: null },
  sort: { ads: { key: 'spend', dir: 1 } },
  filters: { ads: {} },
  pageLimit: { ads: PAGE_SIZE },
};

const TABLES = {
  ads: {
    idKey: 'ad_name',
    row: r => `<tr><td>${thumb(r.image_url)}</td><td>${esc(r.print_id)}</td><td class="td-name" title="${esc(r.ad_name)}">${esc(r.ad_name)}</td><td>${linkCell(r.link)}</td><td>${fmtMoneyInt(r.spend)}</td><td>${fmtF(r.roas)}x</td></tr>`
  },
};

// Cache
const cacheKey = () => `meta_cache_${state.config.accountId}_ads_alltime`;
const saveCache = v => { try { localStorage.setItem(cacheKey(), JSON.stringify(v)); } catch {} };
const loadCacheLocal = () => { try { return JSON.parse(localStorage.getItem(cacheKey())); } catch { return null; } };

// Init
window.addEventListener('DOMContentLoaded', async () => {
  restoreLogs();

  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.hasMetaToken) state.config.metaToken = '__SERVER__';
    if (cfg.hasAdAccountId) state.config.accountId = '__SERVER__';
  } catch {}

  if (state.config.accountId) {
    const cached = loadCacheLocal();
    if (cached) {
      state.ads = cached;
      renderTable('ads');
      showCacheTime(cached.cached_at);
    }
  }
});

function showCacheTime(iso) {
  const el = $('headerCachedAt');
  if (!el || !iso) { if (el) el.textContent = ''; return; }
  const d = new Date(iso);
  el.textContent = `Updated ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString('en-US')}`;
}

// Load log
const LOG_STORAGE_KEY = 'meta_load_log';
function saveLogs() {
  try { localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify({ ads: $('adsLoadLog').innerHTML })); } catch {}
}
function restoreLogs() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || 'null');
    if (saved?.ads) $('adsLoadLog').innerHTML = saved.ads;
  } catch {}
}

function addLog(msg, type = '') {
  const log = $('adsLoadLog');
  const line = document.createElement('div');
  line.className = 'log-line' + (type ? ' ' + type : '');
  line.innerHTML = esc(msg);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  saveLogs();
}

function clearLog() {
  $('adsLoadLog').innerHTML = '';
  saveLogs();
}

// Fetch
async function fetchAll(mode = 'all') {
  if (!state.config.metaToken || !state.config.accountId)
    return toast('Please enter Meta Token and Account ID first', 'error');

  const headers = {};
  if (state.config.metaToken && state.config.metaToken !== '__SERVER__') headers['x-meta-token'] = state.config.metaToken;
  if (state.config.accountId && state.config.accountId !== '__SERVER__') headers['x-meta-account-id'] = state.config.accountId;

  try { localStorage.removeItem(cacheKey()); } catch {}

  const startTime = performance.now();
  const wrap = $('adsTable').closest('.table-wrap');
  let ov = wrap.querySelector('.load-overlay');
  if (!ov) { ov = document.createElement('div'); ov.className = 'load-overlay'; wrap.appendChild(ov); }
  ov.innerHTML = `<div class="load-popup"><div class="load-title"><span class="load-status">Connecting...</span><span class="load-timer">0s</span></div></div>`;
  ov.style.display = 'flex';

  const timerInterval = setInterval(() => {
    const s = Math.floor((performance.now() - startTime) / 1000);
    const el = wrap.querySelector('.load-timer');
    if (el) el.textContent = s + 's';
  }, 1000);

  clearLog();
  try {
    const res = await fetch(`/api/dashboard?mode=${mode}`, { headers });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', data = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const j = JSON.parse(line.slice(6));
          if (j.progress) {
            const el = wrap.querySelector('.load-status');
            if (el) el.textContent = j.progress.replace(/\s*\[[\d.]+s\]\s*$/, '');
          }
          if (j.result) data = j.result;
          if (j.error) throw new Error(j.error + ': ' + JSON.stringify(j.detail));
        } catch (e) { if (e.message) throw e; }
      }
    }

    if (!data) throw new Error('No data received');
    clearInterval(timerInterval);

    state.ads = { data: data.ads, period: data.period, cached_at: data.cached_at };
    saveCache(state.ads);
    renderTable('ads');
    showCacheTime(data.cached_at);
    ov.style.display = 'none';

    const label = data.incremental ? 'Incremental' : 'Full load';
    addLog(`${label}: ${data.totalRows} insight rows → ${data.topAdsCount} top ads → ${data.imageAdsCount} image ads`, 'success');
    addLog(`Images: ${data.adsWithImage}/${data.ads.length} · Links: ${data.adsWithLink}/${data.ads.length}`, 'success');
  } catch (err) {
    clearInterval(timerInterval);
    const ov2 = wrap.querySelector('.load-overlay');
    if (ov2) ov2.style.display = 'none';
    addLog(err.message, 'error');
    toast('Error: ' + err.message, 'error');
    $('adsBody').innerHTML = empty();
  }
}

// Render
function renderTable(type) {
  const cfg = TABLES[type];
  const data = state[type].data || [];
  const { key, dir } = state.sort[type];
  const sorted = [...data].sort((a, b) => {
    if (key === 'print_id') return ((a[key] || '').localeCompare(b[key] || '')) * dir;
    return (parseFloat(b[key] || 0) - parseFloat(a[key] || 0)) * dir;
  });

  const filtered = applyFilters(type, sorted);
  const limit = state.pageLimit[type];
  const page = filtered.slice(0, limit);

  let html = page.map(r => cfg.row(r)).join('');
  if (filtered.length > limit) {
    html += `<tr class="show-more-row"><td colspan="${COLS}"><button class="btn-show-more" onclick="showMore('${type}')">Show more (${filtered.length - limit} remaining)</button></td></tr>`;
  }
  $(type + 'Body').innerHTML = html || empty();

  document.querySelectorAll(`#${type}Table thead th`).forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === key);
  });
}

function showMore(type) {
  state.pageLimit[type] += PAGE_SIZE;
  renderTable(type);
}

function sortTable(type, key) {
  const s = state.sort[type];
  s.dir = s.key === key ? s.dir * -1 : 1;
  s.key = key;
  state.pageLimit[type] = PAGE_SIZE;
  renderTable(type);
}

// Filters
function applyFilters(type, rows) {
  const metricFilters = state.filters[type];
  const colFilters = {};
  document.querySelectorAll(`#${type}Table thead [data-col]`).forEach(el => {
    const col = el.dataset.col;
    const t = el.dataset.type;
    const v = el.value.trim();
    if (v && !(t === 'select' && v === '')) colFilters[col] = { type: t, value: v };
  });
  const hasFilters = Object.keys(colFilters).length > 0 || Object.keys(metricFilters).length > 0;
  if (!hasFilters) return rows;
  return rows.filter(row => {
    for (const [col, f] of Object.entries(colFilters)) {
      if (f.type === 'text') {
        if (!String(row[col] || '').toLowerCase().includes(f.value.toLowerCase())) return false;
      }
    }
    for (const [col, f] of Object.entries(metricFilters)) {
      const v = parseFloat(row[col] || 0);
      if (f.op === 'gt' && !(v > f.val1)) return false;
      if (f.op === 'lt' && !(v < f.val1)) return false;
      if (f.op === 'between' && !(v >= f.val1 && v <= f.val2)) return false;
      if (f.op === 'notBetween' && !(v < f.val1 || v > f.val2)) return false;
    }
    return true;
  });
}

function filterTable(type) {
  state.pageLimit[type] = PAGE_SIZE;
  renderTable(type);
}

// ── Filter Popup ──────────────────────────────────────────────────────────────
let _fpState = { type: null, col: null, btn: null };

function openFilterPopup(type, col, btn) {
  const popup = $('filterPopup');
  _fpState = { type, col, btn };
  const existing = state.filters[type][col];
  $('filterOp').value = existing?.op || 'gt';
  $('filterVal1').value = existing?.val1 ?? '';
  $('filterVal2').value = existing?.val2 ?? '';
  $('filterPopupTitle').textContent = col.toUpperCase() + ' Filter';
  onFilterOpChange();
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

function updateFilterBtns(type) {
  document.querySelectorAll(`#${type}Table .col-filter-btn`).forEach(btn => {
    const col = btn.dataset.col;
    const f = state.filters[type][col];
    btn.classList.toggle('active', !!f);
    if (f) {
      const opLabels = { gt: '>', lt: '<', between: '', notBetween: '!' };
      const valStr = f.op === 'between' || f.op === 'notBetween' ? `${f.val1}–${f.val2}` : `${opLabels[f.op]}${f.val1}`;
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5h13L9 8v5l-2 1.5V8z"/></svg> ${valStr}`;
    } else {
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5h13L9 8v5l-2 1.5V8z"/></svg>`;
    }
  });
}

// Helpers
const empty = () => `<tr><td colspan="${COLS}"><div class="state-box">No data</div></td></tr>`;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtF = n => parseFloat(n || 0).toFixed(2);
const fmtMoneyInt = n => '$' + Math.round(parseFloat(n || 0)).toLocaleString('en-US');
function linkCell(url) {
  if (!url) return '';
  const display = url.replace(/^https?:\/\//, '').replace(/^(www\.)?zumbamboo\.com/, '').replace(/\/$/, '');
  return `<a href="${esc(url)}" target="_blank" rel="noopener" class="link-cell" title="${esc(url)}">${esc(display)}</a>`;
}

function thumb(url) {
  const placeholder = `<div class="thumb-placeholder"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></div>`;
  if (!url) return placeholder;
  return `<img class="thumb" src="${esc(url)}" onmouseenter="showThumbPreview(event)" onmouseleave="hideThumbPreview()" alt="" loading="lazy" onerror="thumbError(this)">`;
}
function thumbError(img) {
  const div = document.createElement('div');
  div.className = 'thumb-placeholder';
  div.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
  img.replaceWith(div);
}

const _thumbPreview = (() => {
  const el = document.createElement('img');
  el.style.cssText = 'display:none;position:fixed;width:240px;height:240px;object-fit:cover;border-radius:8px;border:1px solid #e6e8ec;box-shadow:0 12px 24px rgba(15,17,21,.1),0 4px 8px rgba(15,17,21,.06);z-index:9998;background:#fff;pointer-events:none';
  el.onerror = () => { el.style.display = 'none'; };
  document.body.appendChild(el);
  return el;
})();

function showThumbPreview(e) {
  const src = e.target.src;
  _thumbPreview.onload = function() { _thumbPreview.style.display = 'block'; };
  _thumbPreview.src = src;
  const rect = e.target.getBoundingClientRect();
  let top = rect.top + rect.height / 2 - 120;
  let left = rect.right + 10;
  if (left + 240 > window.innerWidth) left = rect.left - 250;
  if (top + 240 > window.innerHeight) top = window.innerHeight - 244;
  if (top < 4) top = 4;
  _thumbPreview.style.top = top + 'px';
  _thumbPreview.style.left = left + 'px';
}

function hideThumbPreview() {
  _thumbPreview.style.display = 'none';
}
document.addEventListener('click', hideThumbPreview);

let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3500);
}
