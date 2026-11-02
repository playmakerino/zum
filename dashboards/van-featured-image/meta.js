// Meta Marketing API + Triple Whale helpers shared by the dashboard servers.
// SOURCE OF TRUTH: dashboards/shared/meta.js. sync-shared.ps1 copies it next to each server.js
// (each dashboard is its own Render service and only deploys its own folder).
const axios = require('axios');

// Meta keeps a Marketing API version about a year (v22.0 ended 2026-02-19, v24.0 2026-10-06).
// Bump here, run sync-shared.ps1, then Load Data once on each dashboard.
const META_API_VERSION = 'v26.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;
const BATCH_SIZE = 50;
const POLL_MAX_ATTEMPTS = 60;
const timing = { pollMs: 2000, retryMs: [5000, 15000, 30000] }; // an object so tests can shorten it
const DEFAULT_FILTERING = [
  { field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
  { field: 'spend', operator: 'GREATER_THAN', value: 0 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Token and ad account come from the server environment only.
function getCredentials() {
  return {
    token:     process.env.META_ACCESS_TOKEN || '',
    accountId: (process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, ''),
  };
}

function findPurchaseAction(arr = []) {
  return arr.find(x => x.action_type === 'purchase' || x.action_type === 'omni_purchase');
}

// Thrown by stopped() once no browser is waiting for the load any more (see sseLoad).
class LoadStopped extends Error {}

// Graph batch request (POST / with batch=[GET <id>?fields=…]), 50 ids per request → [{ id, ...fields }].
// v26.0 dropped GET /?ids=… ("The ids query parameter is deprecated in v26.0+").
// A failed id or batch is logged and skipped.
async function fetchByIds(token, ids, fields, extraParams = {}, stopped) {
  const out = [];
  const query = new URLSearchParams({ fields, ...extraParams }).toString();
  let failed = 0, lastError = '';
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    stopped?.();
    const batch = ids.slice(i, i + BATCH_SIZE);
    try {
      const res = await axios.post(`${META_BASE_URL}/`, null, {
        params: { access_token: token, include_headers: false, batch: JSON.stringify(batch.map(id => ({ method: 'GET', relative_url: `${id}?${query}` }))) },
      });
      (res.data || []).forEach((r, j) => {
        let body = null;
        try { body = JSON.parse(r?.body || 'null'); } catch {}
        if (r?.code === 200 && body && !body.error) out.push({ ...body, id: body.id || batch[j] });
        else { failed++; lastError = body?.error?.message || `HTTP ${r?.code}`; }
      });
    } catch (err) {
      failed += batch.length;
      lastError = err.response?.data?.error?.message || err.message;
    }
  }
  if (failed) console.error(`Meta: ${failed}/${ids.length} ids (${fields}) failed, last error: ${lastError}`);
  return out;
}

function retryable(message, asyncReport) {
  const err = new Error(message);
  err.retryable = true;
  err.asyncReport = asyncReport;
  return err;
}

// One async insights report: create, poll every 2s (max 2 min), read every page.
// Meta's "Job Failed" / "Job Skipped" / a timeout throw with err.retryable.
async function runInsightsReport({ base, token, fields, timeRange, filtering, sort, onProgress, stopped }) {
  stopped?.();
  const createRes = await axios.post(`${base}/insights`, null, {
    params: { access_token: token, level: 'ad', fields, time_range: JSON.stringify(timeRange), filtering: JSON.stringify(filtering), sort },
  });
  let throttle = createRes.headers?.['x-fb-ads-insights-throttle'] || null;
  if (createRes.data.data) return createRes.data.data; // Meta may answer small reports directly
  const reportId = createRes.data.report_run_id;
  if (!reportId) throw new Error('No report_run_id returned from Meta');

  let pct = 0;
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    stopped?.();
    const poll = await axios.get(`${META_BASE_URL}/${reportId}`, { params: { access_token: token } });
    throttle = poll.headers?.['x-fb-ads-insights-throttle'] || throttle;
    const status = poll.data.async_status;
    pct = poll.data.async_percent_completion || 0;
    onProgress?.(pct);
    if (status === 'Job Completed') return readReport(reportId, token);
    if (status === 'Job Failed' || status === 'Job Skipped') {
      const { error_code, error_subcode, error_message, error_user_title, error_user_msg } = poll.data;
      throw retryable(`Async report ${status}`, { status, report_run_id: reportId, percent_complete: pct, poll_attempt: i + 1, error_code, error_subcode, error_message, error_user_title, error_user_msg, throttle });
    }
    await sleep(timing.pollMs);
  }
  throw retryable(`Async report timed out after ${POLL_MAX_ATTEMPTS * timing.pollMs / 1000}s`, { status: 'Timed out', report_run_id: reportId, percent_complete: pct, poll_attempt: POLL_MAX_ATTEMPTS, throttle });
}

async function readReport(reportId, token) {
  const rows = [];
  let url = `${META_BASE_URL}/${reportId}/insights`;
  let params = { access_token: token, limit: 500 };
  while (url) {
    const res = await axios.get(url, { params });
    rows.push(...(res.data.data || []));
    url = res.data.paging?.next || null;
    params = {}; // the next link already carries the token and limit
  }
  return rows;
}

// The same query as a tiny synchronous call: Meta's error object when the query itself is bad
// (token, permission, parameter), null when it is valid and the async failure was Meta's.
async function probeInsightsError({ base, token, fields, filtering, sort }) {
  try {
    await axios.get(`${base}/insights`, { params: { access_token: token, level: 'ad', fields, date_preset: 'today', limit: 1, filtering: JSON.stringify(filtering), sort } });
    return null;
  } catch (e) {
    return e.response?.data?.error || { message: e.message };
  }
}

// Insights rows (level ad). Meta fails async reports now and then even for valid queries and a
// fresh report usually works, so a failed or timed-out report is run again after 5s, 15s and 30s.
// When that runs out, probeInsightsError recovers the real reason (a failed job carries none).
// onProgress(percent) while polling; onRetry(text) before each new attempt.
async function fetchInsights({ base, token, fields, timeRange, filtering = DEFAULT_FILTERING, sort = 'spend_descending', onProgress, onRetry, stopped }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runInsightsReport({ base, token, fields, timeRange, filtering, sort, onProgress, stopped });
    } catch (err) {
      if (!err.retryable) throw err;
      if (attempt < timing.retryMs.length) {
        onRetry?.(`Meta report ${err.asyncReport.status}, retrying in ${timing.retryMs[attempt] / 1000}s (${attempt + 1}/${timing.retryMs.length})`);
        await sleep(timing.retryMs[attempt]);
        continue;
      }
      err.asyncReport.retries = attempt;
      const probe = await probeInsightsError({ base, token, fields, filtering, sort });
      if (probe) err.response = { data: { error: probe } }; // the token / rate limit messages then apply
      else err.asyncReport.queryValid = true;
      throw err;
    }
  }
}

