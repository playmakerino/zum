// Local runs read keys from D:\keys (one file per key); on Render they are env vars and these files do not exist.
require('dotenv').config({ path: ['triplewhale', 'meta-token'].map(k => 'D:/keys/.env.' + k) });
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const { getCredentials, fetchByIds } = require('./meta');

// Meta Ads trends from Triple Whale (ads_table, hourly rows, one SQL call grouped by day).
// Catalog ads: Triple Whale has no catalog flag, so the creatives Triple Whale types as
// 'dynamic' or 'link' are looked up on Meta once (product_set_id set = catalog ad) and cached.
// Ads typed 'image' / 'video' were never catalog ads in the samples checked (2026-10-28).
const TW_URL  = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const SHOP_ID = process.env.TW_SHOP_ID || '422aa5-ca.myshopify.com';
const SHOP_TZ = 'America/New_York'; // Triple Whale event_date is in the shop's time zone
const CACHE_MS = 10 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const rangeCache = {};       // "start|end" → { at, body }
const catalogCache = new Map(); // creative_id → true / false

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayInShop = () => new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TZ }).format(new Date());

function twQuery(start, end) {
  return `SELECT toString(event_date) AS d,
  startsWith(campaign_name, 'TC | ') AS tc,
  if(ad_type IN ('dynamic','link'), ifNull(creative_id, ''), '') AS ck,
  sum(spend) AS spend, sum(impressions) AS imp, sum(clicks) AS clk,
  sum(conversion_value) AS rev, sum(conversions) AS ord
FROM ads_table
WHERE channel = 'facebook-ads' AND event_date BETWEEN '${start}' AND '${end}'
GROUP BY d, tc, ck`;
}

async function fetchTw(start, end) {
  const key = process.env.TRIPLE_WHALE_API_KEY;
  if (!key) throw Object.assign(new Error('Missing TRIPLE_WHALE_API_KEY'), { status: 500 });
  const res = await axios.post(TW_URL, { shopId: SHOP_ID, query: twQuery(start, end), period: { startDate: start, endDate: end } },
    { headers: { 'x-api-key': key }, timeout: 120000 });
  const d = res.data;
  return Array.isArray(d) ? d : (d?.data || d?.rows || []);
}

// creative ids not in the cache → Meta (50 per batch request). Ids Meta does not return stay
// uncached and count as "rest"; their number goes back as catalogUnknown.
async function resolveCatalog(ids) {
  const missing = ids.filter(id => id && !catalogCache.has(id));
  if (!missing.length) return 0;
  const { token } = getCredentials();
  if (!token) return missing.length;
  const got = await fetchByIds(token, missing, 'product_set_id');
  for (const c of got) catalogCache.set(String(c.id), !!c.product_set_id);
  return missing.filter(id => !catalogCache.has(id)).length;
}

const zero = () => ({ spend: 0, imp: 0, clk: 0, rev: 0, ord: 0 });
function add(t, r) { for (const k of ['spend', 'imp', 'clk', 'rev', 'ord']) t[k] += Number(r[k]) || 0; }

// rows → one entry per day (every day of the range, empty days = 0) with 5 groups
function buildDays(rows, start, end) {
  const days = {};
  for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    days[k] = { date: k, all: zero(), tc: zero(), nontc: zero(), cat: zero(), rest: zero() };
  }
  for (const r of rows) {
    const day = days[r.d];
    if (!day) continue;
    const tc = r.tc === true || r.tc === 1 || r.tc === '1' || r.tc === 'true';
    add(day.all, r);
    add(tc ? day.tc : day.nontc, r);
    add(r.ck && catalogCache.get(String(r.ck)) ? day.cat : day.rest, r);
  }
  return Object.values(days);
}

app.get('/api/data', async (req, res) => {
  const { start, end } = req.query;
  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '') || start > end)
    return res.status(400).json({ error: 'Bad date range' });
  const key = `${start}|${end}`;
  const hit = rangeCache[key];
  // a range that ends before today does not change any more; today's data is cached 10 minutes
  const fresh = hit && (end < todayInShop() || Date.now() - hit.at < CACHE_MS);
  if (fresh && req.query.refresh !== '1') return res.json(hit.body);
  try {
    const rows = await fetchTw(start, end);
    const catalogUnknown = await resolveCatalog([...new Set(rows.map(r => String(r.ck || '')).filter(Boolean))]);
    const body = { start, end, days: buildDays(rows, start, end), catalogUnknown, updatedAt: new Date().toISOString() };
    rangeCache[key] = { at: Date.now(), body };
    res.json(body);
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(err.status || 502).json({ error: 'Triple Whale request failed', detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

app.get('/api/today', (req, res) => res.json({ today: todayInShop() }));

if (require.main === module) {
  const PORT = process.env.PORT || 3003;
  app.listen(PORT, () => console.log(`Ads trends running on http://localhost:${PORT}`));
}

module.exports = { app, buildDays, twQuery, catalogCache };
