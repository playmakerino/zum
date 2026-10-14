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
- **Bảng video BigQuery:** mỗi lần load gọi webhook `GET /webhook/vid-submitters` (workflow `ZoSYMQV5RQYGx8jO` "Vid dashboard · videos API", header `x-auth-key` = env `VID_SUBMITTERS_KEY`, credential n8n `hnAp9ZuwqmAdUXOG`), trả 1 dòng / video upload: `video_id, submitted_by (email trước @), ad_id, ad_name, drive_file_id, thumb_drive_id, reel_url, created_at`. Nguồn: `zum-media-log.media.ad_videos` (TC Vid `aBFwAG7hzokMiwge` ghi 1 dòng/ad; backfill 30 ngày, email trống → thaodp) + `media.video_submitters_legacy` (video cũ, chỉ có người gửi). `indexVideoTable` → `byAd` / `byVideo`. Người gửi chỉ lấy từ đây, **không** đọc tên campaign.
- **Dòng nào hiện:** ad từ form (có trong `byAd`) có delivery trong kỳ (spend > 0, mọi mức) + ad từ form tạo trong kỳ chưa có delivery (`newAdRows`, chỉ số 0); video ad khác: spend > 1 và có video play như trước. Ad từ form lấy video_id/Drive/reel/người gửi theo `byAd` (BigQuery thắng video_id trong creative); ad khác tra `byVideo` theo video của creative.
- **Load Data (`refresh=1`)** đọc lại creative của mọi ad trong kỳ (`ensureCreativeInfo` force): sửa thumbnail trong Ads Manager = creative mới, cache cũ sẽ che mất.
- **GET /api/config** - trả về `{hasMetaToken, hasAdAccountId}` để frontend biết backend đã configured chưa
- **GET /api/dashboard** - SSE stream, fetch data từ Meta API (async report → poll → paginate)
  - Params: `days` (default 7), `refresh` (force reload)
  - Pipeline: fetch insights → bảng video BigQuery → chọn dòng (xem "Dòng nào hiện"; lọc spend/video play ở server, lọc ở API thử 2026-10-14: không nhanh hơn) → fetch creative info (per ad_id) → fetch HD thumbnails (per creative_id, video-only) → `groupByVideo`: mỗi dòng = 1 video (BigQuery hoặc `object_story_spec.video_data.video_id`, creative không có video_id thì theo creative id) + người gửi, cộng dồn metrics của mọi ad/creative dùng video đó, kèm `drive_file_id`, `drive_thumb_id`, `reel_url`
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
- **Giao diện:** kiểu Shopify Analytics, CSS + dropdown dùng chung ở `dashboards/shared/` (xem git/CLAUDE.md). Trang cuộn (không cuộn riêng bảng); top bar: tiêu đề + Updated bên trái, ô ngày + Load Data bên phải. Bảng trong card: hàng đầu = filter người gửi (từ BigQuery, xem mục Người gửi), hàng cuối = debug line.
- **Tables:** sortable, text/metric range filters, search
  - Filter trước → paginate sau (100 rows/page, "Show more" button)
  - Total row nằm trong `<thead>` ngay dưới tên cột (dính cùng header), tính trên ALL filtered rows
- **Thumbnail preview:** hover hiện ảnh HD 240×240 (position:fixed)
  - HD thumbnails fetched riêng bằng creative ID với `thumbnail_width=480` (thumb hiện tại của ad trên Meta)
  - Link Meta hết hạn sau vài ngày (kết quả lưu localStorage): `onerror` đổi sang thumb Drive `drive.google.com/thumbnail?id=<drive_thumb_id>&sz=w480` (vĩnh viễn, không tốn call); không có Drive thì hiện ô xám
  - Catalog/DPA ads: không có hover preview (Meta không cung cấp ảnh lớn)
- **Bấm vào bất kỳ đâu trên dòng (có video) = trình xem video kiểu Shopify Content → Files** (`openVideo(i)`, i = vị trí trong `state.rendered`; đo bằng getComputedStyle trên admin 2026-10-14, số đo ghi trong comment `style.css`): thanh trên 56px (Exit / tên / Download), video `<video>` gốc giữa nền chấm, thẻ Information 320px (Name, Details "MP4 • size" + Added, Submitted by, Thumbnail = thumb Meta thật + nút "Fetch from Meta" (`GET /api/ad-thumb?ad_ids=`, đọc creative hiện tại rồi thumbnail_url, 2 call Meta), Used in "1 ad" / "2 ads"). Hover dòng = `#f7f7f7` bo 12px. Esc hoặc nút Exit để đóng.
  - Video Drive phát qua **proxy của server** `GET|HEAD /api/drive-video/:id` (chuyển Range để tua): trình duyệt gọi thẳng `drive.usercontent.google.com` bị từ chối (đo 2026-10-14), server thì được. Không tốn call Meta; HEAD cho dung lượng. Không có Drive → `…/webhook/mp4?id=<video_id>` (n8n WsyDx1JIhZj5mVrf, 1 execution + 1 call Meta).
  - Thumb Drive dùng `drive.google.com/thumbnail?id=…&sz=w480`; `lh3.googleusercontent.com` trả 429 khi trang gửi Referer. Trang có `<meta name="referrer" content="no-referrer">`.
- Mobile responsive: breakpoint riêng ở `public/responsive.css`
- Global error boundary (window.onerror + unhandledrejection → toast)
- Tooltip kiểu Shopify (`data-tip-title` + `data-tip`, vẽ bởi shared.js) cho Load Data, ô người gửi, header 3s/Impr, ThruPlay%, Avg Time; chữ trên giao diện không dùng em dash
- **Mở trang không tự tải** (user chốt 2026-10-14, tránh tự gọi Meta): có kết quả lưu localStorage của kỳ đang chọn thì hiện, không có thì bảng trống + câu nhắc, chỉ nút Load Data mới gọi `/api/dashboard`.
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
