require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const path      = require('path');
const fs        = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const META_BASE_URL = `https://graph.facebook.com/v22.0`;

// Non-blocking cache write (fire-and-forget)
function saveCacheAsync(filePath, data) {
  fs.writeFile(filePath, JSON.stringify(data), err => {
    if (err) console.error(`Cache write error (${path.basename(filePath)}):`, err.message);
  });
}

// ── File-based cache for creative info (30 day TTL) ─────────────────────────
const CACHE_FILE = path.join(__dirname, '.cache-creatives.json');
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

function slimCreative(ad) {
  const c = ad.creative;
  if (!c) return { id: ad.id, creative: null, _cachedAt: ad._cachedAt || Date.now() };
  return {
    id: ad.id,
    creative: {
      id:           c.id,
      name:         c.name || '',
      object_type:  c.object_type || '',
      primary_text: c.primary_text || '',
      is_catalog:   !!c.object_story_spec?.template_data,
    },
    _cachedAt: ad._cachedAt || Date.now(),
  };
}

function loadCacheFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const now = Date.now();
      const filtered = {};
      let migrated = false;
      for (const [id, entry] of Object.entries(raw)) {
        if (entry._cachedAt && (now - entry._cachedAt) > CACHE_TTL) continue;
        // Auto-migrate old bulky entries to slim format
        if (entry.creative?.object_story_spec || entry.creative?.asset_feed_spec) {
          const primaryText = entry.creative?.asset_feed_spec?.bodies?.[0]?.text
            || entry.creative?.object_story_spec?.link_data?.message
            || entry.creative?.object_story_spec?.video_data?.message
            || entry.creative?.object_story_spec?.photo_data?.message
            || entry.creative?.name || '';
          filtered[id] = slimCreative({ ...entry, creative: { ...entry.creative, primary_text: primaryText } });
          migrated = true;
        } else {
          filtered[id] = entry;
        }
      }
      if (migrated) saveCacheAsync(CACHE_FILE, filtered);
      return filtered;
    }
  } catch (e) { console.error('Cache read error:', e.message); }
  return {};
}

let creativeCache = loadCacheFromFile();

// ── File-based cache for insights (survive server restart) ──────────────────
const INSIGHTS_CACHE_FILE = path.join(__dirname, '.cache-insights.json');

function loadInsightsCacheFromFile() {
  try {
    if (fs.existsSync(INSIGHTS_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(INSIGHTS_CACHE_FILE, 'utf8'));
    }
  } catch (e) { console.error('Insights cache read error:', e.message); }
  return {};
}

let insightsCache = loadInsightsCacheFromFile();

// ── File-based cache for HD thumbnails (creative_id → {url, _cachedAt}) ──────
const HD_THUMB_CACHE_FILE = path.join(__dirname, '.cache-hd-thumbs.json');
const HD_THUMB_TTL = 24 * 60 * 60 * 1000; // 24 hours (Meta CDN URLs expire quickly)

function loadHdThumbCache() {
  try {
    if (fs.existsSync(HD_THUMB_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HD_THUMB_CACHE_FILE, 'utf8'));
      const now = Date.now();
      const filtered = {};
      let changed = false;
      for (const [id, entry] of Object.entries(raw)) {
        if (typeof entry === 'string') { changed = true; continue; }
        if (entry._cachedAt && (now - entry._cachedAt) > HD_THUMB_TTL) { changed = true; continue; }
        filtered[id] = entry;
      }
      if (changed) saveCacheAsync(HD_THUMB_CACHE_FILE, filtered);
      return filtered;
    }
  } catch (e) { console.error('HD thumb cache read error:', e.message); }
  return {};
}

let hdThumbCache = loadHdThumbCache();

const AD_METRICS = [
  'impressions', 'clicks', 'spend', 'reach',
  'ctr', 'cpc', 'cpm',
  'actions', 'action_values',
  'frequency',
  'unique_clicks', 'unique_ctr',
  'video_thruplay_watched_actions',
  'video_avg_time_watched_actions',
  'video_play_actions',
].join(',');

