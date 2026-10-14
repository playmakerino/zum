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
- **Credentials:** chỉ đọc từ `.env` (`META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`).
- **Người gửi (Submitted by):** mỗi lần load đọc bảng n8n `Vid · submitters` (`dhVo58edLqGd3iO1`, cột video_id, submitted_by) qua webhook `GET /webhook/vid-submitters` (workflow `ZoSYMQV5RQYGx8jO`, header `x-auth-key` = env `VID_SUBMITTERS_KEY`, credential n8n `hnAp9ZuwqmAdUXOG`). Không có trong bảng thì lấy email trong tên campaign. Bảng được workflow TC Vid (`aBFwAG7hzokMiwge`, node `Save video submitter` sau Upload videos) ghi mỗi video mới; 755 video cũ đã backfill 2026-10-14 (không có email trong tên camp → thaodp).
- **GET /api/config** - trả về `{hasMetaToken, hasAdAccountId}` để frontend biết backend đã configured chưa
- **GET /api/dashboard** - SSE stream, fetch data từ Meta API (async report → poll → paginate)
  - Params: `days` (default 7), `refresh` (force reload)
  - Pipeline: fetch insights → filter spend>1 ở server (lọc ở API thử 2026-10-14: không nhanh hơn) → filter có video play (`hasVideoPlays`, bỏ ad ảnh trước khi gọi creative) → fetch creative info (per ad_id) → fetch HD thumbnails (per creative_id, video-only) → `groupByVideo`: mỗi dòng = 1 video_id (`object_story_spec.video_data.video_id`, creative không có video_id thì theo creative id) + người gửi, cộng dồn metrics của mọi ad/creative dùng video đó
  - Meta không lọc được `video_play_actions` ở tầng insights API (thử 2026-10-14: lỗi), nên lọc ở server. Thumbnail lồng trong `creative{thumbnail_url}` chỉ ra 64px dù truyền `thumbnail_width`, nên HD thumb vẫn phải gọi riêng theo creative_id.
  - SSE events: `progress` (text per stage), `debug` (telemetry), `result` (final), `error`
  - Trả về 1 mảng `creatives.current` (đã bỏ compare giữa 2 kỳ)
- **Error handling:** detect Meta token expiry (code 190), rate limit (code 4/17) với message rõ ràng
- Exports utility functions cho testing (`require.main === module` guard)

### Caching
Deploy trên **Render free** (không có persistent disk, restart/spin-down là mất file) → cache server chỉ nằm trong **RAM**, sống theo process.
| Layer | Nơi | TTL | Mục đích |
|---|---|---|---|
| Insights | RAM (key theo `days`) | Đến khi force refresh / restart | Insights rows |
| Creatives | RAM | Đến restart (creative null retry sau 1h) | id, object_type, is_catalog |
| HD Thumbs | RAM | 24 giờ | URL thumbnail 480px (Meta CDN URL hết hạn) |
| Browser | localStorage | Đến khi force refresh | Full result để load ngay |

### Frontend (app.js)
- 1 page: Creative Performance (chỉ format Video, lọc client-side qua `isVideo`)
- State management bằng plain object
- SSE streaming cho dashboard load
- **Giao diện:** kiểu Shopify Analytics, CSS + dropdown dùng chung ở `dashboards/shared/` (xem git/CLAUDE.md). Trang cuộn (không cuộn riêng bảng); top bar: tiêu đề + Updated bên trái, ô ngày + Load Data bên phải. Bảng trong card: hàng đầu = filter người gửi (lấy từ tên campaign `TC | Vid | folder | email | yyMMdd`), hàng cuối = debug line.
- **Tables:** sortable, text/metric range filters, search
  - Filter trước → paginate sau (100 rows/page, "Show more" button)
  - Total row nằm trong `<thead>` ngay dưới tên cột (dính cùng header), tính trên ALL filtered rows
- **Thumbnail preview:** hover hiện ảnh HD 240×240 (position:fixed)
  - HD thumbnails fetched riêng bằng creative ID với `thumbnail_width=480`
  - Catalog/DPA ads: không có hover preview (Meta không cung cấp ảnh lớn)
- Mobile responsive: breakpoint riêng ở `public/responsive.css`
- Global error boundary (window.onerror + unhandledrejection → toast)
- Tooltip kiểu Shopify (`data-tip-title` + `data-tip`, vẽ bởi shared.js) cho Load Data, ô người gửi, header 3s/Impr, ThruPlay%, Avg Time; chữ trên giao diện không dùng em dash
- **Debug line:** hàng cuối card (trước khi có thì hiện câu nhắc Load Data), hiển thị telemetry pipeline (insights cache hit / API, ads cached/fetched, format breakdown, HD thumb cached/fetched/failed). Persisted localStorage để survive F5.

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
- Không có TypeScript, ESLint, hay formatter config
