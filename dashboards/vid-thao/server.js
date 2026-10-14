require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express   = require('express');
const axios     = require('axios');
const path      = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const META_BASE_URL = `https://graph.facebook.com/v22.0`;

// ── In-memory caches ─────────────────────────────────────────────────────────
// Render free has no persistent disk (restart/spin-down wipes files), so caches
// live in memory only and last as long as the process.
// Ads cached with creative:null (e.g. video still encoding at fetch time) are
// retried once this cooldown passes, so a transient null doesn't hide the video.
const NULL_CREATIVE_RETRY_MS = 60 * 60 * 1000; // 1 hour
const HD_THUMB_TTL = 24 * 60 * 60 * 1000;      // Meta CDN URLs expire

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
    },
    _cachedAt: ad._cachedAt || Date.now(),
  };
}

const AD_METRICS = [
  'impressions', 'clicks', 'spend',
  'actions', 'action_values',
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

// Campaign name from tc_vid_form workflow: "TC | Vid | {folder} | {email before @} | yyMMdd";
// the email part is omitted when the form had no email. Returns '' otherwise.
function parseSubmittedBy(campaignName) {
  const p = String(campaignName || '').split('|').map(s => s.trim());
  if (p[0] !== 'TC' || p[1] !== 'Vid' || p.length < 5 || !/^\d{6}$/.test(p[p.length - 1])) return '';
  return p[p.length - 2].toLowerCase();
}

// Group insights rows by creative_id + submitter (creative looked up via
// creativeCache by ad_id) and aggregate metrics. Thumbnail comes from hdThumbMap[creative_id].
function groupByCreative(rows, creativeCache, hdThumbMap) {
  const map = {};
  for (const row of rows) {
    const c = creativeCache[row.ad_id]?.creative;
    const id = c?.id || 'unknown';
    const submittedBy = parseSubmittedBy(row.campaign_name);
    const key = `${id}|${submittedBy}`;
    if (!map[key]) {
      map[key] = {
        creative_id:   id,
        submitted_by:  submittedBy,
        format:        c ? (FORMAT_MAP[c.object_type] || 'Image') : null,
        thumbnail_url: c ? (hdThumbMap[c.id] || null) : null,
        is_catalog:    !!c?.is_catalog,
        ad_name:       row.ad_name || '',
        _rows:         [],
      };
    }
    map[key]._rows.push(row);
  }
  return Object.values(map).map(({ _rows, ...entry }) => aggregateMetrics(entry, _rows));
}

// Only ads with video plays can be video ads; skipping the rest avoids fetching
// creative info for image ads the dashboard never shows.
function hasVideoPlays(row) {
  return sumActionValue(row.video_play_actions) > 0;
}

function collectFetchableCreativeIds(allAds) {
  const ids = new Set();
  for (const ad of allAds) {
    const c = ad.creative;
    if (!c?.id) continue;
    if (c.is_catalog) continue;
    if (c.object_type !== 'VIDEO') continue;
    ids.add(c.id);
  }
  return [...ids];
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function getCredentials() {
  return {
    token:     process.env.META_ACCESS_TOKEN || '',
    accountId: (process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, ''),
  };
}

// Async report: create → poll → fetch all results
async function fetchInsightsAsync(base, token, fields, timeRange, onProgress) {
  const createRes = await axios.post(`${base}/insights`, null, {
    params: {
      access_token: token, level: 'ad', fields,
      time_range: JSON.stringify(timeRange),
      filtering: JSON.stringify([
        { field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
        { field: 'spend', operator: 'GREATER_THAN', value: 1 },
      ]),
      sort: 'spend_descending',
    },
  });
  let lastThrottle = createRes.headers['x-fb-ads-insights-throttle'] || null;

  // Meta may return data directly for small datasets
  if (createRes.data.data) return createRes.data.data;

  const reportId = createRes.data.report_run_id;
  if (!reportId) throw new Error('No report_run_id returned from Meta');

  let completed = false;
  let lastPct = 0;
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const poll = await axios.get(`${META_BASE_URL}/${reportId}`, { params: { access_token: token } });
    if (poll.headers['x-fb-ads-insights-throttle']) lastThrottle = poll.headers['x-fb-ads-insights-throttle'];
    const status = poll.data.async_status;
    const pct = poll.data.async_percent_completion || 0;
    lastPct = pct;
    if (onProgress) onProgress(status, pct);
    if (status === 'Job Completed') { completed = true; break; }
    if (status === 'Job Failed' || status === 'Job Skipped') {
      const err = new Error(`Async report ${status}`);
      err.asyncReport = {
        status, report_run_id: reportId, percent_complete: pct, poll_attempt: i + 1,
        error_code:       poll.data.error_code,
        error_subcode:    poll.data.error_subcode,
        error_message:    poll.data.error_message,
        error_user_title: poll.data.error_user_title,
        error_user_msg:   poll.data.error_user_msg,
        throttle: lastThrottle,
      };
      throw err;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!completed) {
    const err = new Error(`Async report timed out after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);
    err.asyncReport = {
      status: 'Timed out', report_run_id: reportId, percent_complete: lastPct,
      poll_attempt: POLL_MAX_ATTEMPTS, throttle: lastThrottle,
    };
    throw err;
  }

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
    return { rows: ic.current, source: 'cache' };
  }
  progress(`Creating async report... [${elapsed()}]`);
  const currRows = await fetchInsightsAsync(base, token, fields, current, (s, p) => {
    progress(`Polling report: ${p}% [${elapsed()}]`);
  });
  insightsCache[cacheKey] = { current: currRows };
  progress(`Insights loaded: ${currRows.length} rows [${elapsed()}]`);
  return { rows: currRows, source: 'api' };
}

async function ensureCreativeInfo({ adIds, token, progress, elapsed }) {
  const now0 = Date.now();
  const missingIds = adIds.filter(id => {
    const e = creativeCache[id];
    if (!e) return true;                                                   // never cached
    if (!e.creative && (now0 - (e._cachedAt || 0)) > NULL_CREATIVE_RETRY_MS) return true; // stale null → retry
    return false;
  });
  if (missingIds.length === 0) {
    progress(`All ${adIds.length} ads already cached [${elapsed()}]`);
    return;
  }
  progress(`Fetching creative info for ${missingIds.length} ads (new or retried) [${elapsed()}]`);
  const fetched = await fetchAdsByIds(token, missingIds, 'id,creative{id,object_type,object_story_spec{template_data}}');
  const now = Date.now();
  for (const ad of fetched) {
    creativeCache[ad.id] = slimCreative({ ...ad, _cachedAt: now });
  }
  for (const id of missingIds) {
    if (!creativeCache[id]) creativeCache[id] = { id, creative: null, _cachedAt: now };
  }
  progress(`Creative info cached (${fetched.length} ads) [${elapsed()}]`);
}

async function ensureHdThumbnails({ creativeIds, token, progress, elapsed }) {
  const now = Date.now();
  const missing = creativeIds.filter(cid => !hdThumbCache[cid] || (now - hdThumbCache[cid]._cachedAt) > HD_THUMB_TTL);
  if (missing.length === 0) {
    if (creativeIds.length > 0) progress(`All ${creativeIds.length} HD thumbnails cached [${elapsed()}]`);
    return { attempted: 0, succeeded: 0 };
  }
  progress(`Fetching HD thumbnails for ${missing.length} new creatives... [${elapsed()}]`);
  let succeeded = 0;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    try {
      const res = await axios.get(`${META_BASE_URL}/`, {
        params: { ids: batch.join(','), fields: 'thumbnail_url', thumbnail_width: 480, thumbnail_height: 480, access_token: token }
      });
      for (const [id, data] of Object.entries(res.data)) {
        if (data?.thumbnail_url) {
          hdThumbCache[id] = { url: data.thumbnail_url, _cachedAt: Date.now() };
          succeeded++;
        }
      }
    } catch (err) {
      console.error('HD thumb fetch error:', err.response?.data?.error?.message || err.message);
    }
  }
  progress(`Fetched HD thumbnails for ${succeeded}/${missing.length} creatives [${elapsed()}]`);
  return { attempted: missing.length, succeeded };
}

function metaErrorMessage(err) {
  if (err.asyncReport) {
    const ar = err.asyncReport;
    const codeBits = [];
    if (ar.error_code != null)    codeBits.push(`code ${ar.error_code}`);
    if (ar.error_subcode != null) codeBits.push(`subcode ${ar.error_subcode}`);
    const reason = ar.error_message || ar.error_user_msg || `${ar.status} at ${ar.percent_complete}% (poll #${ar.poll_attempt})`;
    const summary = codeBits.length ? `${codeBits.join(' / ')} — ${reason}` : reason;
    return { error: `Meta async report ${ar.status}`, detail: { message: summary, ...ar } };
  }
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
  const { token, accountId } = getCredentials();
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });

  const days = Number(req.query.days);
  const forceRefresh = req.query.refresh === '1';
  const current = { since: dateStr(days), until: dateStr(0) };
  const fields  = `ad_id,ad_name,campaign_name,${AD_METRICS}`;
  const base    = `${META_BASE_URL}/act_${accountId}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const progress = msg => res.write(`data: ${JSON.stringify({ progress: msg })}\n\n`);
  const startTime = Date.now();
  const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  try {
    const { rows: rawRows, source: insightsSource } = await loadOrFetchInsights({ days, forceRefresh, base, token, fields, current, progress, elapsed });
    const spendRows = rawRows.filter(r => parseFloat(r.spend || 0) > 1);
    const currRows  = spendRows.filter(hasVideoPlays);

    const allAdIds = currRows.map(r => r.ad_id).filter(Boolean);
    const cachedAdsBefore  = allAdIds.filter(id => creativeCache[id]).length;
    await ensureCreativeInfo({ adIds: allAdIds, token, progress, elapsed });
    const allAds = allAdIds.map(id => creativeCache[id]).filter(Boolean);

    const fetchableHdIds = collectFetchableCreativeIds(allAds);
    const cachedHdBefore = fetchableHdIds.filter(cid => hdThumbCache[cid] && (Date.now() - hdThumbCache[cid]._cachedAt) <= HD_THUMB_TTL).length;
    const hdResult = await ensureHdThumbnails({ creativeIds: fetchableHdIds, token, progress, elapsed });

    const hdThumbMap = {};
    for (const [id, entry] of Object.entries(hdThumbCache)) hdThumbMap[id] = entry.url;

    progress(`Processing data... [${elapsed()}]`);
    const grouped = groupByCreative(currRows, creativeCache, hdThumbMap);
    const videoCount    = grouped.filter(c => c.format === 'Video').length;
    const imageCount    = grouped.filter(c => c.format === 'Image').length;
    const carouselCount = grouped.filter(c => c.format === 'Carousel').length;
    const missingCount  = grouped.filter(c => !c.format).length;
    const result = {
      creatives: { current: grouped },
      period:    { current },
      cached_at: new Date().toISOString(),
    };
    progress(`Done [${elapsed()}]`);
    const debug = {
      account: accountId,
      days,
      refresh: forceRefresh,
      insights:  { source: insightsSource, raw: rawRows.length, afterSpendFilter: spendRows.length, withVideoPlays: currRows.length },
      ads:       { cached: cachedAdsBefore, fetched: allAdIds.length - cachedAdsBefore },
      hdThumbs:  { fetchable: fetchableHdIds.length, cached: cachedHdBefore, fetched: hdResult.succeeded, failed: hdResult.attempted - hdResult.succeeded },
      creatives: { total: grouped.length, video: videoCount, image: imageCount, carousel: carouselCount, missing: missingCount },
      elapsedMs: Date.now() - startTime,
    };
    res.write(`data: ${JSON.stringify({ debug })}\n\n`);
    res.write(`data: ${JSON.stringify({ result })}\n\n`);
    res.end();
  } catch (err) {
    const { error, detail } = metaErrorMessage(err);
    res.write(`data: ${JSON.stringify({ error, detail, elapsedMs: Date.now() - startTime })}\n\n`);
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
    collectFetchableCreativeIds,
    hasVideoPlays,
    parseSubmittedBy,
  };
}
