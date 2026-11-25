// Product created month from Shopify (Triple Whale does not have it).
// Env: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (app with read_products), token by client credentials.
// Local Windows runs without those env vars read %USERPROFILE%\.shopify (secret is DPAPI encrypted).
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SHOP = '422aa5-ca.myshopify.com';
const API = '2026-07';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

let token = null; // { value, until }
const monthCache = new Map(); // product id → 'YYYY-MM', '' = not on Shopify any more

function credentials() {
  const { SHOPIFY_CLIENT_ID: id, SHOPIFY_CLIENT_SECRET: secret } = process.env;
  if (id && secret) return { id, secret };
  const dir = path.join(process.env.USERPROFILE || '', '.shopify');
  const idFile = path.join(dir, 'zumbamboo.client_id.txt'), encFile = path.join(dir, 'zumbamboo.client_secret.enc');
  if (process.platform !== 'win32' || !fs.existsSync(idFile) || !fs.existsSync(encFile))
    throw new Error('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET');
  const env = { ...process.env, SHOPIFY_ENC_FILE: encFile };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k]; // PowerShell 7 paths break ConvertTo-SecureString in 5.1
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::Out.Write([System.Net.NetworkCredential]::new('', (Get-Content $env:SHOPIFY_ENC_FILE | ConvertTo-SecureString)).Password)"],
    { env, encoding: 'utf8' });
  return { id: fs.readFileSync(idFile, 'utf8').trim(), secret: out.trim() };
}

// axios errors carry the request (with the secret): only the status goes on
const fail = err => new Error(err.response ? `Shopify HTTP ${err.response.status}` : err.message);

async function getToken() {
  if (token && Date.now() < token.until) return token.value;
  const c = credentials();
  try {
    const { data } = await axios.post(`https://${SHOP}/admin/oauth/access_token`,
      new URLSearchParams({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret }), { timeout: 30000 });
    token = { value: data.access_token, until: Date.now() + (data.expires_in - 300) * 1000 };
    return token.value;
  } catch (err) { throw fail(err); }
}

const NODES = 'query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { legacyResourceId createdAt } } }';

async function loadMonths(ids) {
  const missing = [...new Set(ids)].filter(id => !monthCache.has(id));
  if (!missing.length) return;
  const value = await getToken();
  const lots = [];
  for (let i = 0; i < missing.length; i += 250) lots.push(missing.slice(i, i + 250));
  const run = async () => {
    for (let lot; (lot = lots.shift());) {
      let data;
      try {
        ({ data } = await axios.post(`https://${SHOP}/admin/api/${API}/graphql.json`,
          { query: NODES, variables: { ids: lot.map(id => `gid://shopify/Product/${id}`) } },
          { headers: { 'X-Shopify-Access-Token': value }, timeout: 30000 }));
      } catch (err) { throw fail(err); }
      if (data.errors || !data.data) throw new Error('Shopify: ' + (data.errors?.[0]?.message || 'no data'));
      for (const id of lot) monthCache.set(id, '');
      for (const n of data.data.nodes) if (n?.createdAt) monthCache.set(String(n.legacyResourceId), dayFmt.format(new Date(n.createdAt)).slice(0, 7));
    }
  };
  await Promise.all([run(), run(), run(), run()]);
}

// Meta orders in Triple Whale: one row per order (Triple Attribution, lifetime = the shop's default model)
const productQuery = (start, end) => `SELECT p.product_id AS pid,
  sum(p.product_name_price * p.product_name_quantity_sold - p.discount_amount_for_product) AS rv
FROM pixel_orders_table ARRAY JOIN products_info AS p
WHERE event_date BETWEEN '${start}' AND '${end}' AND channel = 'facebook-ads'
  AND model = 'Triple Attribution' AND attribution_window = 'lifetime'
GROUP BY pid LIMIT 50000`;

// → { 'YYYY-MM': revenue, '': revenue of products no longer on Shopify }
async function revenueByCreatedMonth(twSql, start, end) {
  const rows = await twSql(productQuery(start, end), start, end);
  await loadMonths(rows.map(r => String(r.pid ?? '')).filter(id => /^\d+$/.test(id)));
  const months = {};
  for (const r of rows) {
    const m = monthCache.get(String(r.pid ?? '')) || '';
    months[m] = (months[m] || 0) + (Number(r.rv) || 0);
  }
  return months;
}

module.exports = { revenueByCreatedMonth };
