require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const path      = require('path');
const fs        = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const META_BASE_URL = 'https://graph.facebook.com/v22.0';
const DAYS = 30;

let _tmpCounter = 0;
function saveCacheAsync(filePath, data) {
  const tmp = `${filePath}.${process.pid}-${++_tmpCounter}.tmp`;
  fs.writeFile(tmp, JSON.stringify(data), err => {
    if (err) { console.error(`Cache write error (${path.basename(filePath)}):`, err.message); return; }
    fs.rename(tmp, filePath, err2 => {
      if (err2) { console.error(`Cache rename error (${path.basename(filePath)}):`, err2.message); fs.unlink(tmp, () => {}); }
    });
  });
}

// ── Creative cache (30-day TTL) ──────────────────────────────────────────────
const CACHE_FILE = path.join(__dirname, '.cache-creatives.json');
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

function slimCreative(ad) {
  const c = ad.creative;
  if (!c) return { id: ad.id, creative: null, _cachedAt: ad._cachedAt || Date.now() };
  return {
    id: ad.id,
    creative: {
      id:          c.id,
      name:        c.name || '',
      object_type: c.object_type || '',
      is_catalog:  !!c.object_story_spec?.template_data,
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
      for (const [id, entry] of Object.entries(raw)) {
        if (entry._cachedAt && (now - entry._cachedAt) > CACHE_TTL) continue;
        filtered[id] = entry;
      }
      return filtered;
    }
  } catch (e) { console.error('Cache read error:', e.message); }
  return {};
}

let creativeCache = loadCacheFromFile();

// ── Insights cache ───────────────────────────────────────────────────────────
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

// ── HD thumbnail cache (24h TTL) ─────────────────────────────────────────────
const HD_THUMB_CACHE_FILE = path.join(__dirname, '.cache-hd-thumbs.json');
const HD_THUMB_TTL = 24 * 60 * 60 * 1000;

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

const AD_METRICS = ['impressions', 'clicks', 'spend', 'actions', 'action_values'].join(',');

// ── Helpers ──────────────────────────────────────────────────────────────────

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function getCredentials(req) {
  const token = req.headers['x-meta-token'] || process.env.META_ACCESS_TOKEN || '';
  const accountId = (req.headers['x-meta-account-id'] || process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, '');
  return { token, accountId };
}