const POLL_MAX_ATTEMPTS = 60;
const POLL_INTERVAL_MS  = 2000;
const BATCH_SIZE        = 50;

const FORMAT_MAP = { VIDEO: 'Video', SHARE: 'Image', PHOTO: 'Carousel' };

// ── Pure helpers (testable) ──────────────────────────────────────────────────

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function sumActionValue(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((s, a) => s + parseFloat(a.value || 0), 0);
}

// Sum action values matching a specific action_type. 3-second video views in v22
// are exposed as `actions[].action_type === 'video_view'`.
function sumActionByType(arr, type) {
  if (!Array.isArray(arr)) return 0;
  return arr.filter(a => a.action_type === type).reduce((s, a) => s + parseFloat(a.value || 0), 0);
}

function findPurchaseAction(arr = []) {
  return arr.find(x => x.action_type === 'purchase' || x.action_type === 'omni_purchase');
}

function aggregateMetrics(entry, rows) {
  const sum = fn => rows.reduce((s, r) => s + fn(r), 0);
  for (const f of ['impressions', 'clicks', 'spend', 'reach', 'unique_clicks', 'frequency']) {
    entry[f] = sum(r => parseFloat(r[f] || 0));
  }
  entry.ctr = entry.impressions ? (entry.clicks / entry.impressions * 100).toFixed(2) : '0';
  entry.cpc = entry.clicks      ? (entry.spend  / entry.clicks).toFixed(2)             : '0';
  entry.cpm = entry.impressions ? (entry.spend  / entry.impressions * 1000).toFixed(2) : '0';
  entry.purchase_count = sum(r => parseFloat(findPurchaseAction(r.actions)?.value       || 0));
  entry.purchase_value = sum(r => parseFloat(findPurchaseAction(r.action_values)?.value || 0));
  entry.roas = entry.spend > 0 && entry.purchase_value > 0 ? entry.purchase_value / entry.spend : 0;
  entry.cpr  = entry.purchase_count > 0 ? entry.spend / entry.purchase_count : 0;
  entry.aov  = entry.purchase_count > 0 ? entry.purchase_value / entry.purchase_count : 0;

  // Video metrics
  entry.video_3sec_views = sum(r => sumActionByType(r.actions, 'video_view'));
  entry.video_thruplays  = sum(r => sumActionValue(r.video_thruplay_watched_actions));
  entry.video_plays      = sum(r => sumActionValue(r.video_play_actions));
  // Weighted avg play time = Σ(avg_time × plays) / Σ(plays)
  const weightedTime = rows.reduce((s, r) => {
    const avg   = sumActionValue(r.video_avg_time_watched_actions);
    const plays = sumActionValue(r.video_play_actions);
    return s + avg * plays;
  }, 0);
  entry.video_avg_time   = entry.video_plays > 0 ? weightedTime / entry.video_plays : 0;
  entry.video_3sec_rate  = entry.impressions  > 0 ? entry.video_3sec_views / entry.impressions * 100 : 0;
  entry.thruplay_rate    = entry.video_plays  > 0 ? entry.video_thruplays  / entry.video_plays  * 100 : 0;
  return entry;
}

function buildPrimaryTextMap(allAds) {
  const map = {};
  for (const ad of allAds) {
    const cid = ad.creative?.id;
    if (!cid) continue;
    const text = ad.creative?.asset_feed_spec?.bodies?.[0]?.text
      || ad.creative?.object_story_spec?.link_data?.message
      || ad.creative?.object_story_spec?.video_data?.message
      || ad.creative?.object_story_spec?.photo_data?.message
      || ad.creative?.name
      || '';
    if (text) map[cid] = text;
  }
  return map;
}

