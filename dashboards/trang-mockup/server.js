// Local runs read keys from D:\keys (one file per key); on Render they are env vars and these files do not exist.
require('dotenv').config({ path: ['meta-token', 'meta-ad-account', 'port'].map(k => 'D:/keys/.env.' + k) });
const express   = require('express');
const path      = require('path');
const { META_BASE_URL, getCredentials, findPurchaseAction, fetchByIds, fetchInsights, sseLoad } = require('./meta');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const DAYS = 30;
const MIN_SPEND_VALID_FORMAT = 1;   // ads with [Print-Type_Mockup] name need more than this spend
const MIN_SPEND_ANY_NAME     = 100; // other ads qualify only above this spend

// ── In-memory caches ─────────────────────────────────────────────────────────
// Render free has no persistent disk (restart/spin-down wipes files), so caches
// live in memory only and last as long as the process.
const HD_THUMB_TTL = 24 * 60 * 60 * 1000; // Meta CDN URLs expire

const creativeCache = {}; // ad_id → { id, creative: {id, object_type, is_catalog} | null, _cachedAt }
const insightsCache = {}; // days → { current: rows }
const hdThumbCache  = {}; // creative_id → { url, _cachedAt }

function slimCreative(ad) {
  const c = ad.creative;
  if (!c) return { id: ad.id, creative: null, _cachedAt: ad._cachedAt || Date.now() };
  return {
    id: ad.id,
    creative: {
      id:          c.id,
      object_type: c.object_type || '',
      is_catalog:  !!c.object_story_spec?.template_data,
      image_hash:  c.object_story_spec?.link_data?.image_hash || null,
    },
    _cachedAt: ad._cachedAt || Date.now(),
  };
}

const AD_METRICS = ['impressions', 'clicks', 'spend', 'actions', 'action_values'].join(',');

// ── Helpers ──────────────────────────────────────────────────────────────────

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
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
    // Pick the thumbnail from the highest-spend ad that actually has an image
    // (always within this mockup group, so the mockup is always correct; the print may differ).
    // Falls back to the overall top-spend ad only when no ad in the group has an image.
    const withThumb = _rows.filter(r => r.thumbnail_url || r.thumb_cid);
    const pickFrom = withThumb.length ? withThumb : _rows;
    const topAd = pickFrom.reduce((best, r) => parseFloat(r.spend || 0) > parseFloat(best.spend || 0) ? r : best, pickFrom[0]);
    entry.thumbnail_url = topAd?.thumbnail_url || null;
    entry.thumb_cid = topAd?.thumb_cid || null;
    entry.is_catalog = !!topAd?.is_catalog;
    computeMetrics(entry, _rows);
    return entry;
  });
}

