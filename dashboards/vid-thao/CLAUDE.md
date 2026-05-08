# Meta Ads Dashboard

## Overview
Dashboard phân tích quảng cáo video Meta (Facebook/Instagram). Chỉ hiển thị format Video.

## Tech Stack
- **Backend:** Node.js + Express (server.js)
- **Frontend:** Vanilla HTML/CSS/JS SPA, tách file:
  - `public/index.html` - HTML structure
  - `public/style.css` - CSS styles
  - `public/app.js` - JavaScript logic
- **APIs:** Meta Graph API v22.0
- **Testing:** Jest (server.test.js)
- **Deploy:** Render.com (render.yaml)
- **No build process** - không dùng bundler

## Architecture

### Backend (server.js)
- Express server port 3000, serve static `public/`
- **Credentials:** chỉ đọc từ `.env` (`META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`). Validate regex token + accountId số.
- **GET /api/config** - trả về `{hasMetaToken, hasAdAccountId}` để frontend biết backend đã configured chưa
- **GET /api/dashboard** - SSE stream, fetch data từ Meta API (async report → poll → paginate)
  - Params: `days` (1-90, default 7), `refresh` (force reload)
  - Pipeline: fetch insights → filter spend>1 → fetch creative info (per ad_id) → fetch HD thumbnails (per creative_id, video-only) → `groupByCreative` lookup creativeCache trực tiếp + aggregate metrics
  - SSE events: `progress` (text per stage), `debug` (telemetry), `result` (final), `error`
  - Trả về 1 mảng `creatives.current` (đã bỏ compare giữa 2 kỳ)
- **Error handling:** detect Meta token expiry (code 190), rate limit (code 4/17) với message rõ ràng
- **Async file writes:** `saveCacheAsync()` dùng `fs.writeFile` callback, không block event loop
- Exports utility functions cho testing (`require.main === module` guard)

### Caching (4 layers)
| Layer | File | TTL | Mục đích |
|---|---|---|---|
| Insights | `.cache-insights.json` | Until force refresh | Insights data (keyed by `days`) |
| Creatives | `.cache-creatives.json` | 30 ngày | Creative info slim (id, name, object_type, is_catalog) |
| HD Thumbs | `.cache-hd-thumbs.json` | 24 giờ | HD thumbnail URLs (480px, fetched by creative ID; Meta CDN URLs expire quickly) |
| Browser | localStorage | Until force refresh | Full result cho instant load |

### Frontend (app.js)
- 1 page: Creative Performance (chỉ format Video, lọc client-side qua `isVideo`)
- State management bằng plain object
- SSE streaming cho dashboard load
- **Tables:** sortable, text/metric range filters, search
  - Filter trước → paginate sau (100 rows/page, "Show more" button)
  - Total row tính trên ALL filtered rows (không chỉ page hiện tại)
  - Sticky first column (thumb) với white background
- **Thumbnail preview:** hover hiện ảnh HD 240×240 (position:fixed)
  - HD thumbnails fetched riêng bằng creative ID với `thumbnail_width=480`
  - Catalog/DPA ads: không có hover preview (Meta không cung cấp ảnh lớn)
- Mobile responsive (sidebar collapse ở 768px)
- Global error boundary (window.onerror + unhandledrejection → toast)
- Custom CSS tooltip cho nút Load Data
- **Debug line:** dưới table, hiển thị telemetry pipeline (insights cache hit / API, ads cached/fetched, format breakdown, HD thumb cached/fetched/failed). Persisted localStorage để survive F5.

## Key Metrics
- Raw (fetched): impressions, clicks, spend
- Derived (server-computed): CTR, CPC, CPM, ROAS (purchase_value/spend), CPR (spend/purchases), AOV (value/purchases)
- Video: 3s/Impr (3-sec plays / impressions), ThruPlay% (ThruPlays / video plays), Avg Time (weighted avg play time)

## Environment Variables (trong .env)
- `META_ACCESS_TOKEN` - Meta API token
- `META_AD_ACCOUNT_ID` - Ad account ID
- `PORT` - Server port (default 3000)

## Commands
- `npm start` - chạy production
- `npm run dev` - chạy với nodemon (auto-reload)
- `npm test` - chạy Jest tests cho utility functions

## Conventions
- Ngôn ngữ giao diện: Tiếng Việt (debug line là English vì là dev telemetry)
- File cache: `.cache-creatives.json`, `.cache-insights.json`, `.cache-hd-thumbs.json` (gitignored)
- Không có TypeScript, ESLint, hay formatter config
