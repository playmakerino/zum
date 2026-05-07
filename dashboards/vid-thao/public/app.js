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

const PAGE_SIZE = 100;
const state = {
  config: Object.fromEntries(['metaToken','accountId'].map(k => [k, localStorage.getItem(k) || ''])),
  creatives: { current: [], period: null },
  sort: { creatives: { key: 'spend', dir: 1 } },
  filters: { creatives: {} },
  pageLimit: { creatives: PAGE_SIZE },
};

// Table config
const COL_LABELS = {
  spend: 'Spend', roas: 'ROAS', cpr: 'CPR', aov: 'AOV',
  cpm: 'CPM', ctr: 'CTR', cpc: 'CPC',
  video_3sec_rate: '3s/Impr', thruplay_rate: 'ThruPlay%', video_avg_time: 'Avg Time',
};
const TABLES = {
  creatives: {
    cols: 12, idKey: 'creative_id',
    row: r => `<tr><td>${thumb(r.thumbnail_url, r.is_catalog)}</td><td class="td-name" title="${esc(r.ad_name)}">${esc(r.ad_name)}</td>${metrics(r)}</tr>`
  }
};

const isVideo = r => (r.format || '').toLowerCase() === 'video';

// Cache
const cacheKey = (t, d) => `meta_cache_${state.config.accountId}_${t}_${d}`;
const saveCache = (t, d, v) => { try { localStorage.setItem(cacheKey(t, d), JSON.stringify(v)); } catch {} };
const loadCache = (t, d) => { try { return JSON.parse(localStorage.getItem(cacheKey(t, d))); } catch { return null; } };

// Init
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    if (cfg.hasMetaToken) state.config.metaToken = '__SERVER__';
    if (cfg.hasAdAccountId) state.config.accountId = '__SERVER__';
  } catch {}
  updatePeriodSelectLabels();
  if (state.config.accountId) {
    const days = $('periodSelect').value;
    const cached = loadCache('creatives', days);
    if (cached) {
      state.creatives = {
        ...cached,
        current: (cached.current || []).filter(isVideo),
      };
      renderTable('creatives');
      showCacheTime(cached.cached_at);
      updatePeriodSelectLabels(cached.period);
      renderDebug(loadCache('debug', days));
    } else {
      fetchAll(false); // auto-load from server cache
    }
  }
});

// Swap to cached data for the chosen period (or clear table if no cache).
function onPeriodChange() {
  const days = $('periodSelect').value;
  const cached = loadCache('creatives', days);
  if (cached) {
    state.creatives = {
      ...cached,
      current: (cached.current || []).filter(isVideo),
    };
    renderTable('creatives');
    showCacheTime(cached.cached_at);
    updatePeriodSelectLabels(cached.period);
    renderDebug(loadCache('debug', days));
  } else {
    state.creatives = { current: [], period: null };
    state.pageLimit.creatives = PAGE_SIZE;
    $('creativesBody').innerHTML = `<tr><td colspan="${TABLES.creatives.cols}"><div class="state-box">Click "Load Data" to load this period</div></td></tr>`;
    showCacheTime(null);
    updatePeriodSelectLabels();
    renderDebug(null);
  }
}

function showCacheTime(iso) {
  const el = $('cachedAt');
  if (!iso) { el.textContent = ''; return; }
  const d = new Date(iso);
  el.textContent = `Updated ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString('en-US')}`;
}

function renderDebug(d) {
  const el = $('debugLine');
  if (!el) return;
  if (!d) { el.textContent = ''; return; }
  const sec = (d.elapsedMs / 1000).toFixed(1);
  const parts = [
    `Loaded in ${sec}s`,
    `Insights: ${d.insights.raw} rows → ${d.insights.afterSpendFilter} with spend`,
    `Ads: ${d.ads.cached} cached, ${d.ads.fetched} fetched`,
    `Creatives: ${d.creatives.total} (${d.creatives.video} video)`,
    `HD thumbnails: ${d.hdThumbs.fetchable} creatives (${d.hdThumbs.cached} cached, ${d.hdThumbs.fetched} fetched)`,
  ];
  el.textContent = parts.join(' · ');
}

function showDebug(d) {
  console.log('[dashboard]', d);
  renderDebug(d);
  saveCache('debug', $('periodSelect').value, d);
}

