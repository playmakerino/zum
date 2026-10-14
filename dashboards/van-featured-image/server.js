require('dotenv').config({ path: ['meta-ad-account', 'port'].map(k => require('path').resolve(__dirname, '../../.env.' + k)) });
const express   = require('express');
const axios     = require('axios');
const path      = require('path');
const { META_BASE_URL, BATCH_SIZE, getCredentials, findPurchaseAction, fetchByIds, fetchInsights, sseLoad } = require('./meta');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory caches ─────────────────────────────────────────────────────────
// Render free has no persistent disk (restart/spin-down wipes files), so caches
// live in memory only and last as long as the process.
const IMAGE_TTL = 24 * 60 * 60 * 1000; // Meta CDN URLs expire

let insightsCache = null; // { rows, lastUntil, cached_at } — incremental "all" mode
const creativeCache = {}; // ad_id → { creative_id, object_type, is_catalog, link, image_hash, _cachedAt }
const imageCache    = {}; // creative_id → { url, _cachedAt }
const hasImage = cid => imageCache[cid] && (Date.now() - imageCache[cid]._cachedAt) <= IMAGE_TTL;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

const LOOKBACK_MONTHS = 12;

function allTimeStart() {
  const d = new Date();
  d.setMonth(d.getMonth() - LOOKBACK_MONTHS);
  return d.toISOString().split('T')[0];
}

function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().split('T')[0];
}

// Extract print_id-type_id from ad name, ignoring mockup_id
// e.g. [Dub4936-CZR] → "Dub4936-CZR", [Dub4936-TPJ_PM-MWA-07] → "Dub4936-TPJ"
function extractGroupKey(adName) {
  const m = adName.match(/\[([A-Za-z]+\d+)-([A-Za-z]+)/);
  return m ? `${m[1]}-${m[2]}` : adName;
}

// Aggregate by ad_id, then pick top-spend ad per print_id-type_id
function pickTopSpendAds(rows) {
  const byAdId = {};
  for (const row of rows) {
    if (!row.ad_id) continue;
    if (!byAdId[row.ad_id]) {
      byAdId[row.ad_id] = { ad_id: row.ad_id, ad_name: row.ad_name || 'unknown', spend: 0, purchase_value: 0 };
    }
    byAdId[row.ad_id].spend += parseFloat(row.spend || 0);
    byAdId[row.ad_id].purchase_value += parseFloat(findPurchaseAction(row.action_values)?.value || 0);
  }
  const byGroup = {};
  for (const ad of Object.values(byAdId)) {
    if (ad.spend <= 100) continue;
    const key = extractGroupKey(ad.ad_name);
    if (!byGroup[key] || ad.spend > byGroup[key].spend) {
      byGroup[key] = ad;
    }
  }
  return Object.values(byGroup).map(ad => ({
    ...ad,
    roas: ad.spend > 0 && ad.purchase_value > 0 ? ad.purchase_value / ad.spend : 0,
  }));
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    hasMetaToken:   !!process.env.META_ACCESS_TOKEN,
    hasAdAccountId: !!process.env.META_AD_ACCOUNT_ID,
  });
});

// GET /api/dashboard?mode=active|all — SSE with progress updates; a second request with the same
// mode joins the running load (see sseLoad in meta.js)
app.get('/api/dashboard', (req, res) => {
  const { token, accountId } = getCredentials();
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });
  const mode = req.query.mode || 'all';
  sseLoad(res, `mode=${mode}`, ctx => loadDashboard({ token, accountId, mode, ...ctx }));
});

