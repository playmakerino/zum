# Meta Ads Dashboard

## Overview
Dashboard phân tích quảng cáo video Meta (Facebook/Instagram). Chỉ hiển thị format Video.

## Tech Stack
- **Backend:** Node.js + Express (server.js)
- **Frontend:** Vanilla HTML/CSS/JS SPA, tách file:
  - `public/index.html` - HTML structure
  - `public/style.css` - CSS styles
  - `public/app.js` - JavaScript logic
- **APIs:** số liệu ad (chi tiêu, đơn, doanh thu, lượt xem video) lấy từ **Triple Whale SQL** (`fetchAdRows`, từ 2026-11-02); creative, mã reel, thumbnail cũng từ Triple Whale (`fetchAdMedia`, từ 2026-11-03). Một lượt Load Data khoảng 4s. Meta Marketing API v26.0 chỉ còn dùng cho nút "Fetch from Meta". Cả hai nằm ở `meta.js`, bản gốc `dashboards/shared/meta.js`
- **Testing:** Jest (server.test.js)
- **Deploy:** Render.com (render.yaml)
- **No build process** - không dùng bundler

## Architecture

### Backend (server.js)
- Express server port 3000, serve static `public/`
- **Credentials:** Render: env var. Local: dòng đầu `server.js` nạp `D:/keys/.env.meta-token`, `.env.meta-ad-account`, `.env.port`, `.env.triplewhale` (không còn `.env` trong folder, từ 2026-10-28).
- **Bảng video BigQuery:** mỗi lần load server query thẳng BigQuery (`@google-cloud/bigquery`, service account `n8n-bigquery@zum-media-log`; Render: env `BQ_SA_KEY` = nội dung JSON key; local: mặc định đọc `D:/keys/.env.bigquery-sa.json`, đổi được bằng `BQ_SA_KEY_FILE`), không qua n8n; `ad.info` FULL JOIN `media.video_submitter` theo `video_id` (từ 2026-10-15): `ad_id, ad_name, video_id (= ID upload, video trong thư viện ad), reel_id (bản copy của creative), submitted_by (email trước @), drive_file_id, created_at, from_form`. `ad.info` do Cloud Run `meta-ad-media` (`google cloud/meta-ad-media/`, 03:00 hằng ngày) ghi cho **mọi** ad; `media.video_submitter` (TC Vid `aBFwAG7hzokMiwge`, 1 dòng/video upload: video_id, submitter_email, drive_file_id, created_at; bảng 7 cột cũ ở `media.ad_videos_backup_20261015`). Dòng dashboard = 1 **ID upload** (2 creative cùng file = 1 dòng); phát reel bằng `reel_id` của ad (`facebook.com/reel/<reel_id>`). Creative đọc từ Meta có `video_id` (= video_data, ID upload) + `reel_id` (= creative.video_id) nên ad tạo trong ngày (chưa có trong ad.info) vẫn ghép được người gửi và có reel. `indexVideoTable` → `byAd` (ad dùng video form) / `byVideo` (ID upload → dòng form) / `adVideo` + `adReel` (mọi ad). Ad form chưa có delivery mà chưa vào ad.info thì chưa hiện tới lượt 03:00. Người gửi chỉ lấy từ đây, **không** đọc tên campaign.
- **Dòng nào hiện:** ad từ form (có trong `byAd`) có delivery trong kỳ (spend > 0, mọi mức); **ad chưa chạy không hiện** (user chốt 2026-10-15: ad PAUSED chưa có impression thì post chưa công khai, reel báo "Video Unavailable"; đã bỏ `newAdRows`); video ad khác: spend > 1 và có video play như trước. Ad từ form lấy video_id/Drive/reel/người gửi theo `byAd` (BigQuery thắng video_id trong creative); ad khác tra `byVideo` theo video của creative.
- **Load Data (`refresh=1`)** đọc lại creative của mọi ad trong kỳ (`ensureCreativeInfo` force): sửa thumbnail trong Ads Manager = creative mới, cache cũ sẽ che mất.
- **GET /api/config** - trả về `{hasMetaToken, hasAdAccountId}` để frontend biết backend đã configured chưa
- **GET /api/dashboard** - SSE stream; số liệu ad từ Triple Whale (1 câu SQL gộp theo ad, dòng mang hình dạng giống insights của Meta), creative + thumbnail từ Meta
  - Params: `days` (default 7), `refresh` (force reload)
  - Pipeline: số liệu Triple Whale + bảng video BigQuery (chạy song song) → chọn dòng (xem "Dòng nào hiện"; ad có trạng thái hiện tại ACTIVE/PAUSED và spend > 0, như bộ lọc Meta cũ) → fetch creative info (per ad_id) → fetch HD thumbnails (per creative_id, video-only) → `groupByVideo`: mỗi dòng = 1 video (BigQuery hoặc `object_story_spec.video_data.video_id`, creative không có video_id thì theo creative id) + người gửi, cộng dồn metrics của mọi ad/creative dùng video đó, kèm `drive_file_id`, `drive_thumb_id`, `reel_url`
  - Triple Whale khớp Meta theo từng ad (đo 2026-11-02, 4 ad video): spend, impressions, clicks, đơn, doanh thu, 3s, ThruPlay, lượt phát. Triple Whale trễ vài giờ và không có ad chưa phân phối. **Không có thời gian xem trung bình** nên cột Avg Time đã bỏ (user chốt 2026-11-02). 
  - **Creative từ Triple Whale** (`fetchAdMedia` → `creativeFromMedia`): `creative_id`, ảnh thu nhỏ 500×500, mp4 và mã reel (tên file video của Triple Whale = `ad.info.reel_id`, KHÔNG phải mã upload). Mã upload chỉ lấy từ BigQuery `ad.info`, nên ad tạo trong ngày chưa ghép được người gửi tới lượt 03:00. Ad là video khi Triple Whale xếp `video` HOẶC `ad.info` có mã upload (ad video nhiều phiên bản bị xếp `dynamic`; đo 2026-11-03: 11 ad động có lượt phát). Ad catalog/ảnh/carousel có vài lượt phát vẫn ra Image và bị ẩn như trước.
  - SSE events: `progress` (text per stage), `debug` (telemetry), `result` (final), `error`
  - Trả về 1 mảng `creatives.current` (đã bỏ compare giữa 2 kỳ)