function fmtDateLabel(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function parseIsoDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function updatePeriodSelectLabels(period) {
  const sel = $('periodSelect');
  if (!sel) return;
  for (const opt of sel.options) {
    const days = parseInt(opt.value, 10);
    let since, until;
    if (period && parseInt(sel.value, 10) === days) {
      since = fmtDateLabel(parseIsoDate(period.current.since));
      until = fmtDateLabel(parseIsoDate(period.current.until));
    } else {
      const today = new Date();
      const start = new Date(today);
      start.setDate(start.getDate() - days);
      since = fmtDateLabel(start);
      until = fmtDateLabel(today);
    }
    opt.textContent = `Last ${days} days: ${since} \u2013 ${until}`;
  }
}

// Fetch
async function fetchAll(refresh = true) {
  if (!state.config.metaToken || !state.config.accountId)
    return toast('Please enter Meta Token and Account ID first', 'error');

  const days = $('periodSelect').value;
  const headers = {};
  if (state.config.metaToken && state.config.metaToken !== '__SERVER__') headers['x-meta-token'] = state.config.metaToken;
  if (state.config.accountId && state.config.accountId !== '__SERVER__') headers['x-meta-account-id'] = state.config.accountId;

  // Show loading overlay
  const wrap = $('creativesTable').closest('.table-wrap');
  let ov = wrap.querySelector('.load-overlay');
  if (!ov) { ov = document.createElement('div'); ov.className = 'load-overlay'; wrap.appendChild(ov); }
  ov.innerHTML = `<div class="load-popup"><div class="loader"></div><div class="load-text" id="loadProgress-creatives">Connecting...</div></div>`;
  ov.style.display = 'flex';

  const startTime = performance.now();
  try {
    const res = await fetch(`/api/dashboard?days=${days}${refresh ? '&refresh=1' : ''}`, { headers });
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
            $$('.load-text').forEach(el => el.textContent = j.progress);
          }
          if (j.debug) showDebug(j.debug);
          if (j.result) data = j.result;
          if (j.error) throw new Error(j.error + ': ' + JSON.stringify(j.detail));
        } catch (e) { if (e.message) throw e; }
      }
    }

    if (!data) throw new Error('No data received');

    const fullCreatives = { current: data.creatives.current, period: data.period, cached_at: data.cached_at };
    saveCache('creatives', days, fullCreatives);
    state.creatives = {
      ...fullCreatives,
      current: fullCreatives.current.filter(isVideo),
    };

    renderTable('creatives');
    showCacheTime(data.cached_at);
    updatePeriodSelectLabels(data.period);

    $$('.load-overlay').forEach(el => el.style.display = 'none');
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    toast(`Loaded ${state.creatives.current.length} video creatives in ${elapsed}s`, 'success');
  } catch (err) {
    $$('.load-overlay').forEach(el => el.style.display = 'none');
    toast('Error: ' + err.message, 'error');
    $('creativesBody').innerHTML = empty(TABLES.creatives.cols);
  }
}

// Data helpers
function enrichRow(row) {
  return { ...row, roas: parseFloat(row.roas || 0), cpr: parseFloat(row.cpr || 0), aov: parseFloat(row.aov || 0) };
}

// Render
function renderTable(type) {
  const cfg = TABLES[type];
  const data = state[type];
  const { key, dir } = state.sort[type];
  const sorted = data.current.map(enrichRow).sort((a, b) => (parseFloat(b[key] || 0) - parseFloat(a[key] || 0)) * dir);

  const filtered = applyFilters(type, sorted);
  const limit = state.pageLimit[type];
  const page = filtered.slice(0, limit);

  let html = page.map(r => cfg.row(r)).join('');
  if (filtered.length > limit) {
    html += `<tr class="show-more-row"><td colspan="${cfg.cols}"><button class="btn-show-more" onclick="showMore('${type}')">Show more (${filtered.length - limit} remaining)</button></td></tr>`;
  }
  $(type + 'Body').innerHTML = html || empty(cfg.cols);

  $$(`#${type}Table thead th`).forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === key);
  });
  buildTotalRow(type, filtered);
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