// Group rows (with attached creative) by creative_id and aggregate metrics.
function groupByCreative(rows) {
  const map = {};
  for (const row of rows) {
    const id = row.creative?.id || 'unknown';
    if (!map[id]) {
      map[id] = {
        creative_id:   id,
        primary_text:  row.creative?.primary_text || '',
        format:        row.creative ? (FORMAT_MAP[row.creative.object_type] || 'Image') : null,
        thumbnail_url: row.creative?.thumbnail_url || null,
        is_catalog:    !!row.creative?.is_catalog,
        ad_name:       row.ad_name || '',
        _rows:         [],
      };
    }
    map[id]._rows.push(row);
  }
  return Object.values(map).map(({ _rows, ...entry }) => aggregateMetrics(entry, _rows));
}

function buildCreativeMap(allAds, hdThumbMap) {
  const map = {};
  for (const ad of allAds) {
    const c = ad.creative;
    if (!c) continue;
    map[ad.id] = {
      id:           c.id,
      name:         c.name || '',
      object_type:  c.object_type || '',
      primary_text: c.primary_text || '',
      is_catalog:   !!c.is_catalog,
      thumbnail_url: hdThumbMap[c.id] || null,
    };
  }
  return map;
}

function uniqueAdIds(rows) {
  return [...new Set(rows.map(r => r.ad_id).filter(Boolean))];
}

function collectFetchableCreativeIds(allAds) {
  const ids = new Set();
  for (const ad of allAds) {
    const c = ad.creative;
    if (!c?.id) continue;
    if (c.is_catalog) continue;
    if (!['SHARE', 'VIDEO'].includes(c.object_type)) continue;
    ids.add(c.id);
  }
  return [...ids];
}