- **Error handling:** lỗi Triple Whale hiện "Triple Whale request failed" + lý do; lỗi Meta (creative/thumbnail): token hết hạn (code 190), rate limit (code 4/17) với message rõ ràng
- **Một lượt tải mỗi kỳ:** request thứ hai cùng `days` + `refresh` (tab khác, bấm 2 lần) nhập vào lượt đang chạy thay vì gọi Meta lại; không còn trình duyệt nào chờ thì lượt tải dừng ở lần gọi Meta kế tiếp (`sseLoad`). Nút Load Data bị khoá trong lúc tải
- Exports utility functions cho testing (`require.main === module` guard)

### Caching
Deploy trên **Render free** (không có persistent disk, restart/spin-down là mất file) → cache server chỉ nằm trong **RAM**, sống theo process.
| Layer | Nơi | TTL | Mục đích |
|---|---|---|---|
| Insights | RAM (key theo `days`) | Đến khi force refresh / restart | Dòng số liệu từ Triple Whale |
| Creatives | RAM | Đến Load Data / restart | id, object_type, is_catalog, reel_id (Triple Whale) |
| Thumbs Triple Whale | RAM | Đến restart (link không hết hạn) | URL ảnh 500×500 |
| HD Thumbs | RAM | 24 giờ | Ảnh 480px từ nút "Fetch from Meta" (thắng ảnh Triple Whale) |
| Browser | localStorage | Đến khi force refresh | Full result để load ngay |

### Frontend (app.js)
- 1 page: Creative Performance (chỉ format Video, lọc client-side qua `isVideo`)
- State management bằng plain object
- SSE streaming cho dashboard load
- **Giao diện:** kiểu Shopify Analytics, CSS + dropdown + helper bảng (sort/lọc/popup lọc/toast/SSE) dùng chung ở `dashboards/shared/` (xem git/CLAUDE.md). Trang cuộn (không cuộn riêng bảng); top bar: tiêu đề + Updated bên trái, ô ngày + Load Data bên phải. Bảng trong card: hàng đầu = filter người gửi (từ BigQuery, xem mục Người gửi), hàng cuối = debug line.
- **Tables:** sortable, text/metric range filters, search
  - Filter trước → paginate sau (100 rows/page, "Show more" button)
  - Total row nằm trong `<thead>` ngay dưới tên cột (dính cùng header), tính trên ALL filtered rows
- **Thumbnail** (user chốt 2026-10-15): ảnh vuông 24×24 (crop `cover`) trong ô 36×36, cách 4 phía 6px (kiểu Shopify Files, header cột không có chữ), ảnh hover giữ tỷ lệ gốc của ảnh (cao 240, không crop). Thứ tự nguồn: **poster reel** → thumb Triple Whale (hoặc Meta nếu vừa bấm Fetch from Meta) → thumb Drive; ảnh lỗi thì thử nguồn kế (`data-fallback` cách nhau bằng dấu cách).
  - Poster reel = `GET /api/reel-thumb/:reelId`: server tải trang plugin `facebook.com/plugins/video.php?href=<reel>` (không token, không tốn call Meta), lấy `<img>` fbcdn `t15.5256-10` đầu tiên (`reelPosterFromPluginHtml`; ảnh `t39.30808-1` là avatar page), cache RAM 24h, 302 sang ảnh; không thấy → 404.
