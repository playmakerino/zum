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

// ── Constants ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const PAGE_SIZE = 100;
const FILTER_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5h13L9 8v5l-2 1.5V8z"/></svg>';
const THUMB_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  config: {},
  mockups: { current: [], period: null, cached_at: null },
  creatives: { current: [], period: null, cached_at: null },
  creativesValid: { current: [], period: null, cached_at: null },
  creativesSpend: { current: [], period: null, cached_at: null },
  sort: { mockups: { key: 'spend', dir: 1 }, creativesValid: { key: 'spend', dir: 1 }, creativesSpend: { key: 'spend', dir: 1 } },
  filters: { mockups: {}, creativesValid: {}, creativesSpend: {} },
  pageLimit: { mockups: PAGE_SIZE, creativesValid: PAGE_SIZE, creativesSpend: PAGE_SIZE },
};

// ── Table Config ─────────────────────────────────────────────────────────────
const METRIC_COLS = [
  { key: 'spend', label: 'Spend' },
  { key: 'roas', label: 'ROAS' },
  { key: 'cpr', label: 'CPR' },
  { key: 'aov', label: 'AOV' },
  { key: 'cpm', label: 'CPM' },
  { key: 'ctr', label: 'CTR' },
  { key: 'cpc', label: 'CPC' },
].map(c => ({ ...c, type: 'metric' }));

const creativeRow = r =>
  `<tr><td>${thumb(r.thumbnail_url, r.is_catalog)}</td><td class="td-name" title="${esc(r.ad_name)}">${esc(r.ad_name)}</td>${metrics(r)}</tr>`;

const CREATIVE_TABLE = {
  cols: 9, idKey: 'creative_id',
  columns: [null, { key: 'ad_name', type: 'text', label: 'Ad Name' }, ...METRIC_COLS],
  row: creativeRow,
};

const TABLES = {
  mockups: {
    cols: 10, idKey: 'mockup_id',
    columns: [
      null,
      { key: 'mockup_id', type: 'text', label: 'Mockup ID' },
      { key: 'print_count', type: 'metric', label: 'Prints' },
      ...METRIC_COLS,
    ],
    row: r => `<tr><td>${thumb(r.thumbnail_url, r.is_catalog)}</td><td class="td-name" title="${esc(r.mockup_id)}">${esc(r.mockup_id)}</td><td class="td-prints">${r.print_count}</td>${metrics(r)}</tr>`,
  },
  creativesValid: CREATIVE_TABLE,
  creativesSpend: CREATIVE_TABLE,
};

function buildHeaders() {
  for (const [type, cfg] of Object.entries(TABLES)) {
    const tr = document.querySelector(`#${type}Table thead tr`);
    tr.innerHTML = cfg.columns.map(col => {
      if (!col) return '<th>Thumb</th>';
      if (col.type === 'text')
        return `<th><div class="th-content"><input data-table="${type}" data-col="${col.key}" data-type="text" class="th-filter-input" placeholder="${col.label}" oninput="filterTable('${type}')" onclick="event.stopPropagation()"></div></th>`;
      return `<th data-sort="${col.key}" onclick="sortTable('${type}','${col.key}')"><div class="th-content">${col.label} <span class="sort-icon">&#x25B4;&#x25BE;</span><button class="col-filter-btn" data-table="${type}" data-col="${col.key}" onclick="event.stopPropagation();openFilterPopup('${type}','${col.key}',this)">${FILTER_SVG}</button></div></th>`;
    }).join('');
  }
}

// ── Data Processing ──────────────────────────────────────────────────────────
function hasValidFormat(adName) {
  return /^\[[^-]+-[^_]+_.+\]/.test(adName || '');
}