// "By Image" tab: one row per image (link_data.image_hash), summing every ad/creative that
// uses the same image. Creatives without a hash (video, catalog) fall back to creative id.
function groupByImage(rows) {
  const map = {};
  for (const row of rows) {
    const c = row.creative;
    const id = c?.image_hash || c?.id || row.ad_id;
    if (!map[id]) {
      map[id] = {
        image_hash:    c?.image_hash || null,
        creative_id:   c?.id || null,
        thumbnail_url: c?.thumbnail_url || null,
        thumb_cid:     c?.thumb_cid || null,
        is_catalog:    !!c?.is_catalog,
        ad_name:       row.ad_name || '',
        _creatives:    new Set(),
        _rows:         [],
      };
    }
    const g = map[id];
    if (c?.id) g._creatives.add(c.id);
    if (!g.thumbnail_url && c?.thumbnail_url) g.thumbnail_url = c.thumbnail_url;
    g._rows.push(row);
  }
  return Object.values(map).map(({ _rows, _creatives, ...entry }) => {
    entry.creative_count = _creatives.size;
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

// GET /api/thumbs?ids=cid1,cid2 — HD thumbnails (480px) for creatives, max 50 per call.
// Called by the frontend for rows scrolled into view; served from memory when cached.
app.get('/api/thumbs', async (req, res) => {
  const { token } = getCredentials();
  if (!token) return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN' });
  const ids = [...new Set(String(req.query.ids || '').split(',').map(s => s.trim()).filter(id => /^\d+$/.test(id)))].slice(0, 50);
  const now = Date.now();
  const missing = ids.filter(id => !hdThumbCache[id] || (now - hdThumbCache[id]._cachedAt) > HD_THUMB_TTL);
  const thumbs = await fetchByIds(token, missing, 'thumbnail_url', { thumbnail_width: 480, thumbnail_height: 480 });
  for (const t of thumbs) if (t.thumbnail_url) hdThumbCache[t.id] = { url: t.thumbnail_url, _cachedAt: Date.now() };
  const out = {};
  for (const id of ids) out[id] = hdThumbCache[id]?.url || null;
  res.json(out);
});

// GET /api/dashboard — SSE with progress updates; a second request joins the running load
// (see sseLoad in meta.js)
app.get('/api/dashboard', (req, res) => {
  const { token, accountId } = getCredentials();
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });
  const forceRefresh = req.query.refresh === '1';
  sseLoad(res, `refresh=${forceRefresh}`, ctx => loadDashboard({ token, accountId, forceRefresh, ...ctx }));
});

async function loadDashboard({ token, accountId, forceRefresh, progress, send, elapsed, stopped }) {
  const current = { since: dateStr(DAYS), until: dateStr(0) };
  const fields  = `ad_id,ad_name,${AD_METRICS}`;
  const base    = `${META_BASE_URL}/act_${accountId}`;
  // 1. Fetch insights (last 30 days)
  const cacheKey = String(DAYS);
  const ic = insightsCache[cacheKey];
  let currRows;
  if (!forceRefresh && ic) {
    currRows = ic.current;
    progress(`Using cached insights (${currRows.length} rows) [${elapsed()}]`);
  } else {
    progress(`Creating async report... [${elapsed()}]`);
    currRows = await fetchInsights({
      base, token, fields, timeRange: current, stopped,
      onProgress: p => progress(`Polling report: ${p}% [${elapsed()}]`),
      onRetry: msg => progress(`${msg} [${elapsed()}]`),
    });
    insightsCache[cacheKey] = { current: currRows };
    progress(`Insights loaded: ${currRows.length} rows [${elapsed()}]`);
  }

  // 2. Collect qualified ads: valid format with spend > $1 OR spend > $100.
  // (Filtering spend at the insights API was tried 2026-10-14: no faster, Meta still computes every ad.)
  const adSpendMap = {};
  const adNameMap = {};
  for (const r of currRows) {
    if (!r.ad_id) continue;
    adSpendMap[r.ad_id] = parseFloat(r.spend) || 0;
    adNameMap[r.ad_id] = r.ad_name || '';
  }
  const uniqueAdIds = Object.keys(adSpendMap);
  const isQualified = id => {
    const spend = adSpendMap[id] || 0;
    return (hasValidFormat(adNameMap[id]) && spend > MIN_SPEND_VALID_FORMAT) || spend > MIN_SPEND_ANY_NAME;
  };
  const allAdIds = uniqueAdIds.filter(isQualified);
  const validFmtCount = allAdIds.filter(id => hasValidFormat(adNameMap[id])).length;
  const highSpendCount = allAdIds.length - validFmtCount;
  progress(`${uniqueAdIds.length} unique ads → ${allAdIds.length} qualified (${validFmtCount} valid format spend>$${MIN_SPEND_VALID_FORMAT} + ${highSpendCount} spend>$${MIN_SPEND_ANY_NAME}) [${elapsed()}]`);

  const missingIds = allAdIds.filter(id => !creativeCache[id]);
  if (missingIds.length > 0) {
    progress(`Fetching creative info for ${missingIds.length}/${allAdIds.length} ads... [${elapsed()}]`);
    const fetched = await fetchByIds(token, missingIds, 'id,creative{id,object_type,object_story_spec{template_data,link_data{image_hash}}}', {}, stopped);
    const now = Date.now();
    for (const ad of fetched) {
      creativeCache[ad.id] = slimCreative({ ...ad, _cachedAt: now });
    }
    for (const id of missingIds) {
      if (!creativeCache[id]) creativeCache[id] = { id, creative: null, _cachedAt: now };
    }
    progress(`Creative info cached (${fetched.length} ads) [${elapsed()}]`);
  } else {
    progress(`All ${allAdIds.length} ads already cached [${elapsed()}]`);
  }
  const allAds = allAdIds.map(id => creativeCache[id]).filter(Boolean);

  // 3. HD thumbnails are loaded lazily by the frontend (/api/thumbs) for rows
  // scrolled into view; here we only mark which creatives can have one and
  // attach URLs already in the in-memory cache.
  const thumbable = c => c?.id && ['SHARE', 'VIDEO'].includes(c.object_type) && !c.is_catalog;
  const cachedThumb = cid => {
    const e = hdThumbCache[cid];
    return e && (Date.now() - e._cachedAt) <= HD_THUMB_TTL ? e.url : null;
  };

  // 4. Build creative map
  const creativeMap = {};
  for (const ad of allAds) {
    const c = ad.creative;
    if (!c) continue;
    creativeMap[ad.id] = {
      id:            c.id,
      object_type:   c.object_type || '',
      is_catalog:    !!c.is_catalog,
      image_hash:    c.image_hash || null,
      thumbnail_url: thumbable(c) ? cachedThumb(c.id) : null,
      thumb_cid:     thumbable(c) ? c.id : null,
    };
  }

  const attachThumb = rows => rows.map(r => {
    const cm = creativeMap[r.ad_id];
    return { ...r, thumbnail_url: cm?.thumbnail_url || null, thumb_cid: cm?.thumb_cid || null, is_catalog: !!cm?.is_catalog };
  });
  const attachCreative = rows => rows.map(r => ({ ...r, creative: creativeMap[r.ad_id] || null }));

  // 5. Group and build response
  progress(`Processing data... [${elapsed()}]`);
  const spendRows = currRows.filter(r => parseFloat(r.spend || 0) > 0);
  const qualifiedRows = spendRows.filter(r => r.ad_id && isQualified(r.ad_id));
  const creativesGrouped = groupByImage(attachCreative(qualifiedRows));
  const result = {
    mockups: {
      current:  groupByMockup(attachThumb(spendRows)),
    },
    creatives: {
      current:  creativesGrouped,
    },
    period:    { current },
    cached_at: new Date().toISOString(),
    stats: { // read by the load log in public/app.js
      insights: { rows: currRows.length },
      qualifiedRows: qualifiedRows.length, creativesOut: creativesGrouped.length,
    },
  };
  progress(`Done [${elapsed()}]`);
  send({ result });
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Mockup Dashboard running on http://localhost:${PORT}`));
}

module.exports = { dateStr, findPurchaseAction, extractPrintId, extractMockupId, hasValidFormat, groupByMockup, groupByImage };