- **Thumbnail preview:** hover hiện ảnh HD (position:fixed)
  - Ảnh 500×500 của Triple Whale (`files.triplewhale.com`, không hết hạn); trong trình xem ghi "(Triple Whale)"
  - Link Meta hết hạn sau vài ngày (kết quả lưu localStorage): `onerror` đổi sang thumb Drive `drive.google.com/thumbnail?id=<drive_thumb_id>&sz=w480` (vĩnh viễn, không tốn call); không có Drive thì hiện ô xám
  - Catalog/DPA ads: không có hover preview (Meta không cung cấp ảnh lớn)
- **Bấm vào bất kỳ đâu trên dòng (có video) = trình xem video kiểu Shopify Content → Files** (`openVideo(i)`, i = vị trí trong `state.rendered`; đo bằng getComputedStyle trên admin 2026-10-14, số đo ghi trong comment `style.css`): thanh trên 56px (Exit / tên / Download), video `<video>` gốc giữa nền chấm, thẻ Information 320px (Name, Details "MP4 • size" + Added, Submitted by, Thumbnail = thumb Meta thật + nút "Fetch from Meta" (`GET /api/ad-thumb?ad_id=<thumb_ad_id>` = ad spend cao nhất có thumb của dòng, đọc creative hiện tại rồi thumbnail_url, 2 call Meta), Used in "1 ad" / "2 ads"). Hover dòng = `#f7f7f7` bo 12px. Esc hoặc nút Exit để đóng.
  - **Dòng có `reel_url` (từ BigQuery) phát reel** trong iframe plugin Facebook `facebook.com/plugins/video.php?href=<reel_url>&show_text=false&width=W&height=H` (từ 2026-10-15, user chốt; không cần đăng nhập Facebook, không tốn call Meta). Plugin vẽ đúng cỡ trong URL nên `openVideo` tính khung 9:16 vừa vùng giữa rồi mới gán `src`; đóng viewer thì gỡ `src`. Details chỉ ghi ngày tạo; Drive chỉ là backup: mục **Backup** (cuối thẻ, chữ xám, hover trắng) "Google Drive • dung lượng" (HEAD qua proxy) link mở `drive.google.com/file/d/<id>/view` (user chốt 2026-10-15). Download vẫn là file Drive.
  - Không có reel thì video Drive phát qua **proxy của server** `GET|HEAD /api/drive-video/:id` (chuyển Range để tua): trình duyệt gọi thẳng `drive.usercontent.google.com` bị từ chối (đo 2026-10-14), server thì được. Không tốn call Meta; HEAD cho dung lượng. Không có Drive → `…/webhook/mp4?id=<video_id>` (n8n WsyDx1JIhZj5mVrf, 1 execution + 1 call Meta).
  - Thumb Drive dùng `drive.google.com/thumbnail?id=…&sz=w480`; `lh3.googleusercontent.com` trả 429 khi trang gửi Referer. Trang có `<meta name="referrer" content="no-referrer">`.
- Mobile responsive: breakpoint riêng ở `public/responsive.css`
- Global error boundary (window.onerror + unhandledrejection → toast)
- Tooltip kiểu Shopify (`data-tip-title` + `data-tip`, vẽ bởi shared.js) cho Load Data, ô người gửi, header 3s/Impr, ThruPlay%; chữ trên giao diện không dùng em dash
- **Mở trang không tự tải** (user chốt 2026-10-14, tránh tự gọi Meta): có kết quả lưu localStorage của kỳ đang chọn thì hiện, không có thì bảng trống + câu nhắc, chỉ nút Load Data mới gọi `/api/dashboard`.
- **Debug line:** hàng cuối card (trước khi có thì hiện câu nhắc Load Data), hiển thị telemetry pipeline (insights cache hit / API, ads cached/fetched, format breakdown, thumbnail Triple Whale / Meta). Persisted localStorage để survive F5.

## Key Metrics
- Raw (fetched): impressions, clicks, spend
- Derived (server-computed): CTR, CPC, CPM, ROAS (purchase_value/spend), CPR (spend/purchases), AOV (value/purchases)
- Video: 3s/Impr (3-sec plays / impressions), ThruPlay% (ThruPlays / video plays)

## Environment Variables (Render; local nạp từ D:/keys)
- `META_ACCESS_TOKEN` - Meta API token
- `META_AD_ACCOUNT_ID` - Ad account ID
- `TRIPLE_WHALE_API_KEY` - Triple Whale API key (số liệu ad)
- `PORT` - Server port (default 3000)

## Commands
- `npm start` - chạy production
- `npm run dev` - chạy với nodemon (auto-reload)
- `npm test` - chạy Jest tests cho utility functions

## Conventions
- Ngôn ngữ giao diện: Tiếng Việt (debug line là English vì là dev telemetry)
- Không có TypeScript, ESLint, hay formatter config
