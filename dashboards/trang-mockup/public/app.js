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
  `<tr><td>${thumb(r.thumbnail_url, r.is_catalog, r.thumb_cid)}</td><td class="td-name" title="${esc(r.ad_name)}">${esc(r.ad_name)}</td>${metrics(r)}</tr>`;

const CREATIVE_TABLE = {
  cols: 9,
  columns: [null, { key: 'ad_name', type: 'text', label: 'Ad Name' }, ...METRIC_COLS],
  row: creativeRow,
};

const TABLES = {
  mockups: {
    cols: 10,
    columns: [
      null,
      { key: 'mockup_id', type: 'text', label: 'Mockup ID' },
      { key: 'print_count', type: 'metric', label: 'Prints' },
      ...METRIC_COLS,
    ],
    row: r => `<tr><td>${thumb(r.thumbnail_url, r.is_catalog, r.thumb_cid)}</td><td class="td-name" title="${esc(r.mockup_id)}">${esc(r.mockup_id)}</td><td class="td-prints">${r.print_count}</td>${metrics(r)}</tr>`,
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
        return `<th><div class="th-content"><input data-table="${type}" data-col="${col.key}" data-type="text" class="th-filter-input" placeholder="Search ${col.label.toLowerCase().replace(/\bid\b/, 'ID')}" oninput="filterTable('${type}')" onclick="event.stopPropagation()"></div></th>`;
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
async function fetchAll() {
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
    const res = await fetch('/api/dashboard?refresh=1');
    let data = null;
    await readSSE(res, j => {
      if (j.progress) $$('.load-status').forEach(el => el.textContent = j.progress.replace(/\s*\[[\d.]+s\]\s*$/, ''));
      if (j.result) data = j.result;
      if (j.error) throw new Error(j.error + ': ' + JSON.stringify(j.detail));
    });
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
    const totalCreatives = state.creativesValid.current.length + state.creativesSpend.current.length;
    const fmt = state.creativesValid.current.length, hs = state.creativesSpend.current.length;
    const result = st
      ? `${st.insights.rows} ads · ${st.qualifiedRows ?? '?'} qualified · ${totalCreatives} creatives (${fmt} full format, ${hs} high spend) · ${data.mockups.current.length} mockups · thumbs load on scroll`
      : `${data.mockups.current.length} mockups · ${fmt} full format · ${hs} high spend`;
    clearLog();
    logTo('mockupsLoadLog', result, 'success');
    logTo('creativesLoadLog', result, 'success');
    if (st?.creativesOut && totalCreatives > st.creativesOut * 1.1) {
      logTo('creativesLoadLog', `Backend filter error: expected ${st.creativesOut} creatives, got ${totalCreatives}`, 'error');
    }
  } catch (err) {
    clearInterval(timerInterval);
    $$('.load-overlay').forEach(el => el.style.display = 'none');
    clearLog();
    addLog(err.message, 'error');
    toast('Error: ' + err.message, 'error');
    for (const t of ['mockups', 'creativesValid', 'creativesSpend']) $(t + 'Body').innerHTML = empty(TABLES[t].cols);
  }
}

// ── Lazy HD thumbnails ───────────────────────────────────────────────────────
// Server no longer fetches thumbnails during load. Placeholders carrying
// data-thumb-cid are observed; when they scroll into view their creative ids
// are batched (≤50) to /api/thumbs and the URL is written back into state.
const THUMB_BATCH = 50;
const _thumbRequested = new Set();
let _thumbQueue = [];
let _thumbTimer = null;

const _thumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        _thumbObserver.unobserve(e.target);
        queueThumb(e.target.dataset.thumbCid);
      }
    }, { rootMargin: '200px' })
  : null;

function observeThumbs(container) {
  container.querySelectorAll('[data-thumb-cid]').forEach(el => {
    if (_thumbObserver) _thumbObserver.observe(el); else queueThumb(el.dataset.thumbCid);
  });
}