function splitCreatives() {
  const c = state.creatives;
  state.creativesValid = {
    current: c.current.filter(r => hasValidFormat(r.ad_name)),
    period: c.period, cached_at: c.cached_at,
  };
  state.creativesSpend = {
    current: c.current.filter(r => !hasValidFormat(r.ad_name)),
    period: c.period, cached_at: c.cached_at,
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────
const cacheKey = t => `trang_mockup_${t}`;
const saveCache = (t, v) => { try { localStorage.setItem(cacheKey(t), JSON.stringify(v)); } catch {} };
const loadCache = t => { try { return JSON.parse(localStorage.getItem(cacheKey(t))); } catch { return null; } };

// ── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  buildHeaders();
  updatePeriodLabel();
  restoreLogs();

  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
  } catch {}

  if (state.config.hasMetaToken && state.config.hasAdAccountId) {
    let hasLocal = false;
    const mockupsCached = loadCache('mockups');
    if (mockupsCached) { state.mockups = mockupsCached; renderTable('mockups'); hasLocal = true; }
    const creativesCached = loadCache('creatives');
    if (creativesCached) { state.creatives = creativesCached; splitCreatives(); renderTable('creativesValid'); renderTable('creativesSpend'); hasLocal = true; }
    if (hasLocal) showCacheTime(state.mockups.cached_at || state.creatives.cached_at);
  }
});

// ── UI Helpers ───────────────────────────────────────────────────────────────
function showCacheTime(iso) {
  const el = $('headerCachedAt');
  if (!el || !iso) { if (el) el.textContent = ''; return; }
  const d = new Date(iso);
  el.textContent = `Updated ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString('en-US')}`;
}

function formatPeriodDate(d) {
  if (typeof d === 'string') d = new Date(d + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function updatePeriodLabel() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today);
  since.setDate(since.getDate() - 30);
  $('periodLabel').textContent = `Last 30 days: ${formatPeriodDate(since)} – ${formatPeriodDate(today)}`;
}

// ── Load Log ─────────────────────────────────────────────────────────────────
const LOG_STORAGE_KEY = 'trang_mockup_load_log';

function saveLogs() {
  try {
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify({
      mockups: $('mockupsLoadLog').innerHTML,
      creatives: $('creativesLoadLog').innerHTML,
    }));
  } catch {}
}

function restoreLogs() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || 'null');
    if (!saved) return;
    if (saved.mockups) $('mockupsLoadLog').innerHTML = saved.mockups;
    if (saved.creatives) $('creativesLoadLog').innerHTML = saved.creatives;
  } catch {}
}

