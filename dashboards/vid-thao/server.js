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
      video_id:    c.object_story_spec?.video_data?.video_id || null,
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

// One row per video: insights rows (one per ad) are grouped by video (+ submitter), so every
// ad/creative that uses the same video is summed together. The video is the BigQuery one for ads
// TC Vid created (videoTable.byAd), else the creative's uploaded video; creatives without a video
// fall back to their creative id. The thumbnail is the first HD thumbnail found among the group's
// current creatives (hdThumbMap is keyed by creative id), so a thumbnail changed in Ads Manager
// shows once the ad's creative is read again.
function groupByVideo(rows, creativeCache, hdThumbMap, videoTable = {}) {
  const byAd = videoTable.byAd || {};
  const byVideo = videoTable.byVideo || {};
  const map = {};
  for (const row of rows) {
    const c = creativeCache[row.ad_id]?.creative;
    const bq = byAd[row.ad_id] || (c?.video_id && byVideo[c.video_id]) || null;
    const videoId = bq?.video_id || c?.video_id || null;
    const id = videoId || c?.id || 'unknown';
    // submitter: BigQuery only; a video that is not there has no submitter
    const submittedBy = bq?.submitted_by || '';
    const key = `${id}|${submittedBy}`;
    if (!map[key]) {
      map[key] = {
        video_id:       videoId,
        creative_id:    c?.id || 'unknown',
        submitted_by:   submittedBy,
        // a video in BigQuery stays a video even when Meta no longer returns its creative
        format:         c ? (FORMAT_MAP[c.object_type] || 'Image') : (bq ? 'Video' : null),
        thumbnail_url:  null,
        is_catalog:     !!c?.is_catalog,
        ad_name:        row.ad_name || bq?.ad_name || '',
        drive_file_id:  null,
        drive_thumb_id: null,
        reel_url:       null,
        created_at:     null,
        _creatives:     new Set(),
        _rows:          [],
      };
    }
    const g = map[key];
    if (c?.id) g._creatives.add(c.id);
    // thumb_ad_id = the ad whose current creative gives the row's thumbnail (rows come spend-descending,
    // so the top ad with a thumbnail); "Fetch from Meta" in the viewer reads that same ad again
    if (!g.thumbnail_url && c?.id && hdThumbMap[c.id]) { g.thumbnail_url = hdThumbMap[c.id]; g.thumb_ad_id = row.ad_id; }
    if (!g.thumb_ad_id) g.thumb_ad_id = row.ad_id || null;
    if (!g.drive_file_id && bq?.drive_file_id) {
      g.drive_file_id  = bq.drive_file_id;
      g.drive_thumb_id = bq.drive_file_id;
    }
    if (!g.reel_url && bq?.reel_url) g.reel_url = bq.reel_url;
    if (!g.created_at && bq?.created_at) g.created_at = bq.created_at;
    g._rows.push(row);
  }
  return Object.values(map).map(({ _rows, _creatives, ...entry }) =>
    aggregateMetrics({ ...entry, creative_count: _creatives.size, ad_count: new Set(_rows.map(r => r.ad_id)).size }, _rows));
}

// BigQuery video table rows → byAd (ads TC Vid created) and byVideo (uploaded video_id; an ad row
// wins over a legacy row that only has the submitter).
function indexVideoTable(rows) {
  const byAd = {}, byVideo = {};
  for (const r of rows || []) {
    if (!r?.video_id) continue;
    const row = {
      video_id:       String(r.video_id),
      ad_id:          r.ad_id ? String(r.ad_id) : null,
      ad_name:        r.ad_name || '',
      submitted_by:   String(r.submitted_by || '').trim().toLowerCase(),
      drive_file_id:  r.drive_file_id || null,
      reel_url:       r.reel_url || null,
      created_at:     r.created_at || null,
    };
    if (row.ad_id) byAd[row.ad_id] = row;
    if (!byVideo[row.video_id] || (row.ad_id && !byVideo[row.video_id].ad_id)) byVideo[row.video_id] = row;
  }
  return { byAd, byVideo };
}

