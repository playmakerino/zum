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
// fmt = how a filter value is typed: money "$", pct "%", ratio "x" (Shopify filter fields)
const METRIC_COLS = [
  { key: 'spend', label: 'Spend', fmt: 'money' },
  { key: 'roas', label: 'ROAS', fmt: 'ratio' },
  { key: 'cpr', label: 'CPR', fmt: 'money' },
  { key: 'aov', label: 'AOV', fmt: 'money' },
  { key: 'cr', label: 'CR', tip: 'Purchases divided by clicks', fmt: 'pct' },
  { key: 'cpm', label: 'CPM', fmt: 'money' },
  { key: 'ctr', label: 'CTR', fmt: 'pct' },
  { key: 'cpc', label: 'CPC', fmt: 'money' },
].map(c => ({ ...c, type: 'metric' }));

// Campaign creation date (Triple Whale has none per ad); a grouped row shows its earliest ad
const CREATED_COL = { key: 'created_on', type: 'date', label: 'Created', tip: 'Creation date of the campaign. A row that groups several ads shows the earliest one.' };
const createdCell = r => `<td class="td-metric">${r.created_on ? fmtDay(r.created_on) : '–'}</td>`;

const creativeRow = r =>
  `<tr><td>${thumb(r.thumbnail_url, r.is_catalog)}</td><td class="td-name" title="${esc(r.ad_name)}">${esc(r.ad_name)}</td>${createdCell(r)}${metrics(r)}</tr>`;

const CREATIVE_TABLE = {
  cols: 11,
  columns: [null, { key: 'ad_name', type: 'text', label: 'Ad Name' }, CREATED_COL, ...METRIC_COLS],
  row: creativeRow,
};

const TABLES = {
  mockups: {
    cols: 12,
    columns: [
      null,
      { key: 'mockup_id', type: 'text', label: 'Mockup ID' },
      CREATED_COL,
      { key: 'print_count', type: 'metric', label: 'Prints' },
      ...METRIC_COLS,
    ],
    row: r => `<tr><td>${thumb(r.thumbnail_url, r.is_catalog)}</td><td class="td-name" title="${esc(r.mockup_id)}">${esc(r.mockup_id)}</td>${createdCell(r)}<td class="td-prints">${r.print_count}</td>${metrics(r)}</tr>`,
  },
  creativesValid: CREATIVE_TABLE,
  creativesSpend: CREATIVE_TABLE,
};

