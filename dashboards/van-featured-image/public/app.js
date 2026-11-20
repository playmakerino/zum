const COLS = 6;
// The page starts on "Status is Active", as the old main button Load Active Ads did
// (the old Load All = remove the filter, or pick both statuses)
const ACTIVE_ONLY = { status: { kind: 'select', op: 'is', val1: 'ACTIVE' } };
const state = {
  config: {}, // { hasTripleWhaleKey } from /api/config
  ads: { data: [], period: null, cached_at: null },
  sort: { ads: { key: 'print_id', dir: -1 } },
  // adsStatus = only the Status filter, applied to every ad before the top ad per design is picked
  filters: { ads: { ...ACTIVE_ONLY }, adsStatus: {} },
  pageLimit: { ads: PAGE_SIZE },
};

// ── Controls panel (Shopify report): Filters + Metrics, like vid-thao / trang-mockup ──
const STATUS_OPTIONS = [{ key: 'ACTIVE', label: 'Active' }, { key: 'PAUSED', label: 'Paused' }];
const METRIC_COLS = [
  { key: 'spend', label: 'Spend', kind: 'number', fmt: 'money', pos: 5, tip: 'Amount spent on this ad in the last 12 months' },
  { key: 'roas', label: 'ROAS', kind: 'number', fmt: 'ratio', pos: 6, tip: 'Purchase value divided by spend' },
];
let hiddenCols = (() => { try { return JSON.parse(localStorage.getItem('van_hidden_cols')) || []; } catch { return []; } })();
function renderMetricPanel() {
  ReportPanel.section($('metricSec'), {
    title: 'Metrics', options: METRIC_COLS,
    value: new Set(METRIC_COLS.filter(c => !hiddenCols.includes(c.key)).map(c => c.key)),
    onChange: shown => {
      hiddenCols = METRIC_COLS.filter(c => !shown.has(c.key)).map(c => c.key);
      try { localStorage.setItem('van_hidden_cols', JSON.stringify(hiddenCols)); } catch {}
      renderMetricPanel();
    },
  });
  hideColumns('adsTable', METRIC_COLS.filter(c => hiddenCols.includes(c.key)).map(c => c.pos));
}
renderMetricPanel();
ReportPanel.filters($('filterSec'), { type: 'ads', fields: [
  { key: 'status', label: 'Status', kind: 'select', options: () => STATUS_OPTIONS },
  { key: 'print_id', label: 'Print ID', kind: 'text' },
  { key: 'ad_name', label: 'Ad name', kind: 'text' },
  ...METRIC_COLS,
] });
ReportPanel.toggle($('controlsBtn'), $('reportLayout'), 'van_controls');

// Highest-spend ad of each design (print-type) among the ads the Status filter keeps
function topPerDesign(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = r.group || r.ad_name;
    if (!best.has(k) || parseFloat(r.spend) > parseFloat(best.get(k).spend)) best.set(k, r);
  }
  return [...best.values()];
}

const TABLES = {
  ads: {
    row: r => `<tr><td>${thumb(r.image_url)}</td><td>${esc(r.print_id)}</td><td class="td-name">${esc(r.ad_name)}</td><td class="td-link">${linkCell(r.link)}</td><td class="td-metric">${fmtMoneyInt(r.spend)}</td><td class="td-metric">${fmtF(r.roas)}x</td></tr>`
  },
};

// Result saved in this browser (key named in the days of the token form; kept so saved results survive)
const CACHE_KEY = 'meta_cache___SERVER___ads_alltime';
const saveCache = v => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch {} };
const loadCacheLocal = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; } };

// Init
window.addEventListener('DOMContentLoaded', async () => {
  restoreLogs();

  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
  } catch {}

  if (state.config.hasTripleWhaleKey) {
    // results saved before 2026-11-19 hold only the top ad per design, without status: load again
    const cached = loadCacheLocal();
    if (cached && cached.data?.[0]?.status !== undefined) {
      state.ads = cached;
      renderTable('ads');
      showCacheTime(cached.cached_at);
    }
  }
});