// { error, detail } for the browser
function metaErrorMessage(err) {
  if (err.tripleWhale) return { error: 'Triple Whale request failed', detail: err.message };
  const meta = err.response?.data?.error;
  if (meta) {
    const { code, error_subcode: subcode, message } = meta;
    if (code === 190) {
      const detail = subcode === 463 ? 'Token has expired. Generate a new access token in Meta Business Suite and update META_ACCESS_TOKEN.'
        : subcode === 467 ? 'Token is no longer valid. The user may have changed their password or revoked access.'
        : `Token error (subcode ${subcode}): ${message}`;
      return { error: 'Meta API token expired or invalid', detail };
    }
    if (code === 4 || code === 17) return { error: 'Meta API rate limit reached', detail: 'Too many requests. Please wait a few minutes before trying again.' };
    const tag = code != null ? `[${code}${subcode != null ? '/' + subcode : ''}] ` : '';
    return { error: err.asyncReport ? `Meta async report ${err.asyncReport.status}` : 'Meta API error', detail: tag + (message || err.message) };
  }
  if (err.asyncReport) {
    const ar = err.asyncReport;
    const codeBits = [];
    if (ar.error_code != null)    codeBits.push(`code ${ar.error_code}`);
    if (ar.error_subcode != null) codeBits.push(`subcode ${ar.error_subcode}`);
    let reason = ar.error_message || ar.error_user_msg || `${ar.status} at ${ar.percent_complete}% (poll #${ar.poll_attempt})`;
    if (ar.queryValid) reason += `. Still failing after ${ar.retries} retries although the query is valid: a temporary Meta problem, try again shortly.`;
    return { error: `Meta async report ${ar.status}`, detail: { message: codeBits.length ? `${codeBits.join(' / ')}: ${reason}` : reason, ...ar } };
  }
  const body = err.response?.data;
  if (typeof body === 'string' && body.includes('<!DOCTYPE html')) return { error: 'Meta API temporarily unavailable', detail: 'Meta returned an error page. Please try again shortly.' };
  return { error: 'Meta API error', detail: err.message };
}

// GET /api/dashboard is an event stream run as one "load" per key: a request with the key of a
// running load (another tab, a second click) joins it instead of starting another round of Meta
// calls, and gets its progress and result. When no browser is waiting any more the load stops at
// its next Meta call. run({ progress, send, elapsed, startTime, stopped }) sends debug / result.
const loads = new Map();