function collectAllCreativeIds(allAds) {
  const ids = new Set();
  for (const ad of allAds) {
    if (ad.creative?.id) ids.add(ad.creative.id);
  }
  return [...ids];
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function getCredentials(req) {
  const token = req.headers['x-meta-token'] || process.env.META_ACCESS_TOKEN || '';
  const rawAccount = (req.headers['x-meta-account-id'] || process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, '');
  return {
    token:     /^[A-Za-z0-9_\-]+$/.test(token) ? token : '',
    accountId: /^[0-9]+$/.test(rawAccount) ? rawAccount : '',
  };
}

// Async report: create → poll → fetch all results
async function fetchInsightsAsync(base, token, fields, timeRange, onProgress) {
  const createRes = await axios.post(`${base}/insights`, null, {
    params: {
      access_token: token, level: 'ad', fields,
      time_range: JSON.stringify(timeRange),
    },
  });

  // Meta may return data directly for small datasets
  if (createRes.data.data) return createRes.data.data;

  const reportId = createRes.data.report_run_id;
  if (!reportId) throw new Error('No report_run_id returned from Meta');

  let completed = false;
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const poll = await axios.get(`${META_BASE_URL}/${reportId}`, { params: { access_token: token } });
    const status = poll.data.async_status;
    const pct = poll.data.async_percent_completion || 0;
    if (onProgress) onProgress(status, pct);
    if (status === 'Job Completed') { completed = true; break; }
    if (status === 'Job Failed' || status === 'Job Skipped') {
      throw new Error(`Async report ${status}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!completed) throw new Error(`Async report timed out after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);

  // Fetch all results with pagination
  const results = [];
  let url = `${META_BASE_URL}/${reportId}/insights`;
  let params = { access_token: token, limit: 500 };
  while (url) {
    const res = await axios.get(url, { params });
    results.push(...(res.data.data || []));
    const next = res.data.paging?.next || null;
    url = next;
    params = next ? {} : null;
  }
  return results;
}

async function fetchAdsByIds(token, adIds, fields) {
  if (!adIds.length) return [];
  const results = [];
  for (let i = 0; i < adIds.length; i += BATCH_SIZE) {
    const batch = adIds.slice(i, i + BATCH_SIZE);
    try {
      const res = await axios.get(`${META_BASE_URL}/`, {
        params: { ids: batch.join(','), fields, access_token: token }
      });
      for (const [id, data] of Object.entries(res.data)) {
        if (data && !data.error) results.push(data);
      }
    } catch (err) {
      console.error(`Batch fetch failed (${batch.length} ads):`, err.response?.data?.error?.message || err.message);
    }
  }
  return results;
}

// ── Pipeline stages ──────────────────────────────────────────────────────────

async function loadOrFetchInsights({ days, forceRefresh, base, token, fields, current, progress, elapsed }) {
  const cacheKey = String(days);
  const ic = insightsCache[cacheKey];
  if (!forceRefresh && ic) {
    progress(`Using cached insights (${ic.current.length} rows) [${elapsed()}]`);
    return ic.current;
  }
  progress(`Creating async report... [${elapsed()}]`);
  const currRows = await fetchInsightsAsync(base, token, fields, current, (s, p) => {
    progress(`Polling report: ${p}% [${elapsed()}]`);
  });
  insightsCache[cacheKey] = { current: currRows };
  saveCacheAsync(INSIGHTS_CACHE_FILE, insightsCache);
  progress(`Insights loaded: ${currRows.length} rows [${elapsed()}]`);
  return currRows;
}

async function ensureCreativeInfo({ adIds, token, progress, elapsed }) {
  const missingIds = adIds.filter(id => !creativeCache[id]);
  if (missingIds.length === 0) {
    progress(`All ${adIds.length} ads already cached [${elapsed()}]`);
    return;
  }
  progress(`Fetching creative info for ${missingIds.length} new ads... [${elapsed()}]`);
  const fetched = await fetchAdsByIds(token, missingIds, 'id,creative{id,name,object_type,asset_feed_spec,object_story_spec}');
  const ptMap = buildPrimaryTextMap(fetched);
  const now = Date.now();
  for (const ad of fetched) {
    if (ad.creative?.id && ptMap[ad.creative.id]) {
      ad.creative.primary_text = ptMap[ad.creative.id];
    }
    creativeCache[ad.id] = slimCreative({ ...ad, _cachedAt: now });
  }
  for (const id of missingIds) {
    if (!creativeCache[id]) creativeCache[id] = { id, creative: null, _cachedAt: now };
  }
  saveCacheAsync(CACHE_FILE, creativeCache);
  progress(`Creative info cached (${fetched.length} ads) [${elapsed()}]`);
}

function pruneCreativeCache(activeAdIds) {
  const set = new Set(activeAdIds);
  let pruned = false;
  for (const id of Object.keys(creativeCache)) {
    if (!set.has(id)) { delete creativeCache[id]; pruned = true; }
  }
  if (pruned) saveCacheAsync(CACHE_FILE, creativeCache);
}

async function ensureHdThumbnails({ creativeIds, token, progress, elapsed }) {
  const missing = creativeIds.filter(cid => !hdThumbCache[cid]);
  if (missing.length === 0) {
    if (creativeIds.length > 0) progress(`All ${creativeIds.length} HD thumbnails cached [${elapsed()}]`);
    return;
  }
  progress(`Fetching HD thumbnails for ${missing.length} new creatives... [${elapsed()}]`);
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    try {
      const res = await axios.get(`${META_BASE_URL}/`, {
        params: { ids: batch.join(','), fields: 'thumbnail_url', thumbnail_width: 480, thumbnail_height: 480, access_token: token }
      });
      for (const [id, data] of Object.entries(res.data)) {
        if (data?.thumbnail_url) hdThumbCache[id] = { url: data.thumbnail_url, _cachedAt: Date.now() };
      }
    } catch (err) {
      console.error('HD thumb fetch error:', err.response?.data?.error?.message || err.message);
    }
  }
  saveCacheAsync(HD_THUMB_CACHE_FILE, hdThumbCache);
  progress(`Fetched HD thumbnails for ${missing.length} creatives [${elapsed()}]`);
}

function pruneHdThumbCache(activeCreativeIds) {
  const set = new Set(activeCreativeIds);
  let pruned = false;
  for (const id of Object.keys(hdThumbCache)) {
    if (!set.has(id)) { delete hdThumbCache[id]; pruned = true; }
  }
  if (pruned) saveCacheAsync(HD_THUMB_CACHE_FILE, hdThumbCache);
}

function metaErrorMessage(err) {
  const metaError = err.response?.data?.error;
  if (!metaError) return { error: 'Meta API error', detail: err.response?.data || err.message };
  const { code, error_subcode: subcode, message } = metaError;
  if (code === 190) {
    const detail = subcode === 463
      ? 'Token has expired. Please generate a new access token from Meta Business Suite and update META_ACCESS_TOKEN in .env.'
      : subcode === 467
        ? 'Token is no longer valid. The user may have changed their password or revoked access.'
        : `Token error (subcode ${subcode}): ${message}`;
    return { error: 'Meta API token expired or invalid', detail };
  }
  if (code === 4 || code === 17) {
    return { error: 'Meta API rate limit reached', detail: 'Too many requests. Please wait a few minutes before trying again.' };
  }
  return { error: 'Meta API error', detail: err.response?.data || err.message };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    hasMetaToken:   !!process.env.META_ACCESS_TOKEN,
    hasAdAccountId: !!process.env.META_AD_ACCOUNT_ID,
  });
});