async function loadDashboard({ token, accountId, mode, progress, send, elapsed, stopped }) {
  const today = todayStr();
  const base = `${META_BASE_URL}/act_${accountId}`;
  const statusFilter = statuses => [
    { field: 'ad.effective_status', operator: 'IN', value: statuses },
    { field: 'spend', operator: 'GREATER_THAN', value: 0 },
  ];
  const defaultFilter = statusFilter(['ACTIVE', 'PAUSED']);
  const activeFilter = statusFilter(['ACTIVE']);

  // ── Step 1: Fetch insights (spend + action_values) ──────────────────────
  const fields = 'ad_id,ad_name,spend,action_values';
  const insights = (since, filtering) => fetchInsights({
    base, token, fields, timeRange: { since, until: today }, filtering, stopped,
    onProgress: p => progress(`Step 1: Polling report ${p}% [${elapsed()}]`),
    onRetry: msg => progress(`Step 1: ${msg} [${elapsed()}]`),
  });
  let allRows;
  let isIncremental = false;

  if (mode === 'active') {
    const since = allTimeStart();
    progress(`Step 1: Fetching active ads (${since} → ${today})... [${elapsed()}]`);
    allRows = await insights(since, activeFilter);
    progress(`Step 1: ${allRows.length} rows loaded [${elapsed()}]`);
  } else {
    // All mode: incremental cache
    const cache = insightsCache;
    if (cache) {
      if (cache.lastUntil >= today) {
        allRows = cache.rows;
        progress(`Step 1: Using cached insights (${allRows.length} rows) [${elapsed()}]`);
      } else {
        isIncremental = true;
        const since = addDays(cache.lastUntil, 1);
        progress(`Step 1: Incremental fetch (${since} → ${today})... [${elapsed()}]`);
        const newRows = await insights(since, defaultFilter);
        allRows = [...cache.rows, ...newRows];
        progress(`Step 1: +${newRows.length} rows, total ${allRows.length} [${elapsed()}]`);
      }
    } else {
      const since = allTimeStart();
      progress(`Step 1: Fetching all-time data (${since} → ${today})... [${elapsed()}]`);
      allRows = await insights(since, defaultFilter);
      progress(`Step 1: ${allRows.length} rows loaded [${elapsed()}]`);
    }

    insightsCache = { rows: allRows, lastUntil: today, cached_at: new Date().toISOString() };
  }

  // Pick top-spend ad per ad_name
  const topAds = pickTopSpendAds(allRows);
  progress(`${topAds.length} unique designs (top spend per print-type) [${elapsed()}]`);

  // ── Step 2: Fetch creative info for top ads (only missing) ───────────────
  const topAdIds = topAds.map(a => a.ad_id);
  // Re-fetch only image ads still missing a hash; video/catalog entries never get one.
  const missingCreativeIds = topAdIds.filter(id => {
    const cc = creativeCache[id];
    return !cc || (cc.object_type === 'SHARE' && !cc.is_catalog && !cc.image_hash);
  });
  if (missingCreativeIds.length > 0) {
    progress(`Step 2: Fetching creative info for ${missingCreativeIds.length} ads... [${elapsed()}]`);
    const fetched = await fetchByIds(token, missingCreativeIds, 'id,creative{id,object_type,object_story_spec{link_data{link,image_hash},template_data},asset_feed_spec{images,link_urls}}', {}, stopped);
    const now = Date.now();
    for (const ad of fetched) {
      const oss = ad.creative?.object_story_spec;
      const afs = ad.creative?.asset_feed_spec;
      creativeCache[ad.id] = {
        creative_id: ad.creative?.id || null,
        object_type: ad.creative?.object_type || '',
        is_catalog: !!oss?.template_data,
        link: oss?.link_data?.link || afs?.link_urls?.[0]?.website_url || '',
        image_hash: oss?.link_data?.image_hash || afs?.images?.[0]?.hash || '',
        _cachedAt: now,
      };
    }
    for (const id of missingCreativeIds) {
      if (!creativeCache[id]) creativeCache[id] = { creative_id: null, object_type: '', link: '', _cachedAt: now };
    }
    progress(`Step 2: Creative info cached (${fetched.length} ads) [${elapsed()}]`);
  } else {
    progress(`Step 2: All creative info cached [${elapsed()}]`);
  }

  // Filter to image ads only (SHARE = Image), exclude catalog/DPA
  const imageAds = topAds.filter(ad => {
    const cc = creativeCache[ad.ad_id];
    return cc && cc.object_type === 'SHARE' && !cc.is_catalog;
  }).map(ad => ({
    ...ad,
    creative_id: creativeCache[ad.ad_id]?.creative_id,
    link: creativeCache[ad.ad_id]?.link || '',
  }));
  progress(`${imageAds.length} image ads after filter [${elapsed()}]`);

  // ── Step 3: Fetch full-res images via adimages (only missing) ─────────────
  // hash → [creative_id, ...] to handle multiple ads sharing the same image
  const hashToCreativeIds = {};
  for (const ad of imageAds) {
    const cc = creativeCache[ad.ad_id];
    if (cc?.image_hash && ad.creative_id && !hasImage(ad.creative_id)) {
      if (!hashToCreativeIds[cc.image_hash]) hashToCreativeIds[cc.image_hash] = [];
      hashToCreativeIds[cc.image_hash].push(ad.creative_id);
    }
  }
  const missingHashes = Object.keys(hashToCreativeIds);
  if (missingHashes.length > 0) {
    progress(`Step 3: Fetching ${missingHashes.length} unique hashes for images... [${elapsed()}]`);
    for (let i = 0; i < missingHashes.length; i += BATCH_SIZE) {
      stopped();
      const batch = missingHashes.slice(i, i + BATCH_SIZE);
      try {
        const res = await axios.get(`${META_BASE_URL}/act_${accountId}/adimages`, {
          params: { hashes: JSON.stringify(batch), fields: 'hash,url', access_token: token }
        });
        for (const img of (res.data.data || [])) {
          const cids = hashToCreativeIds[img.hash];
          if (cids && img.url) {
            const now = Date.now();
            for (const cid of cids) {
              imageCache[cid] = { url: img.url, _cachedAt: now };
            }
          }
        }
      } catch (err) {
        console.error('Adimages fetch error:', err.response?.data?.error?.message || err.message);
      }
    }

    // Fallback: fetch thumbnail_url for creatives still missing after adimages
    const stillMissing = imageAds
      .filter(ad => ad.creative_id && !hasImage(ad.creative_id))
      .map(ad => ad.creative_id);
    if (stillMissing.length > 0) {
      progress(`Step 3: ${stillMissing.length} images not in adimages, fetching thumbnails... [${elapsed()}]`);
      const thumbs = await fetchByIds(token, stillMissing, 'id,thumbnail_url', { thumbnail_width: 1080, thumbnail_height: 1080 }, stopped);
      const now = Date.now();
      for (const t of thumbs) if (t.thumbnail_url) imageCache[t.id] = { url: t.thumbnail_url, _cachedAt: now };
    } else {
      progress(`Step 3: 0 need thumbnail fallback [${elapsed()}]`);
    }

    progress(`Step 3: Images done [${elapsed()}]`);
  } else if (imageAds.length > 0) {
    progress(`Step 3: All images cached [${elapsed()}]`);
  }

  // Build final ads
  const ads = imageAds.map(ad => {
    const m = ad.ad_name.match(/\[[A-Za-z]+(\d+)/);
    return {
      ad_name: ad.ad_name,
      print_id: m ? m[1] : '',
      spend: ad.spend,
      purchase_value: ad.purchase_value,
      roas: ad.roas,
      image_url: ad.creative_id ? (imageCache[ad.creative_id]?.url || null) : null,
      link: ad.link || '',
    };
  });

  const adsWithImage = ads.filter(a => a.image_url).length;
  const adsWithLink = ads.filter(a => a.link).length;

  const result = {
    ads,
    period: { since: allTimeStart(), until: today },
    lookback_months: LOOKBACK_MONTHS,
    cached_at: insightsCache?.cached_at || new Date().toISOString(),
    incremental: isIncremental,
    totalRows: allRows.length,
    topAdsCount: topAds.length,
    imageAdsCount: imageAds.length,
    adsWithImage,
    adsWithLink,
  };
  progress(`Done [${elapsed()}]`);
  send({ result });
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Meta Ads Dashboard running on http://localhost:${PORT}`));
}

module.exports = { todayStr, addDays, findPurchaseAction, pickTopSpendAds, extractGroupKey };
