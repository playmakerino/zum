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

// ── Insights Cache (incremental, rows + lastUntil) ───────────────────────────
const INSIGHTS_CACHE_FILE = path.join(__dirname, '.cache-insights.json');

function loadInsightsCacheFromFile() {
  try {
    if (fs.existsSync(INSIGHTS_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(INSIGHTS_CACHE_FILE, 'utf8'));
      if (data && Array.isArray(data.rows) && data.lastUntil) return data;
    }
  } catch (e) { console.error('Insights cache read error:', e.message); }
  return null;
}

let insightsCache = loadInsightsCacheFromFile();

// ── Creative Cache (ad_id → { creative_id, object_type, link, image_hash }, 30-day TTL)
const CREATIVE_CACHE_FILE = path.join(__dirname, '.cache-creatives.json');
const CREATIVE_TTL = 30 * 24 * 60 * 60 * 1000;

function loadCreativeCacheFromFile() {
  try {
    if (fs.existsSync(CREATIVE_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CREATIVE_CACHE_FILE, 'utf8'));
      const now = Date.now();
      const filtered = {};
      for (const [id, entry] of Object.entries(raw)) {
        if (entry._cachedAt && (now - entry._cachedAt) > CREATIVE_TTL) continue;
        if (entry.creative_id !== undefined) filtered[id] = entry;
      }
      return filtered;
    }
  } catch (e) { console.error('Creative cache read error:', e.message); }
  return {};
}

let creativeCache = loadCreativeCacheFromFile();

// ── Image Cache (creative_id → { url }, 24h TTL) ────────────────────────────
const IMAGE_CACHE_FILE = path.join(__dirname, '.cache-images.json');
const IMAGE_TTL = 24 * 60 * 60 * 1000;

function loadImageCache() {
  try {
    if (fs.existsSync(IMAGE_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(IMAGE_CACHE_FILE, 'utf8'));
      const now = Date.now();
      const filtered = {};
      for (const [id, entry] of Object.entries(raw)) {
        if (typeof entry === 'string') continue;
        if (entry._cachedAt && (now - entry._cachedAt) > IMAGE_TTL) continue;
        filtered[id] = entry;
      }
      return filtered;
    }
  } catch (e) { console.error('HD thumb cache read error:', e.message); }
  return {};
}

let imageCache = loadImageCache();

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function allTimeStart() {
  const d = new Date();
  d.setMonth(d.getMonth() - 36);
  return d.toISOString().split('T')[0];
}

function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().split('T')[0];
}

function getCredentials(req) {
  const token = req.headers['x-meta-token'] || process.env.META_ACCESS_TOKEN || '';
  const accountId = (req.headers['x-meta-account-id'] || process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, '');
  return { token, accountId };
}