// Pure filter: returns filtered subset of rows
function applyFilters(type, rows) {
  const metricFilters = state.filters[type];

  // Collect text/select filters from header row
  const colFilters = {};
  $$(`#${type}Table thead [data-col]`).forEach(el => {
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
      } else if (f.type === 'select') {
        if (f.value && String(row[col] || '') !== f.value) return false;
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

// Re-filter + re-render (called from filter inputs)
function filterTable(type) {
  state.pageLimit[type] = PAGE_SIZE;
  renderTable(type);
}

function totals(rows) {
  const s = k => rows.reduce((a, r) => a + parseFloat(r[k] || 0), 0);
  const spend = s('spend'), impr = s('impressions'), clicks = s('clicks');
  const pc = s('purchase_count'), pv = s('purchase_value');
  const v3sec = s('video_3sec_views');
  const vthru = s('video_thruplays');
  const vplays = s('video_plays');
  // Weighted avg play time: Σ(avg × plays) / Σ(plays)
  const weightedTime = rows.reduce((a, r) => a + parseFloat(r.video_avg_time || 0) * parseFloat(r.video_plays || 0), 0);
  return {
    spend,
    roas: spend ? pv / spend : 0,
    cpr:  pc ? spend / pc : 0,
    aov:  pc ? pv / pc : 0,
    cpm:  impr ? spend / impr * 1000 : 0,
    ctr:  impr ? clicks / impr * 100 : 0,
    cpc:  clicks ? spend / clicks : 0,
    video_3sec_rate: impr   ? v3sec  / impr   * 100 : 0,
    thruplay_rate:   vplays ? vthru  / vplays * 100 : 0,
    video_avg_time:  vplays ? weightedTime / vplays : 0,
  };
}

function buildTotalRow(type, filtered) {
  if (filtered.length === 0) return;
  const labelCols = 2;
  const tr = document.createElement('tr');
  tr.className = 'total-row';
  const emptyTds = '<td></td>'.repeat(labelCols - 1);
  tr.innerHTML = `<td><b>Total (${filtered.length})</b></td>${emptyTds}${metrics(totals(filtered))}`;
  $(type + 'Body').appendChild(tr);
}

// ── Filter Popup ──────────────────────────────────────────────────────────────
let _fpState = { type: null, col: null, btn: null };

function openFilterPopup(type, col, btn) {
  const popup = $('filterPopup');
  _fpState = { type, col, btn };

  // Load existing filter
  const existing = state.filters[type][col];
  $('filterOp').value = existing?.op || 'gt';
  $('filterVal1').value = existing?.val1 ?? '';
  $('filterVal2').value = existing?.val2 ?? '';
  $('filterPopupTitle').textContent = (COL_LABELS[col] || col) + ' Filter';
  onFilterOpChange();

  // Position popup near button, ensure it stays in viewport
  const rect = btn.getBoundingClientRect();
  popup.style.display = 'block';
  const popH = popup.offsetHeight;
  const popW = popup.offsetWidth;
  const top = rect.bottom + 4 + popH > window.innerHeight ? rect.top - popH - 4 : rect.bottom + 4;
  popup.style.top = Math.max(4, top) + 'px';
  popup.style.left = Math.min(rect.left, window.innerWidth - popW - 8) + 'px';

  // Close on outside click
  setTimeout(() => document.addEventListener('mousedown', _fpOutsideClick), 0);
}

function _fpOutsideClick(e) {
  const popup = $('filterPopup');
  if (!popup.contains(e.target) && e.target !== _fpState.btn) {
    cancelFilter();
  }
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
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5h13L9 8v5l-2 1.5V8z"/></svg> ${valStr}`;
    } else {
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5h13L9 8v5l-2 1.5V8z"/></svg>`;
    }
  });
}

// Helpers
const empty = cols => `<tr><td colspan="${cols}"><div class="state-box">No data</div></td></tr>`;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtF = n => parseFloat(n || 0).toFixed(2);
const fmtMoney = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function thumb(url, isCatalog) {
  const placeholder = `<div class="thumb-placeholder"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></div>`;
  if (!url) return placeholder;
  return `<img class="thumb" src="${esc(url)}"${isCatalog ? '' : ` onmouseenter="showThumbPreview(event)" onmouseleave="hideThumbPreview()" onclick="event.stopPropagation()"`} alt="" loading="lazy" onerror="thumbError(this)">`;
}
function thumbError(img) {
  const div = document.createElement('div');
  div.className = 'thumb-placeholder';
  div.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
  img.replaceWith(div);
}

const _thumbPreview = (() => {
  const el = document.createElement('img');
  el.style.cssText = 'display:none;position:fixed;width:240px;height:240px;object-fit:cover;border-radius:8px;border:1px solid #ced4da;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:9998;background:#fff;pointer-events:none';
  el.onerror = () => { el.style.display = 'none'; };
  document.body.appendChild(el);
  return el;
})();

function showThumbPreview(e) {
  const src = e.target.src;
  _thumbPreview.onload = function() { _thumbPreview.style.display = 'block'; };
  _thumbPreview.src = src;
  // Shrink preview on narrow viewports so it never dominates the screen
  const size = Math.min(240, window.innerWidth - 24, window.innerHeight - 24);
  _thumbPreview.style.width = size + 'px';
  _thumbPreview.style.height = size + 'px';
  const rect = e.target.getBoundingClientRect();
  let top  = rect.top + rect.height / 2 - size / 2;
  let left = rect.right + 10;
  if (left + size > window.innerWidth) left = rect.left - size - 10;
  if (left < 4) left = 4;
  if (top + size > window.innerHeight) top = window.innerHeight - size - 4;
  if (top < 4) top = 4;
  _thumbPreview.style.top = top + 'px';
  _thumbPreview.style.left = left + 'px';
}

function hideThumbPreview() {
  _thumbPreview.style.display = 'none';
}
document.addEventListener('click', hideThumbPreview);

const fmtTime = n => {
  const v = parseFloat(n || 0);
  if (v <= 0) return '0s';
  if (v < 60) return v.toFixed(1) + 's';
  const m = Math.floor(v / 60);
  const s = (v - m * 60).toFixed(0);
  return `${m}m ${s}s`;
};

function metrics(row) {
  return [
    [row.spend, fmtMoney],
    [row.roas, v => fmtF(v) + 'x'],
    [row.cpr, fmtMoney],
    [row.aov, fmtMoney],
    [row.cpm, fmtMoney],
    [row.ctr, v => fmtF(v) + '%'],
    [row.cpc, fmtMoney],
    [row.video_3sec_rate, v => fmtF(v) + '%'],
    [row.thruplay_rate,   v => fmtF(v) + '%'],
    [row.video_avg_time,  fmtTime],
  ].map(([c, f]) => `<td>${f(c)}</td>`).join('');
}

// Toast
let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3500);
}