// GET /api/dashboard?days=7 — SSE with progress updates
app.get('/api/dashboard', async (req, res) => {
  const { token, accountId } = getCredentials(req);
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });

  const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 90);
  const forceRefresh = req.query.refresh === '1';
  const current = { since: dateStr(days), until: dateStr(0) };
  const fields  = `ad_id,ad_name,${AD_METRICS}`;
  const base    = `${META_BASE_URL}/act_${accountId}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const progress = msg => res.write(`data: ${JSON.stringify({ progress: msg })}\n\n`);
  const startTime = Date.now();
  const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  try {
    const currRows = await loadOrFetchInsights({ days, forceRefresh, base, token, fields, current, progress, elapsed });

    const allAdIds = uniqueAdIds(currRows);
    await ensureCreativeInfo({ adIds: allAdIds, token, progress, elapsed });
    pruneCreativeCache(allAdIds);
    const allAds = allAdIds.map(id => creativeCache[id]).filter(Boolean);

    await ensureHdThumbnails({ creativeIds: collectFetchableCreativeIds(allAds), token, progress, elapsed });
    pruneHdThumbCache(collectAllCreativeIds(allAds));

    const hdThumbMap = {};
    for (const [id, entry] of Object.entries(hdThumbCache)) hdThumbMap[id] = entry.url;
    const creativeMap = buildCreativeMap(allAds, hdThumbMap);
    const enriched = currRows
      .filter(r => parseFloat(r.spend || 0) > 0)
      .map(r => ({ ...r, creative: creativeMap[r.ad_id] || null }));

    progress(`Processing data... [${elapsed()}]`);
    const result = {
      creatives: { current: groupByCreative(enriched) },
      period:    { current },
      cached_at: new Date().toISOString(),
    };
    progress(`Done [${elapsed()}]`);
    res.write(`data: ${JSON.stringify({ result })}\n\n`);
    res.end();
  } catch (err) {
    const { error, detail } = metaErrorMessage(err);
    res.write(`data: ${JSON.stringify({ error, detail })}\n\n`);
    res.end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Meta Ads Dashboard running on http://localhost:${PORT}`));
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    dateStr,
    findPurchaseAction,
    sumActionValue,
    sumActionByType,
    aggregateMetrics,
    groupByCreative,
    buildPrimaryTextMap,
    buildCreativeMap,
    uniqueAdIds,
    collectFetchableCreativeIds,
    collectAllCreativeIds,
  };
}