function queueThumb(cid) {
  if (!cid || _thumbRequested.has(cid)) return;
  _thumbRequested.add(cid);
  _thumbQueue.push(cid);
  clearTimeout(_thumbTimer);
  _thumbTimer = setTimeout(flushThumbs, 100);
}

async function flushThumbs() {
  while (_thumbQueue.length) {
    const batch = _thumbQueue.splice(0, THUMB_BATCH);
    try {
      const res = await fetch('/api/thumbs?ids=' + batch.join(','));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applyThumbs(await res.json());
    } catch (err) {
      console.error('Thumb load failed:', err.message);
      batch.forEach(cid => _thumbRequested.delete(cid));
    }
  }
}

function applyThumbs(map) {
  for (const list of [state.mockups.current, state.creatives.current]) {
    for (const r of list) if (r.thumb_cid && map[r.thumb_cid]) r.thumbnail_url = map[r.thumb_cid];
  }
  for (const [cid, url] of Object.entries(map)) {
    document.querySelectorAll(`[data-thumb-cid="${cid}"]`).forEach(el => {
      if (url) el.outerHTML = thumb(url, el.dataset.catalog === '1');
      else el.removeAttribute('data-thumb-cid');
    });
  }
  saveCache('mockups', state.mockups);
  saveCache('creatives', state.creatives);
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

  const filtered = applyFilters(type, sorted);
  const limit = state.pageLimit[type];
  const page = filtered.slice(0, limit);

  let html = page.map(r => cfg.row(r)).join('');
  if (filtered.length > limit) {
    html += `<tr class="show-more-row"><td colspan="${cfg.cols}"><button class="btn-show-more" onclick="showMore('${type}')">Show more (${filtered.length - limit} remaining)</button></td></tr>`;
  }
  $(type + 'Body').innerHTML = html || empty(cfg.cols);
  observeThumbs($(type + 'Body'));
  if (type === 'mockups' || type === 'creativesValid') buildTotalRow(type, filtered);

  $$(`#${type}Table thead th`).forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === key);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmtF = n => parseFloat(n || 0).toFixed(2);
const fmtMoney = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoneyInt = n => '$' + Math.round(parseFloat(n || 0)).toLocaleString('en-US');

function thumb(url, isCatalog, cid) {
  if (!url) return `<div class="thumb-placeholder"${cid ? ` data-thumb-cid="${esc(cid)}" data-catalog="${isCatalog ? 1 : 0}"` : ''}>${PLACEHOLDER_SVG}</div>`;
  return `<img class="thumb" src="${esc(url)}"${isCatalog ? '' : ` onmouseenter="showThumbPreview(event)" onmouseleave="hideThumbPreview()" onclick="event.stopPropagation()"`} alt="" loading="lazy" onerror="thumbError(this)">`;
}

function thumbError(img) {
  const div = document.createElement('div');
  div.className = 'thumb-placeholder';
  div.innerHTML = PLACEHOLDER_SVG;
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

// Total row sits in <thead> right under the column names (like Shopify's Summary row),
// so it sticks with the header while the page scrolls.
function buildTotalRow(type, filtered) {
  const thead = document.querySelector(`#${type}Table thead`);
  thead.querySelector('.total-row')?.remove();
  if (filtered.length === 0) return;
  const tr = document.createElement('tr');
  tr.className = 'total-row';
  const printsTd = type === 'mockups' ? '<td></td>' : '';
  tr.innerHTML = `<td colspan="2"><b>Total (${filtered.length})</b></td>${printsTd}${metrics(totals(filtered))}`;
  thead.appendChild(tr);
}

function metrics(row) {
  return [
    fmtMoneyInt(row.spend), fmtF(row.roas) + 'x',
    fmtMoneyInt(row.cpr), fmtMoneyInt(row.aov),
    fmtMoneyInt(row.cpm), fmtF(row.ctr) + '%',
    fmtMoney(row.cpc),
  ].map(v => `<td class="td-metric">${v}</td>`).join('');
}
