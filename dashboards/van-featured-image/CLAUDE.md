# Van Featured Image Dashboard

## Overview
Dashboard hiển thị top image ads theo spend, lọc từ Meta Ads API. Single page, không có chat hay multi-tab.

## Tech Stack
- **Backend:** Node.js + Express (server.js ~389 lines)
- **Frontend:** Vanilla HTML/CSS/JS, tách file:
  - `public/index.html` — HTML structure (~67 lines)
  - `public/style.css` — CSS styles (~127 lines)
  - `public/app.js` — JavaScript logic (~374 lines)
- **API:** Meta Graph API v22.0
- **Testing:** Jest (server.test.js)
- **Deploy:** Render.com (render.yaml)
- **No build process**

## Architecture

### Backend (server.js)
- Express server port 3000, serve static `public/`
- **GET /api/config** — trả về status config (có token chưa)
- **GET /api/dashboard** — SSE stream pipeline
- **Error handling:** detect token expiry (code 190), rate limit (code 4/17)
- **Async file writes:** `saveCacheAsync()` dùng atomic write (tmp → rename)
- Exports: `{ todayStr, addDays, findPurchaseAction, pickTopSpendAds }`

### Frontend (app.js)
- 1 page duy nhất: bảng ads (Image, Print ID, Ad Name, Spend, ROAS)
- State management bằng plain object
- SSE streaming cho dashboard load
- **Table:** sortable (spend, roas, print_id), text filter (ad_name), metric range filters (spend, roas)
  - Filter trước → paginate sau (100 rows/page, "Show more")
- **Image preview:** hover hiện ảnh 240×240 (position:fixed)
- Mobile responsive (768px breakpoint)
- Global error boundary (window.onerror + unhandledrejection → toast)
- Load log hiển thị dưới table, persist qua localStorage

---

## Dashboard Pipeline (GET /api/dashboard)

Response: SSE stream gồm nhiều `progress` events và 1 `result` event cuối cùng.

### Step 1: Fetch Insights (incremental)
```
Meta API: POST /act_{id}/insights (async report)
  → Poll GET /{report_id} (max 2 min, poll mỗi 2s)
  → Fetch GET /{report_id}/insights?limit=500 (paginate)
```
- Fields: `ad_id, ad_name, spend, action_values`
- All-time data (36 tháng), incremental fetch từ `lastUntil`
- Cache: `insightsCache` (memory + file)

### Step 1.5: pickTopSpendAds()
- Aggregate rows theo `ad_id` → tính tổng spend + purchase_value
- **Filter:** `spend <= 100` → bỏ ads có tổng spend <= $100
- Gom theo `ad_name` → chỉ giữ ad có spend cao nhất per name
- Tính `roas = purchase_value / spend`

### Step 2: Fetch Creative Info (chỉ missing)
```
Meta API: GET /?ids={batch}&fields=id,creative{id,object_type,object_story_spec,asset_feed_spec}
```
- Batch 50 ads/request, chỉ fetch ads chưa có link trong cache
- Cache: `creativeCache[ad_id] = { creative_id, object_type, is_catalog, link, image_hash, _cachedAt }`
- `link`: fallback `oss.link_data.link` → `afs.link_urls[0].website_url`
- `image_hash`: fallback `oss.link_data.image_hash` → `afs.images[0].hash`
- Advantage+ Creative ads dùng `asset_feed_spec` thay vì `object_story_spec.link_data`

### Step 2.5: Filter Image Ads
- **Filter:** `object_type === 'SHARE'` AND `!is_catalog`
- Chỉ giữ image ads, loại video và catalog/DPA

### Step 3: Fetch Full-res Images via adimages (chỉ missing)
```
Meta API: GET /act_{id}/adimages?hashes=[...]&fields=hash,url
```
- Dùng `image_hash` từ creativeCache để lấy ảnh gốc full-res
- Batch 50 hashes/request
- Cache: `imageCache[creative_id] = { url, _cachedAt }`

### Step 4: Build Response
```json
{
  "result": {
    "ads": [{ "ad_name", "print_id", "spend", "purchase_value", "roas", "image_url", "link" }],
    "period": { "since", "until" },
    "cached_at": "ISO string"
  }
}
```

---

## Caching (3 server layers + 1 frontend)

| Layer | File | TTL | Key | Var |
|-------|------|-----|-----|-----|
| Insights | `.cache-insights.json` | No expire, incremental | — | `insightsCache` |
| Creative | `.cache-creatives.json` | 30 ngày | `ad_id` | `creativeCache` |
| Image | `.cache-images.json` | 24 giờ | `creative_id` | `imageCache` |
| Browser | `localStorage` | No expire, overwrite | `meta_cache_{accountId}_ads_alltime` | — |

## Environment Variables (.env)
- `META_ACCESS_TOKEN` — Meta API token
- `META_AD_ACCOUNT_ID` — Ad account ID
- `PORT` — Server port (default 3000)

## Commands
- `npm start` — production
- `npm run dev` — nodemon auto-reload
- `npm test` — Jest tests