async function fetchInsightsAsync(base, token, fields, timeRange, onProgress, filtering) {
  const params = {
    access_token: token, level: 'ad', fields,
    time_range: JSON.stringify(timeRange),
  };
  if (filtering) params.filtering = JSON.stringify(filtering);
  const createRes = await axios.post(`${base}/insights`, null, { params });

  if (createRes.data.data) return createRes.data.data;

  const reportId = createRes.data.report_run_id;
  if (!reportId) throw new Error('No report_run_id returned from Meta');

  let jobDone = false;
  for (let i = 0; i < 30; i++) {
    const poll = await axios.get(`${META_BASE_URL}/${reportId}`, {
      params: { access_token: token },
    });
    const status = poll.data.async_status;
    const pct = poll.data.async_percent_completion || 0;
    if (onProgress) onProgress(status, pct);
    if (status === 'Job Completed') { jobDone = true; break; }
    if (status === 'Job Failed' || status === 'Job Skipped') {
      throw new Error(`Async report ${status}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!jobDone) throw new Error('Async report timed out after 60s');

  const results = [];
  let url = `${META_BASE_URL}/${reportId}/insights`;
  let pageParams = { access_token: token, limit: 500 };
  while (url) {
    const res = await axios.get(url, { params: pageParams });
    results.push(...(res.data.data || []));
    const next = res.data.paging?.next || null;
    url = next;
    pageParams = next ? {} : null;
  }
  return results;
}

function findPurchaseAction(arr = []) {
  return arr.find(x => x.action_type === 'purchase' || x.action_type === 'omni_purchase');
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
      console.error(`Batch fetch failed:`, err.response?.data?.error?.message || err.message);
    }
  }
  return results;
}

// Aggregate by ad_id, then pick top-spend ad per ad_name
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
  const byName = {};
  for (const ad of Object.values(byAdId)) {
    if (ad.spend <= 0) continue;
    if (!byName[ad.ad_name] || ad.spend > byName[ad.ad_name].spend) {
      byName[ad.ad_name] = ad;
    }
  }
  return Object.values(byName).map(ad => ({
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

app.get('/api/dashboard', async (req, res) => {
  const { token, accountId } = getCredentials(req);
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });

  const today = todayStr();
  const base = `${META_BASE_URL}/act_${accountId}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const progress = msg => res.write(`data: ${JSON.stringify({ progress: msg })}\n\n`);
  const startTime = Date.now();
  const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  const mode = req.query.mode || 'all';
  const activeFilter = [{ field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE'] }];

  try {
    // ── Step 1: Fetch insights (spend + action_values) ──────────────────────
    const fields = 'ad_id,ad_name,spend,action_values';
    let allRows;
    let isIncremental = false;

    if (mode === 'active') {
      // Active mode: always fetch fresh with status filter, no incremental cache
      const since = allTimeStart();
      progress(`Step 1: Fetching active ads (${since} → ${today})... [${elapsed()}]`);
      allRows = await fetchInsightsAsync(base, token, fields, { since, until: today }, (s, p) => {
        progress(`Step 1: Polling report ${p}% [${elapsed()}]`);
      }, activeFilter);
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
          const newRows = await fetchInsightsAsync(base, token, fields, { since, until: today }, (s, p) => {
            progress(`Step 1: Polling report ${p}% [${elapsed()}]`);
          });
          allRows = [...cache.rows, ...newRows];
          progress(`Step 1: +${newRows.length} rows, total ${allRows.length} [${elapsed()}]`);
        }
      } else {
        const since = allTimeStart();
        progress(`Step 1: Fetching all-time data (${since} → ${today})... [${elapsed()}]`);
        allRows = await fetchInsightsAsync(base, token, fields, { since, until: today }, (s, p) => {
          progress(`Step 1: Polling report ${p}% [${elapsed()}]`);
        });
        progress(`Step 1: ${allRows.length} rows loaded [${elapsed()}]`);
      }

      insightsCache = { rows: allRows, lastUntil: today, cached_at: new Date().toISOString() };
      saveCacheAsync(INSIGHTS_CACHE_FILE, insightsCache);
    }

    // Pick top-spend ad per ad_name
    const topAds = pickTopSpendAds(allRows);
    progress(`${topAds.length} unique ad names (top spend per name) [${elapsed()}]`);

    // ── Step 2: Fetch creative info for top ads (only missing) ───────────────
    const topAdIds = topAds.map(a => a.ad_id);
    const missingCreativeIds = topAdIds.filter(id => !creativeCache[id] || !creativeCache[id].image_hash);
    if (missingCreativeIds.length > 0) {
      progress(`Step 2: Fetching creative info for ${missingCreativeIds.length} ads... [${elapsed()}]`);
      const fetched = await fetchAdsByIds(token, missingCreativeIds, 'id,creative{id,object_type,object_story_spec,asset_feed_spec}');
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
      saveCacheAsync(CREATIVE_CACHE_FILE, creativeCache);
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
      if (cc?.image_hash && ad.creative_id && !imageCache[ad.creative_id]) {
        if (!hashToCreativeIds[cc.image_hash]) hashToCreativeIds[cc.image_hash] = [];
        hashToCreativeIds[cc.image_hash].push(ad.creative_id);
      }
    }
    const missingHashes = Object.keys(hashToCreativeIds);
    if (missingHashes.length > 0) {
      progress(`Step 3: Fetching ${missingHashes.length} unique hashes for images... [${elapsed()}]`);
      const BATCH = 50;
      for (let i = 0; i < missingHashes.length; i += BATCH) {
        const batch = missingHashes.slice(i, i + BATCH);
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
        .filter(ad => ad.creative_id && !imageCache[ad.creative_id])
        .map(ad => ad.creative_id);
      if (stillMissing.length > 0) {
        progress(`Step 3b: ${stillMissing.length} images not in adimages, fetching thumbnails... [${elapsed()}]`);
        for (let i = 0; i < stillMissing.length; i += BATCH) {
          const batch = stillMissing.slice(i, i + BATCH);
          try {
            const res = await axios.get(`${META_BASE_URL}/`, {
              params: { ids: batch.join(','), fields: 'id,thumbnail_url', access_token: token }
            });
            const now = Date.now();
            for (const [id, data] of Object.entries(res.data)) {
              if (data?.thumbnail_url) {
                imageCache[id] = { url: data.thumbnail_url, _cachedAt: now };
              }
            }
          } catch (err) {
            console.error('Thumbnail fallback error:', err.response?.data?.error?.message || err.message);
          }
        }
      }

      saveCacheAsync(IMAGE_CACHE_FILE, imageCache);
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
      cached_at: insightsCache?.cached_at || new Date().toISOString(),
      incremental: isIncremental,
      totalRows: allRows.length,
      topAdsCount: topAds.length,
      imageAdsCount: imageAds.length,
      adsWithImage,
      adsWithLink,
    };
    progress(`Done [${elapsed()}]`);
    res.write(`data: ${JSON.stringify({ result })}\n\n`);
    res.end();
  } catch (err) {
    const metaError = err.response?.data?.error;
    let error = 'Meta API error';
    let detail = err.response?.data || err.message;

    if (metaError) {
      const code = metaError.code;
      const subcode = metaError.error_subcode;
      if (code === 190) {
        error = 'Meta API token expired or invalid';
        detail = subcode === 463
          ? 'Token has expired. Please generate a new access token from Meta Business Suite and update META_ACCESS_TOKEN in .env.'
          : subcode === 467
            ? 'Token is no longer valid. The user may have changed their password or revoked access.'
            : `Token error (subcode ${subcode}): ${metaError.message}`;
      } else if (code === 4 || code === 17) {
        error = 'Meta API rate limit reached';
        detail = 'Too many requests. Please wait a few minutes before trying again.';
      }
    }

    res.write(`data: ${JSON.stringify({ error, detail })}\n\n`);
    res.end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Meta Ads Dashboard running on http://localhost:${PORT}`));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { todayStr, addDays, findPurchaseAction, pickTopSpendAds };
}
