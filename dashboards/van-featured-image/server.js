// Local runs read keys from D:\keys (one file per key); on Render they are env vars and these files do not exist.
require('dotenv').config({ path: ['meta-token', 'meta-ad-account', 'port', 'triplewhale'].map(k => 'D:/keys/.env.' + k) });
const express   = require('express');
const path      = require('path');
const { getCredentials, findPurchaseAction, fetchAdRows, fetchAdMedia, sseLoad } = require('./meta');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory caches ─────────────────────────────────────────────────────────
// Render free has no persistent disk (restart/spin-down wipes files), so caches
// live in memory only and last as long as the process.
let insightsCache = null; // { rows, lastUntil, cached_at } — incremental "all" mode
const mediaCache = new Map(); // ad_id → fetchAdMedia entry (Triple Whale files do not expire)

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
  sseLoad(res, `mode=${mode}`, ctx => loadDashboard({ mode, ...ctx }));
});

async function loadDashboard({ mode, progress, send, elapsed }) {
  const today = todayStr();
  const defaultFilter = ['ACTIVE', 'PAUSED'];
  const activeFilter = ['ACTIVE'];

  // ── Step 1: Ad spend + purchase value from Triple Whale ──
  const insights = (since, statuses) => fetchAdRows({ since, until: today, statuses });
  let allRows;
  let isIncremental = false;

  if (mode === 'active') {
    const since = allTimeStart();
    progress(`Step 1: Reading active ads from Triple Whale (${since} → ${today})... [${elapsed()}]`);
    allRows = await insights(since, activeFilter);
    progress(`Step 1: ${allRows.length} rows loaded [${elapsed()}]`);
  } else {
    // All mode: incremental cache
    const cache = insightsCache;
    if (cache) {
      if (cache.lastUntil >= today) {
        allRows = cache.rows;
        progress(`Step 1: Using cached ad data (${allRows.length} rows) [${elapsed()}]`);
      } else {
        isIncremental = true;
        const since = addDays(cache.lastUntil, 1);
        progress(`Step 1: Reading new days from Triple Whale (${since} → ${today})... [${elapsed()}]`);
        const newRows = await insights(since, defaultFilter);
        allRows = [...cache.rows, ...newRows];
        progress(`Step 1: +${newRows.length} rows, total ${allRows.length} [${elapsed()}]`);
      }
    } else {
      const since = allTimeStart();
      progress(`Step 1: Reading 12 months from Triple Whale (${since} → ${today})... [${elapsed()}]`);
      allRows = await insights(since, defaultFilter);
      progress(`Step 1: ${allRows.length} rows loaded [${elapsed()}]`);
    }

    insightsCache = { rows: allRows, lastUntil: today, cached_at: new Date().toISOString() };
  }

  // Pick top-spend ad per ad_name
  const topAds = pickTopSpendAds(allRows);
  progress(`${topAds.length} unique designs (top spend per print-type) [${elapsed()}]`);

  // ── Step 2: Creative, image and link of the top ads from Triple Whale (only missing) ──
  const topAdIds = topAds.map(a => a.ad_id);
  const missingIds = topAdIds.filter(id => !mediaCache.has(id));
  if (missingIds.length > 0) {
    progress(`Step 2: Reading creatives of ${missingIds.length} ads from Triple Whale... [${elapsed()}]`);
    const media = await fetchAdMedia(missingIds, allTimeStart(), today);
    for (const [id, m] of media) mediaCache.set(id, m);
    progress(`Step 2: Creatives read (${media.size} ads) [${elapsed()}]`);
  } else {
    progress(`Step 2: All creatives cached [${elapsed()}]`);
  }

  // Image ads only: Triple Whale type 'image' carries the original image. Catalog ads and
  // multi-asset (asset_feed_spec) ads are both 'dynamic' with only a 500px thumbnail, so both are left out.
  const imageAds = topAds.filter(ad => mediaCache.get(ad.ad_id)?.type === 'image').map(ad => ({
    ...ad,
    image_url: mediaCache.get(ad.ad_id).image_url,
    link: mediaCache.get(ad.ad_id).link,
  }));
  progress(`${imageAds.length} image ads after filter [${elapsed()}]`);

  // Build final ads
  const ads = imageAds.map(ad => {
    const m = ad.ad_name.match(/\[[A-Za-z]+(\d+)/);
    return {
      ad_name: ad.ad_name,
      print_id: m ? m[1] : '',
      spend: ad.spend,
      purchase_value: ad.purchase_value,
      roas: ad.roas,
      image_url: ad.image_url || null,
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