function buildHeaders() {
  for (const [type, cfg] of Object.entries(TABLES)) {
    const tr = document.querySelector(`#${type}Table thead tr`);
    tr.innerHTML = cfg.columns.map(col => {
      if (!col) return '<th aria-label="Thumbnail"></th>'; // image column has no title (Shopify)
      // filters live in the Controls panel (Shopify report), so headers hold only the name + sort
      if (col.type === 'text') return `<th><div class="th-content">${col.label}</div></th>`;
      // the column description sits on the ⓘ in the Controls panel; the name shows the sort hint
      return `<th data-sort="${col.key}" onclick="sortTable('${type}','${col.key}')"><div class="th-content">${col.label} <span class="sort-icon">&#x25B4;&#x25BE;</span></div></th>`;
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

// ── Date range + cache ───────────────────────────────────────────────────────
// Date range picker (shared.js DateRange, Shopify Analytics picker); one saved result per range
// its footer button is Load Data while the chosen range has no saved result (or is the one on screen)
const dateRange = DateRange.mount($('dateRange'), {
  storageKey: 'trang_mockup_range', onChange: onPeriodChange,
  isLoaded: r => { try { return !!localStorage.getItem(`trang_mockup_mockups_${r.key}`); } catch { return false; } },
  onLoad: () => fetchAll(),
  tip: ['Load Data', 'Reloads spend, sales and creatives from Triple Whale in a few seconds. Triple Whale runs a few hours behind Ads Manager.'],
});
const cacheKey = t => `trang_mockup_${t}_${dateRange.get().key}`;
const saveCache = (t, v) => { try { localStorage.setItem(cacheKey(t), JSON.stringify(v)); } catch {} };
const loadCache = t => { try { return JSON.parse(localStorage.getItem(cacheKey(t))); } catch { return null; } };

// ── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  buildHeaders();
  renderPanel();
  restoreLogs();

  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
  } catch {}

  if (state.config.hasTripleWhaleKey) showSaved();
});

// Show the result saved in this browser for the chosen range; empty tables when there is none.
function showSaved() {
  const m = loadCache('mockups'), c = loadCache('creatives');
  const blank = { current: [], period: null, cached_at: null };
  state.mockups = m || blank;
  state.creatives = c || blank;
  splitCreatives();
  for (const t of ['mockups', 'creativesValid', 'creativesSpend']) state.pageLimit[t] = PAGE_SIZE;
  if (m || c) {
    renderTable('mockups'); renderTable('creativesValid'); renderTable('creativesSpend');
  } else {
    for (const t of ['mockups', 'creativesValid', 'creativesSpend']) { $(t + 'Body').innerHTML = ''; buildTotalRow(t, []); }
    clearLog();
  }
  showCacheTime(state.mockups.cached_at || state.creatives.cached_at);
}
function onPeriodChange() { if (state.config.hasTripleWhaleKey) showSaved(); }

// ── Side panel (Shopify report editor): Dimensions = which table, Metrics = visible columns ──
const DIMENSIONS = [
  { key: 'mockups', label: 'Mockup' },
  { key: 'creativesValid', label: 'Image (full format)' },
  { key: 'creativesSpend', label: 'Image (high spend)' },
];
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const stored = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
let dimension = stored('trang_mockup_dimension', 'mockups');
let hiddenCols = stored('trang_mockup_hidden_cols', []);

function renderPanel() {
  if (!DIMENSIONS.some(d => d.key === dimension)) dimension = 'mockups';
  ReportPanel.section($('dimSec'), {
    title: 'Dimensions', options: DIMENSIONS, value: new Set([dimension]), multi: false,
    onChange: sel => { dimension = [...sel][0]; store('trang_mockup_dimension', dimension); renderPanel(); },
  });
  showDimension();
  renderMetricList();
  // Filters for the shown table: its name column (contains), Created (date) and the numbers
  const fields = TABLES[dimension].columns.filter(Boolean).map(c => ({ key: c.key, label: c.label, kind: c.type === 'metric' ? 'number' : c.type, fmt: c.fmt }));
  ReportPanel.filters($('filterSec'), { type: dimension, fields });
}
ReportPanel.toggle($('controlsBtn'), $('reportLayout'), 'trang_mockup_controls');

// columns of a table that can be hidden (all but thumbnail and name), with their header position
const hideable = type => TABLES[type].columns.map((c, i) => c && c.type !== 'text' ? { ...c, pos: i + 1 } : null).filter(Boolean);
function renderMetricList() {
  const cols = hideable(dimension);
  ReportPanel.section($('metricSec'), {
    title: 'Metrics', options: cols,
    value: new Set(cols.filter(c => !hiddenCols.includes(c.key)).map(c => c.key)),
    onChange: shown => {
      // keep the hidden state of columns this table does not have (Prints is only on Mockup)
      hiddenCols = [...hiddenCols.filter(k => !cols.some(c => c.key === k)), ...cols.filter(c => !shown.has(c.key)).map(c => c.key)];
      store('trang_mockup_hidden_cols', hiddenCols);
      renderMetricList();
    },
  });
  applyHidden();
}
function applyHidden() {
  for (const type of Object.keys(TABLES)) hideColumns(type + 'Table', hideable(type).filter(c => hiddenCols.includes(c.key)).map(c => c.pos));
}
function showDimension() {
  if (dimension === 'mockups') showPage('mockups');
  else { showPage('creatives'); showCreativeSub(dimension); }
}

// ── UI Helpers ───────────────────────────────────────────────────────────────
function showCacheTime(iso) {
  const el = $('headerCachedAt');
  if (!el || !iso) { if (el) el.textContent = ''; return; }
  el.textContent = refreshedText(iso);
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
  $('page-' + name).classList.add('active');
  hideThumbPreview();
}

function showCreativeSub(name) {
  $$('#page-creatives .sub-page').forEach(p => p.classList.remove('active'));
  $('sub-' + name).classList.add('active');
  hideThumbPreview();
}

// ── Fetch ────────────────────────────────────────────────────────────────────
async function fetchAll() {
  if (!state.config.hasTripleWhaleKey)
    return toast('Backend not configured (TRIPLE_WHALE_API_KEY missing)', 'error');

  const startTime = performance.now();
  const range = dateRange.get();

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
  lockLoadButtons(true);

  try {
    const res = await fetch(`/api/dashboard?since=${range.since}&until=${range.until}&refresh=1`);
    if (!res.ok) throw await httpError(res);
    let data = null;
    await readSSE(res, j => {
      if (j.progress) $$('.load-status').forEach(el => el.textContent = j.progress.replace(/\s*\[[\d.]+s\]\s*$/, ''));
      if (j.result) data = j.result;
      if (j.error) throw Object.assign(new Error(j.error), { detail: j.detail });
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

    $$('.load-overlay').forEach(el => el.style.display = 'none');

    const st = data.stats;
    const totalCreatives = state.creativesValid.current.length + state.creativesSpend.current.length;
    const fmt = state.creativesValid.current.length, hs = state.creativesSpend.current.length;
    // one part per step, in the order loadDashboard (server.js) runs them; same pattern on all
    // three dashboards (user's wording 2026-11-03)
    const result = [
      st && `${st.insights.rows} ads from Triple Whale`,
      st?.kept && `${st.kept.named} named ads, ${st.kept.highSpend} ads over $100`,
      `${totalCreatives} image hashes`,
      `${data.mockups.current.length} mockup ids`,
    ].filter(Boolean).join(' · ');
    clearLog();
    logTo('mockupsLoadLog', result, 'success');
    logTo('creativesLoadLog', result, 'success');
    if (st?.creativesOut && totalCreatives > st.creativesOut * 1.1) {
      logTo('creativesLoadLog', `Backend filter error: expected ${st.creativesOut} creatives, got ${totalCreatives}`, 'error');
    }
  } catch (err) {
    clearInterval(timerInterval);
    $$('.load-overlay').forEach(el => el.style.display = 'none');
    const msg = err.message + (err.detail ? ': ' + formatErrorDetail(err.detail) : '');
    clearLog();
    addLog(msg, 'error');
    toast('Error: ' + msg, 'error');
    for (const t of ['mockups', 'creativesValid', 'creativesSpend']) $(t + 'Body').innerHTML = empty(TABLES[t].cols);
  } finally {
    lockLoadButtons(false);
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
function enrichRow(row) {
  const clicks = parseFloat(row.clicks || 0);
  return {
    ...row,
    roas: parseFloat(row.roas || 0),
    cpr: parseFloat(row.cpr || 0),
    aov: parseFloat(row.aov || 0),
    cr: clicks ? parseFloat(row.purchase_count || 0) / clicks * 100 : 0,
    created_on: dateNum(row.created),
  };
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
  if (type === 'mockups' || type === 'creativesValid') buildTotalRow(type, filtered);

  $$(`#${type}Table thead th`).forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === key);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmtF = n => parseFloat(n || 0).toFixed(2);
const fmtMoney = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoneyInt = n => '$' + Math.round(parseFloat(n || 0)).toLocaleString('en-US');

function thumb(url, isCatalog) {
  if (!url) return `<div class="thumb-placeholder">${PLACEHOLDER_SVG}</div>`;
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
    cr:   clicks ? pc / clicks * 100 : 0,
    cpm: impr ? spend / impr * 1000 : 0,
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
  tr.innerHTML = `<td colspan="2">Summary</td><td class="td-metric"></td>${printsTd}${metrics(totals(filtered))}`;
  thead.appendChild(tr);
}

function metrics(row) {
  return [
    fmtMoneyInt(row.spend), fmtF(row.roas) + 'x',
    fmtMoneyInt(row.cpr), fmtMoneyInt(row.aov),
    fmtF(row.cr) + '%',
    fmtMoneyInt(row.cpm), fmtF(row.ctr) + '%',
    fmtMoney(row.cpc),
  ].map(v => `<td class="td-metric">${v}</td>`).join('');
}
