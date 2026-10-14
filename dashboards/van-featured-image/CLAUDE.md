# Van Featured Image Dashboard

## Overview
Dashboard hiển thị top image ads theo spend, lọc từ Meta Ads API. Single page, không có chat hay multi-tab.

## Tech Stack
- **Backend:** Node.js + Express (server.js)
- **Frontend:** Vanilla HTML/CSS/JS, tách file:
  - `public/index.html` — HTML structure
  - `public/style.css` — CSS styles
  - `public/app.js` — JavaScript logic
- **API:** Meta Marketing API v26.0 (version + phần gọi Meta dùng chung ở `meta.js`, bản gốc `dashboards/shared/meta.js`)
- **Testing:** Jest (server.test.js)
- **Deploy:** Render.com (render.yaml)
- **No build process**

## Architecture

### Backend (server.js)
- Express server port 3000, serve static `public/`
- **Credentials:** chỉ đọc từ env (`META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`); form nhập token cũ đã bỏ, key localStorage `meta_cache___SERVER___ads_alltime` giữ tên cũ để kết quả đã lưu không mất
- **GET /api/config** — trả về status config (có token chưa)
- **GET /api/dashboard** — SSE stream pipeline
- **Error handling:** detect token expiry (code 190), rate limit (code 4/17); báo cáo async lỗi tự chạy lại sau 5s, 15s, 30s rồi gọi thử đồng bộ để lấy lý do thật (`fetchInsights` trong meta.js)
- **Một lượt tải mỗi mode:** request thứ hai cùng mode nhập vào lượt đang chạy; không còn trình duyệt nào chờ thì dừng (`sseLoad`). 2 nút Load bị khoá trong lúc tải
- **Render free:** không có persistent disk → mọi cache server chỉ nằm trong RAM, mất khi restart/spin-down (~15 phút idle). Sau restart, "Load All" chạy lại full 12 tháng.
- Exports: `{ todayStr, addDays, findPurchaseAction, pickTopSpendAds, extractGroupKey }`

### Frontend (app.js)
- 1 page duy nhất: bảng ads (Image, Print ID, Ad Name, Link, Spend, ROAS)
- **Giao diện:** kiểu Shopify Analytics, CSS + dropdown + helper bảng (sort/lọc/popup lọc/toast/SSE) dùng chung ở `dashboards/shared/` (xem git/CLAUDE.md). Trang cuộn; top bar: tiêu đề + Updated trái, 2 nút Load Active Ads / Load All phải. Bảng trong card: hàng đầu = tiêu đề "Active ads"/"All ads" theo dữ liệu đang hiện, hàng cuối = load log (trước khi có thì hiện câu nhắc).
- State management bằng plain object
- SSE streaming cho dashboard load
- **Table:** sortable (spend, roas, print_id), text filter (ad_name), metric range filters (spend, roas)
  - Filter trước → paginate sau (100 rows/page, "Show more")
- **Image preview:** hover hiện ảnh 240×240 (position:fixed)
- Mobile responsive: breakpoint riêng ở `public/responsive.css`
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
- Lookback 12 tháng (`LOOKBACK_MONTHS` trong server.js), incremental fetch từ `lastUntil`
- Cache: `insightsCache` (RAM)

### Step 1.5: pickTopSpendAds()
- Aggregate rows theo `ad_id` → tính tổng spend + purchase_value
- **Filter:** `spend <= 100` → bỏ ads có tổng spend <= $100
- Gom theo `extractGroupKey(ad_name)` (print-type) → chỉ giữ ad có spend cao nhất mỗi nhóm
- Tính `roas = purchase_value / spend`

### Step 2: Fetch Creative Info (chỉ missing)
```
Meta API: GET /?ids={batch}&fields=id,creative{id,object_type,object_story_spec,asset_feed_spec}
```
- Batch 50 ads/request, chỉ fetch ad chưa có trong cache, hoặc ad ảnh (SHARE, không catalog) còn thiếu image_hash. Fields chỉ lấy `object_story_spec{link_data{link,image_hash},template_data}` + `asset_feed_spec{images,link_urls}` (bằng 1/4 payload so với lấy cả spec, kết quả như nhau, đo 2026-10-14)
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
- `hashToCreativeIds`: map hash → **array** of creative_ids (nhiều ads có thể dùng chung 1 image hash)
- Khi adimages trả URL, gán cho **tất cả** creative_ids cùng hash đó
- Batch 50 hashes/request
- **Fallback (Step 3b):** Nếu adimages không trả URL cho 1 số hashes → fetch `thumbnail_url` từ creative endpoint: `GET /?ids={creative_ids}&fields=id,thumbnail_url`
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
| Insights | RAM | Đến restart, incremental | — | `insightsCache` |
| Creative | RAM | Đến restart | `ad_id` | `creativeCache` |
| Image | RAM | 24 giờ | `creative_id` | `imageCache` |
| Browser | `localStorage` | No expire, overwrite | `meta_cache_{accountId}_ads_alltime` | — |

## Environment Variables (.env)
- `META_ACCESS_TOKEN` — Meta API token
- `META_AD_ACCOUNT_ID` — Ad account ID
- `PORT` — Server port (default 3000)

## Commands
- `npm start` — production
- `npm run dev` — nodemon auto-reload
- `npm test` — Jest tests
