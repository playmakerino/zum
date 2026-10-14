const COLS = 6;
const state = {
  config: {}, // { hasMetaToken, hasAdAccountId } from /api/config
  ads: { data: [], period: null, cached_at: null },
  sort: { ads: { key: 'print_id', dir: -1 } },
  filters: { ads: {} },
  pageLimit: { ads: PAGE_SIZE },
  mode: (() => { try { return localStorage.getItem('van_mode') === 'all' ? 'all' : 'active'; } catch { return 'active'; } })(),
};

// Card title shows which mode the table currently holds ("Active ads" / "All ads").
function setMode(mode) {
  state.mode = mode;
  try { localStorage.setItem('van_mode', mode); } catch {}
  $('modeTitle').textContent = mode === 'all' ? 'All ads' : 'Active ads';
}

const TABLES = {
  ads: {
    row: r => `<tr><td>${thumb(r.image_url)}</td><td>${esc(r.print_id)}</td><td class="td-name" title="${esc(r.ad_name)}">${esc(r.ad_name)}</td><td>${linkCell(r.link)}</td><td class="td-metric">${fmtMoneyInt(r.spend)}</td><td class="td-metric">${fmtF(r.roas)}x</td></tr>`
  },
};

// Result saved in this browser (key named in the days of the token form; kept so saved results survive)
const CACHE_KEY = 'meta_cache___SERVER___ads_alltime';
const saveCache = v => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch {} };
const loadCacheLocal = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; } };

// Init
window.addEventListener('DOMContentLoaded', async () => {
  setMode(state.mode);
  restoreLogs();

  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
  } catch {}

  if (state.config.hasAdAccountId) {
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
  const months = state.ads.lookback_months;
  const range = months ? `Last ${months} months · ` : '';
  el.title = state.ads.period ? `${state.ads.period.since} → ${state.ads.period.until}` : '';
  el.textContent = `${range}Updated ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString('en-US')}`;
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
  if (!state.config.hasMetaToken || !state.config.hasAdAccountId)
    return toast('Meta Token and Account ID not configured', 'error');

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
    const res = await fetch(`/api/dashboard?mode=${mode}`);
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

    setMode(mode);
    const modeLabel = mode === 'active' ? 'Active' : 'All';
    const fetchLabel = data.incremental ? 'incremental' : 'full';
    addLog(`${modeLabel} (${fetchLabel}): ${data.totalRows} insight rows → ${data.topAdsCount} spend>$100 → ${data.imageAdsCount} image ads | ${data.adsWithImage} has image · ${data.adsWithLink} has link`, 'success');
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
  $(type + 'Body').innerHTML = html || empty(COLS);

  $$(`#${type}Table thead th`).forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === key);
  });
}

// Helpers
const fmtF = n => parseFloat(n || 0).toFixed(2);
const fmtMoneyInt = n => '$' + Math.round(parseFloat(n || 0)).toLocaleString('en-US');
function linkCell(url) {
  if (!url) return '';
  const display = url.replace(/^https?:\/\//, '').replace(/^(www\.)?zumbamboo\.com/, '').replace(/\/$/, '');
  return `<a href="${esc(url)}" target="_blank" rel="noopener" class="link-cell" title="${esc(url)}">${esc(display)}</a>`;
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
