# Van Featured Image Dashboard

## Overview
Dashboard hiển thị top image ads theo spend, lọc từ Meta Ads API. Single page, không có chat hay multi-tab.

## Tech Stack
- **Backend:** Node.js + Express (server.js)
- **Frontend:** Vanilla HTML/CSS/JS, tách file:
  - `public/index.html`: HTML structure
  - `public/style.css`: CSS styles
  - `public/app.js`: JavaScript logic
- **API:** chi tiêu + doanh thu lấy từ **Triple Whale SQL** (`fetchImageAdsOver100` trong server.js, từ 2026-11-03: lọc ad ảnh + chi tiêu trên 100 USD ngay trong SQL, 12 tháng 1 câu, cả lượt tải khoảng 2s); ảnh, link cũng từ Triple Whale (`fetchAdMedia`). Không gọi Meta. Hàm Triple Whale dùng chung ở `meta.js`, bản gốc `dashboards/shared/meta.js`
- **Testing:** Jest (server.test.js)
- **Deploy:** Render.com (render.yaml)
- **No build process**

## Architecture

### Backend (server.js)
- Express server port 3000, serve static `public/`
- **Credentials:** chỉ đọc từ env (`META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `TRIPLE_WHALE_API_KEY`; local nạp từ `D:/keys`); form nhập token cũ đã bỏ, key localStorage `meta_cache___SERVER___ads_alltime` giữ tên cũ để kết quả đã lưu không mất
- **GET /api/config**: `{ hasTripleWhaleKey }`; thiếu key thì nút Load báo lỗi ngay, không gọi server
- **GET /api/dashboard**: SSE stream pipeline
- **Error handling:** lỗi Triple Whale hiện "Triple Whale request failed" + lý do; lỗi Meta: token hết hạn (code 190), rate limit (code 4/17)
- **Một lượt tải:** luôn đọc cả ad đang chạy lẫn tạm dừng (bỏ `mode` từ 2026-11-19); request thứ hai nhập vào lượt đang chạy; không còn trình duyệt nào chờ thì dừng (`sseLoad`). Nút Load Data bị khoá trong lúc tải
- **Render free:** không có persistent disk, cache server (creative + ảnh) chỉ nằm trong RAM, mất khi restart/spin-down (~15 phút idle).
- Exports: `{ todayStr, findPurchaseAction, summarizeAds, extractGroupKey }`

### Frontend (app.js)
- 1 page duy nhất: bảng ads (ảnh, Print ID, Ad name, Link, Spend, ROAS)
- **Giao diện (từ 2026-11-19, như vid-thao / trang-mockup):** kiểu trang báo cáo Shopify, CSS + helper bảng dùng chung ở `dashboards/shared/` (xem git/CLAUDE.md). Top bar: tiêu đề + "Last 12 months · Refreshed ..." trái; nút Load Data + nút Controls phải (giữ 12 tháng cố định, không có ô chọn ngày: user chốt 2026-11-19). Bảng điều khiển Controls (`ReportPanel`): thứ tự Filters (Status is / is one of Active, Paused; Print ID, Ad name chứa chữ; Spend, ROAS), Dimensions (Print ID, Ad name, Link: chỉ hiển thị kèm ⓘ, viết cứng trong index.html như vid-thao, từ 2026-11-20), Metrics (ẩn/hiện Spend, ROAS). Tiêu đề Print ID căn trái (cột dimension sắp xếp được). Không có dòng Summary (user chốt). Bề rộng cột (từ 2026-11-20, luật chung ở git/CLAUDE.md): Print ID 96px, Ad name 280px (đa số tên 63 đến 127px, dài nhất 322px trên 1.004 ad), Link 320px (một nửa số link dưới 280px, 90% dưới 384px), Spend và ROAS 120px.
- **Status thay 2 nút Load Active Ads / Load All:** mở trang là "Status is Active" (như nút chính cũ), bỏ filter = Load All cũ. Server trả **mọi** ad ảnh trên 100 USD kèm `status` + `group`; trang lọc Status trên mọi ad trước rồi mới chọn ad chi tiêu cao nhất mỗi thiết kế (`topPerDesign`), nên "Active" ra ad đang chạy đứng đầu thiết kế y như cách cũ, kể cả khi ad đứng đầu chung là ad tạm dừng. Kết quả lưu trước 2026-11-19 (không có `status`) bị bỏ qua, phải Load Data lại.
- State management bằng plain object
- SSE streaming cho dashboard load
- **Table:** sortable (spend, roas, print_id); lọc ở Controls
  - Filter trước → paginate sau (20 rows/page, `PAGE_SIZE` trong shared.js, "Show more")
- **Image preview:** hover hiện ảnh 240×240 (position:fixed)
- Mobile responsive: breakpoint riêng ở `public/responsive.css`
- Global error boundary (window.onerror + unhandledrejection → toast)
- Load log hiển thị dưới table, persist qua localStorage

---

## Dashboard Pipeline (GET /api/dashboard)

Response: SSE stream gồm nhiều `progress` events và 1 `result` event cuối cùng.

### Step 1: Ad ảnh trên 100 USD từ Triple Whale (`fetchImageAdsOver100`)
```
Triple Whale: 2 câu SQL song song trên ads_table, WHERE ad_type = 'image', HAVING chi tiêu > 100
  1. số liệu: ad_id, ad_name, sum(spend), sum(conversion_value)
  2. trạng thái: argMax(ad_effective_status) IN (ACTIVE, PAUSED), gắn vào từng ad
```
- Trạng thái là câu riêng: để `ad_effective_status` chung SELECT với số liệu thì Triple Whale cộng sai.
- Lookback 12 tháng (`LOOKBACK_MONTHS`), đọc lại đủ mỗi lần bấm. Số ad ảnh trên 100 USD nhỏ (đo 2026-11-03: 1201, còn 883 sau lọc trạng thái) nên không chạm giới hạn 50.000 dòng, không phải chia đoạn.
- **Vì sao lọc trong SQL** (user chốt 2026-11-03): cách cũ đọc mọi ad (29.147, chia 4 đoạn, ~8s), chọn ad đứng đầu mỗi thiết kế rồi mới bỏ ad không phải ảnh, nên thiết kế có ad đứng đầu là video/catalog bị mất dù có ad ảnh trên 100 USD (mất 30/367 thiết kế).
- Ad nào từng đổi loại creative giữa kỳ thì chỉ tính phần thời gian là ad ảnh (hiếm).

### Step 2: summarizeAds()
- Gộp theo `ad_id`, giữ ad trên 100 USD, gắn `group = extractGroupKey(ad_name)` (print-type) và tính `roas = purchase_value / spend`. Chọn ad đứng đầu mỗi thiết kế làm ở trang (`topPerDesign` trong app.js), sau filter Status
- Đo 2026-11-19: 999 ad (80 đang chạy, 919 tạm dừng), 416 thiết kế; lần tải đầu sau khi server khởi động khoảng 9s (đọc ảnh của cả 999 ad), các lần sau ảnh có sẵn trong RAM

### Step 3: Ảnh, link từ Triple Whale (mọi ad, chỉ ad chưa có trong cache)
```
Triple Whale: fetchAdMedia(ad_ids) (ads_table, 500 ad/câu, giá trị mới nhất không rỗng)
```
- Cache: `mediaCache` (RAM, đến restart; link `files.triplewhale.com` không hết hạn)
- `image_url` = ảnh gốc (1600×2000, tên file = mã ảnh Meta), `link` = `destination_url`
- Ad catalog và ad nhiều phiên bản (Advantage+) là loại `dynamic` trong Triple Whale, chỉ có ảnh 500px, nên không vào dashboard này

### Step 4: Build Response
```json
{
  "result": {
    "ads": [{ "ad_name", "print_id", "group", "status", "spend", "purchase_value", "roas", "image_url", "link" }],
    "totalRows", "designCount",
    "period": { "since", "until" },
    "cached_at": "ISO string"
  }
}
```

---

## Caching (1 server layer + 1 frontend)

| Layer | File | TTL | Key | Var |
|-------|------|-----|-----|-----|
| Creative + ảnh + link | RAM | Đến restart | `ad_id` | `mediaCache` |
| Browser | `localStorage` | No expire, overwrite | `meta_cache_{accountId}_ads_alltime` | (không) |

## Environment Variables (Render; local nạp từ D:/keys)
- `META_ACCESS_TOKEN`: Meta API token
- `META_AD_ACCOUNT_ID`: Ad account ID
- `TRIPLE_WHALE_API_KEY`: Triple Whale API key (số liệu + ảnh)
- `PORT`: Server port (default 3000)

## Commands
- `npm start`: production
- `npm run dev`: nodemon auto-reload
- `npm test`: Jest tests