// Ads TC Vid created inside the period that have no insights row (no delivery yet): listed with
// zero metrics so a video shows up as soon as it is submitted.
function newAdRows(byAd, period, seenAdIds) {
  const out = [];
  for (const r of Object.values(byAd || {})) {
    const day = String(r.created_at || '').slice(0, 10);
    if (!day || day < period.since || day > period.until || seenAdIds.has(r.ad_id)) continue;
    out.push({ ad_id: r.ad_id, ad_name: r.ad_name || '', impressions: '0', clicks: '0', spend: '0' });
  }
  return out;
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

// Video table read straight from BigQuery zum-media-log.media.ad_videos (one row per ad TC Vid
// created: Drive file, reel link, submitter). Service account n8n-bigquery: env BQ_SA_KEY = the key
// JSON (Render), or BQ_SA_KEY_FILE = path to the key file (local). No key or any error → empty
// table: rows then have no submitter and no Drive video.
const VIDEOS_SQL = `SELECT video_id, LOWER(TRIM(SPLIT(IFNULL(submitter_email, ''), '@')[OFFSET(0)])) AS submitted_by,
  ad_id, ad_name, drive_file_id, reel_url,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at
FROM \`zum-media-log.media.ad_videos\`
WHERE video_id IS NOT NULL`;
let _bq = null;
function bigQuery() {
  if (_bq) return _bq;
  let key = null;
  if (process.env.BQ_SA_KEY) key = JSON.parse(process.env.BQ_SA_KEY);
  else if (process.env.BQ_SA_KEY_FILE) key = JSON.parse(require('fs').readFileSync(path.resolve(__dirname, process.env.BQ_SA_KEY_FILE), 'utf8'));
  if (!key) return null;
  const { BigQuery } = require('@google-cloud/bigquery');
  _bq = new BigQuery({ projectId: key.project_id, credentials: { client_email: key.client_email, private_key: key.private_key } });
  return _bq;
}
async function loadVideoTable() {
  try {
    const bq = bigQuery();
    if (!bq) return { ...indexVideoTable([]), status: 'no key' };
    const [rows] = await bq.query({ query: VIDEOS_SQL, location: 'US', jobTimeoutMs: 20000 });
    return { ...indexVideoTable(rows), status: 'ok' };
  } catch (err) {
    console.error('BigQuery video table failed:', err.message);
    return { ...indexVideoTable([]), status: 'error' };
  }
}

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
        { field: 'spend', operator: 'GREATER_THAN', value: 0 },
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

// force (Load Data) reads every ad again: editing an ad in Ads Manager (e.g. its thumbnail)
// attaches a new creative, which a cached entry would hide.
async function ensureCreativeInfo({ adIds, force = false, token, progress, elapsed }) {
  const now0 = Date.now();
  const missingIds = force ? [...adIds] : adIds.filter(id => {
    const e = creativeCache[id];
    if (!e) return true;                                                   // never cached
    if (!e.creative && (now0 - (e._cachedAt || 0)) > NULL_CREATIVE_RETRY_MS) return true; // stale null → retry
    return false;
  });
  if (missingIds.length === 0) {
    progress(`All ${adIds.length} ads already cached [${elapsed()}]`);
    return;
  }
  progress(`Fetching creative info for ${missingIds.length} ads (${force ? 'all, Load Data' : 'new or retried'}) [${elapsed()}]`);
  const fetched = await fetchAdsByIds(token, missingIds, 'id,creative{id,object_type,object_story_spec{template_data,video_data{video_id}}}');
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
    const summary = codeBits.length ? `${codeBits.join(' / ')}: ${reason}` : reason;
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

// GET /api/ad-thumb?ad_id= — the ad's real thumbnail now: reads its current creative (editing the ad
// in Ads Manager attaches a new one), then that creative's 480px thumbnail. 2 Meta calls.
app.get('/api/ad-thumb', async (req, res) => {
  const { token } = getCredentials();
  const adId = String(req.query.ad_id || '');
  if (!token || !/^\d+$/.test(adId)) return res.status(400).json({ error: 'Missing token or ad id' });
  try {
    const ad = (await axios.get(`${META_BASE_URL}/${adId}`, { params: { fields: 'id,creative{id,object_type,object_story_spec{template_data,video_data{video_id}}}', access_token: token } })).data;
    creativeCache[adId] = slimCreative({ ...ad, _cachedAt: Date.now() });
    const cid = ad?.creative?.id;
    if (!cid) return res.json({ url: null });
    const th = (await axios.get(`${META_BASE_URL}/${cid}`, { params: { fields: 'thumbnail_url', thumbnail_width: 480, thumbnail_height: 480, access_token: token } })).data;
    const url = th?.thumbnail_url || null;
    if (url) hdThumbCache[cid] = { url, _cachedAt: Date.now() };
    res.json({ url });
  } catch (err) {
    const { error, detail } = metaErrorMessage(err);
    res.status(502).json({ error, detail });
  }
});

// GET|HEAD /api/drive-video/:id — the original video from Google Drive. Browsers are refused when they
// load drive.usercontent.google.com directly; the server is not. Range is passed through so the
// player can seek; HEAD gives the size for the viewer's Details line.
app.get('/api/drive-video/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[\w-]{20,}$/.test(id)) return res.status(400).end();
  const url = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  try {
    const up = await axios({
      method: req.method === 'HEAD' ? 'head' : 'get', url, responseType: 'stream', timeout: 30000,
      headers: req.headers.range ? { Range: req.headers.range } : {}, validateStatus: s => s < 500,
    });
    if (!/^video\//.test(up.headers['content-type'] || '')) { up.data?.destroy?.(); return res.status(404).end(); }
    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (up.headers[h]) res.setHeader(h, up.headers[h]);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (req.method === 'HEAD') return res.end();
    up.data.pipe(res);
    req.on('close', () => up.data.destroy());
  } catch (err) {
    console.error('Drive video proxy failed:', err.message);
    if (!res.headersSent) res.status(502).end();
  }
});

// GET /api/dashboard?days=7 — SSE with progress updates
app.get('/api/dashboard', async (req, res) => {
  const { token, accountId } = getCredentials();
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });

  const days = Number(req.query.days);
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
    // The BigQuery video table loads while Meta builds the insights report (neither needs the
    // other). loadVideoTable never rejects: errors come back as status 'error'.
    const videoTablePending = loadVideoTable();
    const { rows: rawRows, source: insightsSource } = await loadOrFetchInsights({ days, forceRefresh, base, token, fields, current, progress, elapsed });
    progress(`Loading videos from BigQuery... [${elapsed()}]`);
    const videoTable = await videoTablePending;
    // Form videos (BigQuery): every ad that delivered, plus ads created in the period with no
    // delivery yet. Other video ads: spend > 1 with video plays, as before.
    const formRows  = rawRows.filter(r => videoTable.byAd[r.ad_id]);
    const otherRows = rawRows.filter(r => !videoTable.byAd[r.ad_id] && parseFloat(r.spend || 0) > 1 && hasVideoPlays(r));
    const newRows   = newAdRows(videoTable.byAd, current, new Set(rawRows.map(r => r.ad_id)));
    const currRows  = [...formRows, ...otherRows, ...newRows];

    const allAdIds = currRows.map(r => r.ad_id).filter(Boolean);
    const cachedAdsBefore  = forceRefresh ? 0 : allAdIds.filter(id => creativeCache[id]).length;
    await ensureCreativeInfo({ adIds: allAdIds, force: forceRefresh, token, progress, elapsed });
    const allAds = allAdIds.map(id => creativeCache[id]).filter(Boolean);

    const fetchableHdIds = collectFetchableCreativeIds(allAds);
    const cachedHdBefore = fetchableHdIds.filter(cid => hdThumbCache[cid] && (Date.now() - hdThumbCache[cid]._cachedAt) <= HD_THUMB_TTL).length;
    const hdResult = await ensureHdThumbnails({ creativeIds: fetchableHdIds, token, progress, elapsed });

    // only the creatives of this load (the cache keeps every creative read since the process started)
    const hdThumbMap = {};
    for (const ad of allAds) {
      const cid = ad.creative?.id;
      if (cid && hdThumbCache[cid]) hdThumbMap[cid] = hdThumbCache[cid].url;
    }

    progress(`Processing data... [${elapsed()}]`);
    const grouped = groupByVideo(currRows, creativeCache, hdThumbMap, videoTable);
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
      insights:  { source: insightsSource, raw: rawRows.length, formAds: formRows.length, otherVideoAds: otherRows.length, newAds: newRows.length },
      ads:       { cached: cachedAdsBefore, fetched: allAdIds.length - cachedAdsBefore },
      bigquery:  { status: videoTable.status, videos: Object.keys(videoTable.byVideo).length, ads: Object.keys(videoTable.byAd).length },
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
module.exports = {
  dateStr,
  findPurchaseAction,
  sumActionValue,
  sumActionByType,
  aggregateMetrics,
  groupByVideo,
  indexVideoTable,
  newAdRows,
  collectFetchableCreativeIds,
  hasVideoPlays,
};