function sseLoad(res, key, run) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  let load = loads.get(key);
  if (load) {
    load.clients.add(res);
    if (load.lastProgress) res.write(load.lastProgress);
  } else {
    load = { clients: new Set([res]), lastProgress: null };
    loads.set(key, load);
    runLoad(key, load, run);
  }
  res.on('close', () => load.clients.delete(res));
}

async function runLoad(key, load, run) {
  const startTime = Date.now();
  const send = obj => {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    if (obj.progress) load.lastProgress = line;
    for (const c of load.clients) c.write(line);
  };
  const ctx = {
    startTime,
    send,
    progress: msg => send({ progress: msg }),
    elapsed: () => ((Date.now() - startTime) / 1000).toFixed(1) + 's',
    stopped: () => { if (!load.clients.size) throw new LoadStopped('no browser is waiting for it'); },
  };
  try {
    await run(ctx);
  } catch (err) {
    if (err instanceof LoadStopped) console.log(`Load ${key} stopped: ${err.message}`);
    else send({ ...metaErrorMessage(err), elapsedMs: Date.now() - startTime });
  } finally {
    loads.delete(key);
    for (const c of load.clients) c.end();
  }
}

// ── Triple Whale ─────────────────────────────────────────────────────────────
// Ad metrics come from Triple Whale SQL (ads_table, about 1s per query, no Meta rate limit); Meta
// is only asked for creatives and images. Matched Meta per ad on 2026-11-02 (spend, impressions,
// clicks, purchases, purchase value, 3s views, ThruPlays, plays). Meta's average watch time has no
// Triple Whale column. Key: env TRIPLE_WHALE_API_KEY (local: D:/keys/.env.triplewhale).
const TW_URL = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const TW_SHOP_ID = process.env.TW_SHOP_ID || '422aa5-ca.myshopify.com';

function twError(message) {
  const err = new Error(message);
  err.tripleWhale = true;
  return err;
}

// One SQL query → array of rows. start / end (YYYY-MM-DD) also go in `period`, which Triple Whale requires.
async function twSql(query, start, end) {
  const key = process.env.TRIPLE_WHALE_API_KEY;
  if (!key) throw twError('Missing TRIPLE_WHALE_API_KEY');
  let res;
  try {
    res = await axios.post(TW_URL, { shopId: TW_SHOP_ID, query, period: { startDate: start, endDate: end } },
      { headers: { 'x-api-key': key }, timeout: 120000 });
  } catch (err) {
    const d = err.response?.data;
    const detail = d?.message || d?.error || err.message;
    throw twError(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  const d = res.data;
  return Array.isArray(d) ? d : (d?.data || d?.rows || []);
}

// One row per ad with spend in [since, until] whose current status is in `statuses`, spend
// descending, in the shape of Meta insights rows (actions / action_values / video_*_actions), so
// code written for fetchInsights reads it unchanged.
async function fetchAdRows({ since, until, statuses = ['ACTIVE', 'PAUSED'] }) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) throw twError('Bad date range');
  const st = statuses.filter(s => /^[A-Z_]+$/.test(s)).map(s => `'${s}'`).join(',');
  const rows = await twSql(`SELECT toString(ad_id) AS ad_id, any(nullIf(ad_name, '')) AS ad_name,
  argMax(ad_effective_status, (event_date, event_hour)) AS status,
  sum(spend) AS spend, sum(impressions) AS imp, sum(clicks) AS clk, sum(conversions) AS ord, sum(conversion_value) AS rev,
  sum(three_second_video_view) AS v3, sum(thruplays) AS tp, sum(total_video_view) AS vp
FROM ads_table
WHERE channel = 'facebook-ads' AND event_date BETWEEN '${since}' AND '${until}'
GROUP BY ad_id
HAVING spend > 0 AND status IN (${st})
ORDER BY spend DESC`, since, until);
  const act = (type, value) => [{ action_type: type, value: String(Number(value) || 0) }];
  return rows.filter(r => r.ad_id).map(r => ({
    ad_id: String(r.ad_id),
    ad_name: r.ad_name || '',
    status: r.status,
    spend: String(Number(r.spend) || 0),
    impressions: String(Number(r.imp) || 0),
    clicks: String(Number(r.clk) || 0),
    actions: [...act('omni_purchase', r.ord), ...act('video_view', r.v3)],
    action_values: act('omni_purchase', r.rev),
    video_thruplay_watched_actions: act('video_thruplay_watched', r.tp),
    video_play_actions: act('video_view', r.vp),
  }));
}

module.exports = {
  META_API_VERSION, META_BASE_URL, BATCH_SIZE, DEFAULT_FILTERING, timing,
  getCredentials, findPurchaseAction, fetchByIds, fetchInsights, metaErrorMessage, sseLoad, LoadStopped,
  twSql, fetchAdRows,
};