function showCacheTime(iso) {
  const el = $('headerCachedAt');
  if (!el || !iso) { if (el) el.textContent = ''; return; }
  const months = state.ads.lookback_months;
  el.title = state.ads.period ? `${state.ads.period.since} → ${state.ads.period.until}` : '';
  el.textContent = `${months ? `Last ${months} months · ` : ''}${refreshedText(iso)}`;
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
async function fetchAll() {
  if (!state.config.hasTripleWhaleKey)
    return toast('Backend not configured (TRIPLE_WHALE_API_KEY missing)', 'error');

  try { localStorage.removeItem(CACHE_KEY); } catch {}

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
  lockLoadButtons(true);
  try {
    const res = await fetch('/api/dashboard');
    if (!res.ok) throw await httpError(res);
    let data = null;
    await readSSE(res, j => {
      if (j.progress) {
        const el = wrap.querySelector('.load-status');
        if (el) el.textContent = j.progress.replace(/\s*\[[\d.]+s\]\s*$/, '');
      }
      if (j.result) data = j.result;
      if (j.error) throw Object.assign(new Error(j.error), { detail: j.detail });
    });
    if (!data) throw new Error('No data received');
    clearInterval(timerInterval);

    state.ads = { data: data.ads, period: data.period, cached_at: data.cached_at, lookback_months: data.lookback_months };
    saveCache(state.ads);
    renderTable('ads');
    showCacheTime(data.cached_at);
    ov.style.display = 'none';

    // one part per step, in the order loadDashboard (server.js) runs them; same pattern on all
    // three dashboards (user's wording 2026-11-03)
    addLog([
      `${data.totalRows} image ads over $100 from Triple Whale`,
      `${data.designCount} designs`,
    ].join(' · '), 'success');
  } catch (err) {
    clearInterval(timerInterval);
    ov.style.display = 'none';
    const msg = err.message + (err.detail ? ': ' + formatErrorDetail(err.detail) : '');
    addLog(msg, 'error');
    toast('Error: ' + msg, 'error');
    $('adsBody').innerHTML = empty(COLS);
  } finally {
    lockLoadButtons(false);
  }
}

// Render
function renderTable(type) {
  const cfg = TABLES[type];
  const { key, dir } = state.sort[type];
  // Status first (on every ad), then the top ad per design, then the other filters on those rows
  state.filters.adsStatus = state.filters.ads.status ? { status: state.filters.ads.status } : {};
  const data = topPerDesign(applyFilters('adsStatus', state[type].data || []));
  const sorted = data.sort((a, b) => {
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
  $(type + 'Body').innerHTML = html || empty(COLS);

  $$(`#${type}Table thead th`).forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === key);
    // Print ID sorts A to Z with dir 1, numbers sort highest first with dir 1
    th.classList.toggle('asc', th.dataset.sort === key && dir === (key === 'print_id' ? 1 : -1));
  });
  fitTable();
}

// Helpers
const fmtF = n => parseFloat(n || 0).toFixed(2);
const fmtMoneyInt = n => '$' + Math.round(parseFloat(n || 0)).toLocaleString('en-US');
function linkCell(url) {
  if (!url) return '';
  const display = url.replace(/^https?:\/\//, '').replace(/^(www\.)?zumbamboo\.com/, '').replace(/\/$/, '');
  return `<a href="${esc(url)}" target="_blank" rel="noopener" class="link-cell">${esc(display)}</a>`;
}

function thumb(url) {
  if (!url) return `<div class="thumb-placeholder">${PLACEHOLDER_SVG}</div>`;
  return `<img class="thumb" src="${esc(url)}" onmouseenter="showThumbPreview(event)" onmouseleave="hideThumbPreview()" onclick="event.stopPropagation();showThumbPreview(event)" alt="" loading="lazy" onerror="thumbError(this)">`;
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

function hideThumbPreview() {
  _thumbPreview.style.display = 'none';
}
document.addEventListener('click', hideThumbPreview);
