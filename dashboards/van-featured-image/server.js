// Local runs read keys from D:\keys (one file per key); on Render they are env vars and these files do not exist.
require('dotenv').config({ path: ['meta-token', 'meta-ad-account', 'port', 'triplewhale'].map(k => 'D:/keys/.env.' + k) });
const express   = require('express');
const path      = require('path');
const { findPurchaseAction, twSql, fetchAdMedia, sseLoad } = require('./meta');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory caches ─────────────────────────────────────────────────────────
// Render free has no persistent disk (restart/spin-down wipes files), so caches
// live in memory only and last as long as the process.
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
    hasTripleWhaleKey: !!process.env.TRIPLE_WHALE_API_KEY, // a load reads only Triple Whale
  });
});

// GET /api/dashboard?mode=active|all — SSE with progress updates; a second request with the same
// mode joins the running load (see sseLoad in meta.js)
app.get('/api/dashboard', (req, res) => {
  if (!process.env.TRIPLE_WHALE_API_KEY) return res.status(400).json({ error: 'Missing TRIPLE_WHALE_API_KEY' });
  const mode = req.query.mode || 'all';
  sseLoad(res, `mode=${mode}`, ctx => loadDashboard({ mode, ...ctx }));
});

// Image ads with more than $100 spend in [since, until] whose current status is in `statuses`,
// filtered inside Triple Whale (2 queries in parallel, about 4s for 12 months; measured 2026-11-03).
// Reading every ad and checking the type afterwards took 10s and dropped designs whose top-spend ad
// was a video or catalog ad even when they had an image ad over $100 (30 of 367 designs).
// Status is its own query: with ad_effective_status in the metrics SELECT, Triple Whale's sums differ.
async function fetchImageAdsOver100({ since, until, statuses }) {
  const where = `FROM ads_table
WHERE channel = 'facebook-ads' AND event_date BETWEEN '${since}' AND '${until}' AND ad_type = 'image'
  AND (spend > 0 OR conversion_value > 0)
GROUP BY ad_id`;
  const st = statuses.filter(x => /^[A-Z_]+$/.test(x)).map(x => `'${x}'`).join(',');
  const [rows, statusRows] = await Promise.all([
    twSql(`SELECT toString(ad_id) AS ad_id, any(nullIf(ad_name, '')) AS ad_name, sum(spend) AS sp, sum(conversion_value) AS rev
${where}
HAVING sp > 100`, since, until),
    twSql(`SELECT toString(ad_id) AS ad_id, argMax(ad_effective_status, (event_date, event_hour)) AS status
${where}
HAVING sum(spend) > 100 AND status IN (${st})`, since, until),
  ]);
  const keep = new Set(statusRows.map(r => String(r.ad_id)));
  return rows.filter(r => keep.has(String(r.ad_id))).map(r => ({
    ad_id: String(r.ad_id),
    ad_name: r.ad_name || '',
    spend: String(Number(r.sp) || 0),
    action_values: [{ action_type: 'omni_purchase', value: String(Number(r.rev) || 0) }],
  }));
}

async function loadDashboard({ mode, progress, send, elapsed }) {
  const today = todayStr();
  const since = allTimeStart();
  const statuses = mode === 'active' ? ['ACTIVE'] : ['ACTIVE', 'PAUSED'];

  // ── Step 1: image ads over $100 in 12 months, filtered in Triple Whale ──
  progress(`Step 1: Reading ${mode === 'active' ? 'active ' : ''}image ads over $100 from Triple Whale (${since} → ${today})... [${elapsed()}]`);
  const allRows = await fetchImageAdsOver100({ since, until: today, statuses });
  progress(`Step 1: ${allRows.length} image ads loaded [${elapsed()}]`);

  // ── Step 2: top-spend ad per design (print-type) ──
  const topAds = pickTopSpendAds(allRows);
  progress(`Step 2: ${topAds.length} top ads per design [${elapsed()}]`);

  // ── Step 3: image and link of the top ads from Triple Whale (only missing) ──
  const missingIds = topAds.map(a => a.ad_id).filter(id => !mediaCache.has(id));
  if (missingIds.length > 0) {
    progress(`Step 3: Reading images of ${missingIds.length} ads from Triple Whale... [${elapsed()}]`);
    const media = await fetchAdMedia(missingIds, since, today);
    for (const [id, m] of media) mediaCache.set(id, m);
    progress(`Step 3: Images read (${media.size} ads) [${elapsed()}]`);
  } else {
    progress(`Step 3: All images cached [${elapsed()}]`);
  }
  const imageAds = topAds.map(ad => ({
    ...ad,
    image_url: mediaCache.get(ad.ad_id)?.image_url || null,
    link: mediaCache.get(ad.ad_id)?.link || '',
  }));

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
    cached_at: new Date().toISOString(),
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

module.exports = { todayStr, findPurchaseAction, pickTopSpendAds, extractGroupKey };