async function fetchInsightsAsync(base, token, fields, timeRange, onProgress) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const createRes = await axios.post(`${base}/insights`, null, {
      params: {
        access_token: token, level: 'ad', fields,
        time_range: JSON.stringify(timeRange),
      },
    });
    if (createRes.data.data) return createRes.data.data;

    const reportId = createRes.data.report_run_id;
    if (!reportId) throw new Error('No report_run_id returned from Meta');

    let jobFailed = false;
    for (let i = 0; i < 60; i++) {
      const poll = await axios.get(`${META_BASE_URL}/${reportId}`, { params: { access_token: token } });
      const status = poll.data.async_status;
      const pct = poll.data.async_percent_completion || 0;
      if (onProgress) onProgress(status, pct);
      if (status === 'Job Completed') break;
      if (status === 'Job Failed' || status === 'Job Skipped') {
        if (attempt < MAX_RETRIES) {
          if (onProgress) onProgress(`${status}, retrying (${attempt}/${MAX_RETRIES})...`, 0);
          jobFailed = true;
          break;
        }
        throw new Error(`Async report ${status} after ${MAX_RETRIES} attempts`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (jobFailed) { await new Promise(r => setTimeout(r, 3000 * attempt)); continue; }

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
}

function findPurchaseAction(arr = []) {
  return arr.find(x => x.action_type === 'purchase' || x.action_type === 'omni_purchase');
}

// Ad name format: [PrintID-TypeID_MockupID]
function extractPrintId(adName) {
  const m = (adName || '').match(/^\[([^-]+)/);
  return m ? m[1] : adName || 'unknown';
}

function extractMockupId(adName) {
  const m = (adName || '').match(/^\[[^-]+-[^_]+_(.+)\]/);
  return m ? m[1] : 'unknown';
}

function hasValidFormat(adName) {
  return /^\[[^-]+-[^_]+_.+\]/.test(adName || '');
}

async function fetchAdsByIds(token, adIds, fields) {
  if (!adIds.length) return [];
  const results = [];
  const BATCH = 50;
  for (let i = 0; i < adIds.length; i += BATCH) {
    const batch = adIds.slice(i, i + BATCH);
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

function computeMetrics(entry, rows) {
  const sum = fn => rows.reduce((s, r) => s + fn(r), 0);
  for (const f of ['impressions', 'clicks', 'spend']) {
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
}

function groupByMockup(rows) {
  const map = {};
  for (const row of rows) {
    const mockupId = extractMockupId(row.ad_name);
    if (mockupId === 'unknown') continue;
    const printId  = extractPrintId(row.ad_name);
    if (!map[mockupId]) map[mockupId] = { mockup_id: mockupId, _rows: [], _printIds: new Set() };
    map[mockupId]._rows.push(row);
    map[mockupId]._printIds.add(printId);
  }
  return Object.values(map).map(({ _rows, _printIds, ...entry }) => {
    entry.print_count = _printIds.size;
    const topAd = _rows.reduce((best, r) => parseFloat(r.spend || 0) > parseFloat(best.spend || 0) ? r : best, _rows[0]);
    entry.thumbnail_url = topAd?.thumbnail_url || _rows.find(r => r.thumbnail_url)?.thumbnail_url || null;
    entry.is_catalog = !!topAd?.is_catalog;
    computeMetrics(entry, _rows);
    return entry;
  });
}

function groupByCreative(rows) {
  const map = {};
  for (const row of rows) {
    const id = row.creative?.id || row.ad_id;
    if (!map[id]) {
      map[id] = {
        creative_id:   id,
        thumbnail_url: row.creative?.thumbnail_url || null,
        is_catalog:    !!row.creative?.is_catalog,
        ad_name:       row.ad_name || '',
        _rows:         [],
      };
    }
    map[id]._rows.push(row);
  }
  return Object.values(map).map(({ _rows, ...entry }) => {
    computeMetrics(entry, _rows);
    return entry;
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    hasMetaToken:   !!process.env.META_ACCESS_TOKEN,
    hasAdAccountId: !!process.env.META_AD_ACCOUNT_ID,
  });
});

app.get('/api/dashboard', async (req, res) => {
  const { token, accountId } = getCredentials(req);
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });

  const forceRefresh = req.query.refresh === '1';
  const current = { since: dateStr(DAYS), until: dateStr(0) };
  const fields  = `ad_id,ad_name,${AD_METRICS}`;
  const base    = `${META_BASE_URL}/act_${accountId}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const progress = msg => res.write(`data: ${JSON.stringify({ progress: msg })}\n\n`);
  const startTime = Date.now();
  const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  try {
    // 1. Fetch insights (current + previous 30 days)
    const cacheKey = String(DAYS);
    const ic = insightsCache[cacheKey];
    let currRows;
    if (!forceRefresh && ic) {
      currRows = ic.current;
      progress(`Using cached insights (${currRows.length} rows) [${elapsed()}]`);
    } else {
      progress(`Creating async report... [${elapsed()}]`);
      currRows = await fetchInsightsAsync(base, token, fields, current, (s, p) => {
        progress(`Polling report: ${p}% [${elapsed()}]`);
      });
      insightsCache[cacheKey] = { current: currRows };
      saveCacheAsync(INSIGHTS_CACHE_FILE, insightsCache);
      progress(`Insights loaded: ${currRows.length} rows [${elapsed()}]`);
    }

    // 2. Collect qualified ads: valid format OR spend > $100
    const adSpendMap = {};
    const adNameMap = {};
    for (const r of currRows) {
      if (!r.ad_id) continue;
      adSpendMap[r.ad_id] = parseFloat(r.spend) || 0;
      adNameMap[r.ad_id] = r.ad_name || '';
    }
    const isQualified = id => hasValidFormat(adNameMap[id]) || (adSpendMap[id] || 0) > 100;
    const allAdIds = [...new Set(currRows.map(r => r.ad_id).filter(id => id && isQualified(id)))];

    const missingIds = allAdIds.filter(id => !creativeCache[id]);
    if (missingIds.length > 0) {
      progress(`Fetching creative info for ${missingIds.length} new ads... [${elapsed()}]`);
      const fetched = await fetchAdsByIds(token, missingIds, 'id,creative{id,name,object_type,object_story_spec}');
      const now = Date.now();
      for (const ad of fetched) {
        creativeCache[ad.id] = slimCreative({ ...ad, _cachedAt: now });
      }
      for (const id of missingIds) {
        if (!creativeCache[id]) creativeCache[id] = { id, creative: null, _cachedAt: now };
      }
      saveCacheAsync(CACHE_FILE, creativeCache);
      progress(`Creative info cached (${fetched.length} ads) [${elapsed()}]`);
    } else {
      progress(`All ${allAdIds.length} ads already cached [${elapsed()}]`);
    }
    const allAds = allAdIds.map(id => creativeCache[id]).filter(Boolean);

    // 3. Fetch HD thumbnails for non-catalog creatives
    const creativeInfoMap = {};
    for (const ad of allAds) {
      if (ad.creative?.id) creativeInfoMap[ad.creative.id] = {
        type: ad.creative.object_type,
        isCatalog: !!ad.creative.is_catalog,
      };
    }
    const nonCatalogCreativeIds = Object.keys(creativeInfoMap).filter(cid => {
      const info = creativeInfoMap[cid];
      return info.type && ['SHARE', 'VIDEO'].includes(info.type) && !info.isCatalog;
    });
    const missingHdIds = nonCatalogCreativeIds.filter(cid => !hdThumbCache[cid]);
    if (missingHdIds.length > 0) {
      progress(`Fetching HD thumbnails for ${missingHdIds.length} creatives... [${elapsed()}]`);
      const BATCH = 50;
      for (let i = 0; i < missingHdIds.length; i += BATCH) {
        const batch = missingHdIds.slice(i, i + BATCH);
        try {
          const thumbRes = await axios.get(`${META_BASE_URL}/`, {
            params: { ids: batch.join(','), fields: 'thumbnail_url', thumbnail_width: 480, thumbnail_height: 480, access_token: token }
          });
          for (const [id, data] of Object.entries(thumbRes.data)) {
            if (data?.thumbnail_url) hdThumbCache[id] = { url: data.thumbnail_url, _cachedAt: Date.now() };
          }
        } catch (err) {
          console.error('HD thumb fetch error:', err.response?.data?.error?.message || err.message);
        }
      }
      saveCacheAsync(HD_THUMB_CACHE_FILE, hdThumbCache);
      progress(`Fetched HD thumbnails [${elapsed()}]`);
    } else if (nonCatalogCreativeIds.length > 0) {
      progress(`All ${nonCatalogCreativeIds.length} HD thumbnails cached [${elapsed()}]`);
    }

    const hdThumbMap = {};
    for (const [id, entry] of Object.entries(hdThumbCache)) hdThumbMap[id] = entry.url;

    // 4. Build creative map
    const creativeMap = {};
    for (const ad of allAds) {
      const c = ad.creative;
      if (!c) continue;
      creativeMap[ad.id] = {
        id:            c.id,
        name:          c.name || '',
        object_type:   c.object_type || '',
        is_catalog:    !!c.is_catalog,
        thumbnail_url: hdThumbMap[c.id] || null,
      };
    }

    const attachThumb = rows => rows.map(r => {
      const cm = creativeMap[r.ad_id];
      return { ...r, thumbnail_url: cm?.thumbnail_url || null, is_catalog: !!cm?.is_catalog };
    });
    const attachCreative = rows => rows.map(r => ({ ...r, creative: creativeMap[r.ad_id] || null }));

    // 5. Group and build response
    progress(`Processing data... [${elapsed()}]`);
    const hasSpend = rows => rows.filter(r => parseFloat(r.spend || 0) > 0);
    const result = {
      mockups: {
        current:  groupByMockup(attachThumb(hasSpend(currRows))),
      },
      creatives: {
        current:  groupByCreative(attachCreative(hasSpend(currRows))),
      },
      period:    { current },
      cached_at: new Date().toISOString(),
      stats: {
        insights:   { rows: currRows.length, qualified: allAdIds.length, cached: !forceRefresh && !!ic },
        creatives:  { total: allAdIds.length, cached: allAdIds.length - missingIds.length, fetched: missingIds.length },
        thumbnails: { total: nonCatalogCreativeIds.length, cached: nonCatalogCreativeIds.length - missingHdIds.length, fetched: missingHdIds.length },
      },
    };
    progress(`Done [${elapsed()}]`);
    res.write(`data: ${JSON.stringify({ result })}\n\n`);
    res.end();
  } catch (err) {
    const respData = err.response?.data;
    const metaError = respData?.error;
    let error = 'Meta API error';
    let detail = err.message;

    if (typeof respData === 'string' && respData.includes('<!DOCTYPE html')) {
      error = 'Meta API temporarily unavailable';
      detail = 'Meta returned an error page. Please try again shortly.';
    } else if (metaError) {
      const code = metaError.code;
      const subcode = metaError.error_subcode;
      if (code === 190) {
        error = 'Meta API token expired or invalid';
        detail = subcode === 463
          ? 'Token has expired. Generate a new token and update META_ACCESS_TOKEN in .env.'
          : subcode === 467
            ? 'Token revoked. The user may have changed their password.'
            : `Token error (subcode ${subcode}): ${metaError.message}`;
      } else if (code === 4 || code === 17) {
        error = 'Meta API rate limit reached';
        detail = 'Too many requests. Please wait a few minutes.';
      } else {
        detail = metaError.message || JSON.stringify(respData);
      }
    }

    res.write(`data: ${JSON.stringify({ error, detail })}\n\n`);
    res.end();
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Mockup Dashboard running on http://localhost:${PORT}`));
}

module.exports = { dateStr, findPurchaseAction, extractPrintId, extractMockupId, hasValidFormat, groupByMockup };