function addLog(msg, type = '') {
  for (const id of ['mockupsLoadLog', 'creativesLoadLog']) {
    const log = $(id);
    const line = document.createElement('div');
    line.className = 'log-line' + (type ? ' ' + type : '');
    line.innerHTML = esc(msg);
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
  saveLogs();
}

function logTo(id, msg, type = '') {
  const line = document.createElement('div');
  line.className = 'log-line' + (type ? ' ' + type : '');
  line.innerHTML = esc(msg);
  $(id).appendChild(line);
  saveLogs();
}

function clearLog() {
  $('mockupsLoadLog').innerHTML = '';
  $('creativesLoadLog').innerHTML = '';
  saveLogs();
}

// ── Navigation ───────────────────────────────────────────────────────────────
function showPage(name) {
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.tab-btn').forEach(b => b.classList.remove('active'));
  $('page-' + name).classList.add('active');
  const tab = document.querySelector(`.tab-btn[data-page="${name}"]`);
  if (tab) tab.classList.add('active');
  const showSubs = name === 'creatives';
  $$('.topbar-tabs .sub-tab').forEach(b => b.style.display = showSubs ? '' : 'none');
  $('subTabSep').style.display = showSubs ? '' : 'none';
  hideThumbPreview();
}

function showCreativeSub(name) {
  $$('#page-creatives .sub-page').forEach(p => p.classList.remove('active'));
  $$('.sub-tab').forEach(b => b.classList.remove('active'));
  $('sub-' + name).classList.add('active');
  document.querySelector(`.sub-tab[data-sub="${name}"]`).classList.add('active');
  hideThumbPreview();
}

// ── Fetch ────────────────────────────────────────────────────────────────────
async function fetchAll(refresh = true) {
  if (!state.config.hasMetaToken || !state.config.hasAdAccountId)
    return toast('Meta Token and Account ID not configured', 'error');

  const startTime = performance.now();

  for (const t of ['mockups', 'creativesValid', 'creativesSpend']) {
    const wrap = $(t + 'Table').closest('.table-wrap');
    let ov = wrap.querySelector('.load-overlay');
    if (!ov) { ov = document.createElement('div'); ov.className = 'load-overlay'; wrap.appendChild(ov); }
    ov.innerHTML = `<div class="load-popup"><div class="load-title"><span class="load-status">Connecting...</span><span class="load-timer">0s</span></div></div>`;
    ov.style.display = 'flex';
  }

  const timerInterval = setInterval(() => {
    const s = Math.floor((performance.now() - startTime) / 1000);
    $$('.load-timer').forEach(el => el.textContent = s + 's');
  }, 1000);

  try {
    const res = await fetch(`/api/dashboard${refresh ? '?refresh=1' : ''}`);
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
          if (j.progress) $$('.load-status').forEach(el => el.textContent = j.progress.replace(/\s*\[[\d.]+s\]\s*$/, ''));
          if (j.result) data = j.result;
          if (j.error) throw new Error(j.error + ': ' + JSON.stringify(j.detail));
        } catch (e) { if (e.message) throw e; }
      }
    }

    if (!data) throw new Error('No data received');
    clearInterval(timerInterval);

    state.mockups = { current: data.mockups.current, period: data.period, cached_at: data.cached_at };
    state.creatives = { current: data.creatives.current, period: data.period, cached_at: data.cached_at };

    saveCache('mockups', state.mockups);
    saveCache('creatives', state.creatives);
    splitCreatives();
    renderTable('mockups');
    renderTable('creativesValid');
    renderTable('creativesSpend');
    showCacheTime(data.cached_at);
    updatePeriodLabel();

    $$('.load-overlay').forEach(el => el.style.display = 'none');

    const st = data.stats;
    const result = st
      ? `Insights: ${st.insights.rows} rows ${st.insights.cached ? 'from cache' : 'from API'} → ${st.insights.qualified} qualified · Mockups: ${data.mockups.current.length} · Full Format: ${state.creativesValid.current.length} · High Spend: ${state.creativesSpend.current.length} · HD thumbs: ${st.thumbnails.cached} cached, ${st.thumbnails.fetched} fetched`
      : `Loaded ${data.mockups.current.length} mockups, ${state.creativesValid.current.length} full format, ${state.creativesSpend.current.length} high spend`;
    clearLog();
    logTo('mockupsLoadLog', result, 'success');
    logTo('creativesLoadLog', result, 'success');
  } catch (err) {
    clearInterval(timerInterval);
    $$('.load-overlay').forEach(el => el.style.display = 'none');
    clearLog();
    addLog(err.message, 'error');
    toast('Error: ' + err.message, 'error');
    for (const t of ['mockups', 'creativesValid', 'creativesSpend']) $(t + 'Body').innerHTML = empty(TABLES[t].cols);
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
function enrichRow(row) {
  return { ...row, roas: parseFloat(row.roas || 0), cpr: parseFloat(row.cpr || 0), aov: parseFloat(row.aov || 0) };
}

function renderTable(type) {
  const cfg = TABLES[type];
  const data = state[type];
  const { key, dir } = state.sort[type];
  let currentRows = data.current.map(enrichRow);
  if (type === 'mockups') currentRows = currentRows.filter(r => r.mockup_id !== 'unknown');
  const sorted = currentRows.sort((a, b) => (parseFloat(b[key] || 0) - parseFloat(a[key] || 0)) * dir);

  state[type]._enriched = sorted;

  const filtered = applyFilters(type, sorted);
  const limit = state.pageLimit[type];
  const page = filtered.slice(0, limit);

  let html = page.map(r => cfg.row(r)).join('');
  if (filtered.length > limit) {
    html += `<tr class="show-more-row"><td colspan="${cfg.cols}"><button class="btn-show-more" onclick="showMore('${type}')">Show more (${filtered.length - limit} remaining)</button></td></tr>`;
  }
  $(type + 'Body').innerHTML = html || empty(cfg.cols);
  if (type === 'mockups' || type === 'creativesValid') buildTotalRow(type, filtered);

  $$(`#${type}Table thead th`).forEach(th => {
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

// ── Filters ──────────────────────────────────────────────────────────────────
function applyFilters(type, rows) {
  const metricFilters = state.filters[type];
  const colFilters = {};
  $$(`#${type}Table thead [data-col]`).forEach(el => {
    const col = el.dataset.col;
    const t = el.dataset.type;
    const v = el.value.trim();
    if (v && !(t === 'select' && v === '')) colFilters[col] = { type: t, value: v };
  });
  if (!Object.keys(colFilters).length && !Object.keys(metricFilters).length) return rows;

  return rows.filter(row => {
    for (const [col, f] of Object.entries(colFilters)) {
      if (f.type === 'text' && !String(row[col] || '').toLowerCase().includes(f.value.toLowerCase())) return false;
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

// ── Filter Popup ─────────────────────────────────────────────────────────────
let _fpState = { type: null, col: null, btn: null };

function openFilterPopup(type, col, btn) {
  const popup = $('filterPopup');
  _fpState = { type, col, btn };
  const existing = state.filters[type][col];
  $('filterOp').value = existing?.op || 'gt';
  $('filterVal1').value = existing?.val1 ?? '';
  $('filterVal2').value = existing?.val2 ?? '';
  $('filterPopupTitle').textContent = col.toUpperCase().replace(/_/g, ' ') + ' Filter';
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
  $$(`#${type}Table .col-filter-btn`).forEach(btn => {
    const col = btn.dataset.col;
    const f = state.filters[type][col];
    btn.classList.toggle('active', !!f);
    if (f) {
      const opLabels = { gt: '>', lt: '<', between: '', notBetween: '!' };
      const valStr = f.op === 'between' || f.op === 'notBetween' ? `${f.val1}–${f.val2}` : `${opLabels[f.op]}${f.val1}`;
      btn.innerHTML = `${FILTER_SVG} ${valStr}`;
    } else {
      btn.innerHTML = FILTER_SVG;
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const empty = cols => `<tr><td colspan="${cols}"><div class="state-box">No data</div></td></tr>`;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtF = n => parseFloat(n || 0).toFixed(2);
const fmtMoney = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoneyInt = n => '$' + Math.round(parseFloat(n || 0)).toLocaleString('en-US');

function thumb(url, isCatalog) {
  if (!url) return `<div class="thumb-placeholder">${THUMB_SVG}</div>`;
  return `<img class="thumb" src="${esc(url)}"${isCatalog ? '' : ` onmouseenter="showThumbPreview(event)" onmouseleave="hideThumbPreview()" onclick="event.stopPropagation()"`} alt="" loading="lazy" onerror="thumbError(this)">`;
}

function thumbError(img) {
  const div = document.createElement('div');
  div.className = 'thumb-placeholder';
  div.innerHTML = THUMB_SVG;
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
function hideThumbPreview() { _thumbPreview.style.display = 'none'; }
document.addEventListener('click', hideThumbPreview);

function totals(rows) {
  const s = k => rows.reduce((a, r) => a + parseFloat(r[k] || 0), 0);
  const spend = s('spend'), impr = s('impressions'), clicks = s('clicks');
  const pc = s('purchase_count'), pv = s('purchase_value');
  return {
    spend,
    roas: spend ? pv / spend : 0,
    cpr:  pc ? spend / pc : 0,
    aov:  pc ? pv / pc : 0,
    cpm:  impr ? spend / impr * 1000 : 0,
    ctr:  impr ? clicks / impr * 100 : 0,
    cpc:  clicks ? spend / clicks : 0,
  };
}

function buildTotalRow(type, filtered) {
  if (filtered.length === 0) return;
  const labelCols = type === 'mockups' ? 3 : 2;
  const tr = document.createElement('tr');
  tr.className = 'total-row';
  const emptyTds = '<td></td>'.repeat(labelCols - 1);
  tr.innerHTML = `<td><b>Total (${filtered.length})</b></td>${emptyTds}${metrics(totals(filtered))}`;
  $(type + 'Body').appendChild(tr);
}

function metrics(row) {
  return [
    fmtMoneyInt(row.spend), fmtF(row.roas) + 'x',
    fmtMoneyInt(row.cpr), fmtMoneyInt(row.aov),
    fmtMoneyInt(row.cpm), fmtF(row.ctr) + '%',
    fmtMoney(row.cpc),
  ].map(v => `<td class="td-metric">${v}</td>`).join('');
}

// ── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3500);
}
