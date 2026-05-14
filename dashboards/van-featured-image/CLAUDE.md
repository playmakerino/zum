# Meta Ads Dashboard

## Overview
Dashboard phân tích quảng cáo Meta (Facebook/Instagram) với AI chat tích hợp Claude API.

## Tech Stack
- **Backend:** Node.js + Express (server.js - ~586 lines)
- **Frontend:** Vanilla HTML/CSS/JS SPA, tách file:
  - `public/index.html` - HTML structure
  - `public/style.css` - CSS styles (~173 lines)
  - `public/app.js` - JavaScript logic (~618 lines)
- **APIs:** Meta Graph API v22.0, Anthropic Claude API
- **Testing:** Jest (server.test.js - 34 tests)
- **Deploy:** Render.com (render.yaml)
- **No build process** - không dùng bundler

## Architecture

### Backend (server.js)
- Express server port 3000, serve static `public/`
- **GET /api/config** - trả về status config (có token chưa)
- **GET /api/dashboard** - SSE stream, pipeline chi tiết bên dưới
- **POST /api/chat** - Claude AI streaming chat, model `claude-sonnet-4-5-20250929`
- **Error handling:** detect Meta token expiry (code 190), rate limit (code 4/17) với message rõ ràng
- **Async file writes:** `saveCacheAsync()` dùng `fs.writeFile` callback, không block event loop
- Exports utility functions cho testing (`require.main === module` guard)

### Frontend (app.js)
- 3 pages: Ad Performance, Creative Performance, AI Chat
- State management bằng plain object
- SSE streaming cho cả dashboard load và chat
- **Tables:** sortable, text/select/metric range filters, search
  - Filter trước → paginate sau (100 rows/page, "Show more" button)
  - Total row tính trên ALL filtered rows (không chỉ page hiện tại)
  - Sticky first column (thumb) với white background
- **Thumbnail preview:** hover hiện ảnh HD 240×240 (position:fixed)
  - Catalog/DPA ads: không có hover preview (is_catalog flag từ server)
- Delta indicators (% thay đổi so với kỳ trước)
- **AI Chat:** markdown rendering (bold, italic, code blocks, lists, headers)
- Token estimation và cost tracking
- Mobile responsive (sidebar collapse ở 768px)
- Global error boundary (window.onerror + unhandledrejection → toast)
- Custom CSS tooltip cho nút Load Data

---

## Dashboard Pipeline (GET /api/dashboard)

Request: `GET /api/dashboard?days=7&refresh=1`
- Params: `days` (1-90, default 7), `refresh` (force reload bỏ qua cache)
- Input validation: token regex `[A-Za-z0-9_-]`, accountId chỉ số, days clamp 1-90
- Response: SSE stream gồm nhiều `progress` events và 1 `result` event cuối cùng

### Step 1: Fetch Insights (2 periods song song)
```
Meta API: POST /act_{id}/insights (async report)
  → Poll GET /{report_id} cho đến Job Completed (max 2 min, poll mỗi 2s)
  → Fetch GET /{report_id}/insights?limit=500 (paginate qua paging.next)
```
- Fetch đồng thời 2 kỳ: current (days ngày gần nhất) + previous (days ngày trước đó)
- Fields: `ad_id, ad_name, impressions, clicks, spend, reach, ctr, cpc, cpm, actions, action_values, frequency, unique_clicks, unique_ctr`
- Kết quả: mảng rows, mỗi row = 1 ad trong 1 kỳ
- Cache trong `insightsCache` (memory + file), chỉ giữ 1 cacheKey (days) tại 1 thời điểm

### Step 2: Fetch Creative Info (chỉ ads mới)
```
Meta API: GET /?ids={batch}&fields=id,creative{id,name,object_type,asset_feed_spec,object_story_spec}
```
- So sánh ad_ids từ insights với `creativeCache` → chỉ fetch missing
- Batch 50 ads/request
- Extract `primary_text` từ creative data (ưu tiên: asset_feed_spec.bodies → object_story_spec.link_data.message → video_data.message → photo_data.message → creative.name)
- Detect catalog/DPA: `is_catalog = !!object_story_spec.template_data`
- **Slim trước khi cache**: `slimCreative()` chỉ giữ `{id, name, object_type, primary_text, is_catalog}`, bỏ toàn bộ object_story_spec/asset_feed_spec để tiết kiệm dung lượng
- Prune: xóa entries không còn trong active ads

### Step 3: Fetch HD Thumbnails (chỉ non-catalog, chỉ missing)
```
Meta API: GET /?ids={batch}&fields=thumbnail_url&thumbnail_width=480&thumbnail_height=480
```
- Chỉ fetch cho creative có `object_type` = SHARE hoặc VIDEO **và** `is_catalog = false`
- Catalog/DPA ads bị skip vì Meta chỉ trả placeholder image
- Batch 50 creatives/request
- Cache: `hdThumbCache[creative_id] = { url, _cachedAt }`
- Prune: xóa entries không còn trong active creatives

### Step 4: Build Response
```
insights rows → attachThumb/attachCreative → groupByAdName/groupByCreative → result
```

**Image URL flow (single source):**
- `hdThumbCache[creative_id].url` → `hdThumbMap[creative_id]` → `creativeMap[ad_id].thumbnail_url` → row.thumbnail_url
- Chỉ có 1 URL duy nhất cho mỗi ad (HD thumbnail 480px), dùng cho cả thumbnail nhỏ và hover preview
- Catalog ads: `thumbnail_url = null` (không fetch HD thumb)

**Grouping:**
- **Ads page**: `groupByAdName()` — gom rows cùng `ad_name`, tính tổng metrics, chọn thumbnail từ ad có spend cao nhất
- **Creatives page**: `groupByCreative()` — gom rows cùng `creative_id`, kèm primary_text, format badge

**Derived metrics (tính server-side trong group functions):**
- `roas` = purchase_value / spend
- `cpr` = spend / purchase_count
- `aov` = purchase_value / purchase_count
- `ctr` = clicks / impressions × 100
- `cpc` = spend / clicks
- `cpm` = spend / impressions × 1000

**Final response:**
```json
{
  "result": {
    "ads":       { "current": [...], "previous": [...] },
    "creatives": { "current": [...], "previous": [...] },
    "period":    { "current": {since, until}, "previous": {since, until} },
    "cached_at": "ISO string"
  }
}
```

---

## Chat Pipeline (POST /api/chat)

Request: `{ messages, context? }` + headers `x-claude-key`
- System prompt tiếng Việt, phân tích ads
- Context optimization: frontend so sánh `cached_at` với `_lastChatCtx`, chỉ gửi data khi thay đổi
- `buildSystemPrompt()`: lọc ads spend > $10, strip `thumbnail_url` và `is_catalog` để tiết kiệm token
- Retry 3 lần với exponential backoff (handle 529 overloaded)
- Response: SSE stream, mỗi chunk = `{ text }`, kết thúc bằng `[DONE]`

---

## Caching (4 layers)

### Layer 1: Insights Cache (Server)
**File:** `.cache-insights.json` · **TTL:** Không expire, overwrite khi refresh · **Key:** `days` (string) · **Var:** `insightsCache`

```json
{ "7": { "current": [row, ...], "previous": [row, ...] } }
```
- Load từ file khi server start
- Có cache + không force refresh → dùng luôn, skip Meta API
- Force refresh → **overwrite toàn bộ** `insightsCache = { [days]: data }` — chỉ giữ 1 days key tại 1 thời điểm
- Không có TTL, không prune — chỉ bị thay khi user bấm Load Data

### Layer 2: Creative Cache (Server)
**File:** `.cache-creatives.json` · **TTL:** 30 ngày · **Key:** `ad_id` · **Var:** `creativeCache`

```json
{
  "ad_123": {
    "id": "ad_123",
    "creative": { "id": "cr_456", "name": "...", "object_type": "SHARE", "primary_text": "...", "is_catalog": false },
    "_cachedAt": 1719849600000
  }
}
```
- Load khi start → filter expired → **auto-migrate** format cũ (có object_story_spec/asset_feed_spec → extract primary_text → slim)
- Dashboard request: so sánh `allAdIds` với cache → chỉ fetch missing
- `slimCreative()` strip bulky spec data, chỉ giữ `{id, name, object_type, primary_text, is_catalog}`
- **Prune mỗi request:** xóa entries có ad_id không trong active ads hiện tại

### Layer 3: HD Thumbnail Cache (Server)
**File:** `.cache-hd-thumbs.json` · **TTL:** 24 giờ · **Key:** `creative_id` · **Var:** `hdThumbCache`

```json
{ "cr_456": { "url": "https://scontent.xx.fbcdn.net/...", "_cachedAt": 1719849600000 } }
```
- Load khi start → filter expired (>24h) + format cũ (string → skip)
- Chỉ fetch cho non-catalog (SHARE/VIDEO + is_catalog=false), batch 50
- TTL 24h vì Meta CDN URLs expire nhanh
- **Prune mỗi request:** xóa entries có creative_id không trong active creatives

### Layer 4: Browser Cache (Frontend)
**Storage:** `localStorage` · **TTL:** Không expire, overwrite khi load mới · **Key:** `meta_cache_{accountId}_{type}_{days}`

```
meta_cache_123_ads_7       → { current: [...], previous: [...], period: {...}, cached_at: "ISO" }
meta_cache_123_creatives_7 → { current: [...], previous: [...], period: {...}, cached_at: "ISO" }
```
- **Page load:** thử đọc localStorage → nếu có → render ngay (instant load) + hiện "Updated at"
- Nếu không có localStorage → tự động gọi `fetchAll(false)` (dùng server cache)
- Fetch thành công → `saveCache()` ghi kết quả vào localStorage
- `cached_at` dùng để hiện timestamp và so sánh khi gửi chat context

### Chat Context Optimization (Frontend)
- `state._lastChatCtx` lưu `cached_at` của lần gửi context cuối
- Mỗi lần chat: nếu `cached_at` không đổi → gửi `context: {}` rỗng, tiết kiệm token
- Nếu data thay đổi → gửi full context, update `_lastChatCtx`

### Tất cả file writes dùng `saveCacheAsync()` — non-blocking, fire-and-forget

---

## Catalog/DPA Detection

**Server-side:** `is_catalog = !!creative.object_story_spec.template_data`
- `template_data` là dấu hiệu của Dynamic Product Ads (catalog)
- Stored trong slim creative cache, truyền xuống frontend qua row data

**Impact:**
- HD thumb: skip fetch cho catalog ads (Meta trả placeholder)
- Frontend: `thumb(url, isCatalog)` — không gắn hover events khi `isCatalog=true`
- Catalog ads hiện thumbnail nhỏ nếu có URL, không có hover preview

---

## Key Metrics
- Standard: impressions, clicks, spend, reach, CTR, CPC, CPM
- Derived: ROAS (purchase_value/spend), CPR (spend/purchases), AOV (value/purchases)

## Environment Variables (trong .env)
- `META_ACCESS_TOKEN` - Meta API token
- `META_AD_ACCOUNT_ID` - Ad account ID
- `ANTHROPIC_API_KEY` - Claude API key
- `PORT` - Server port (default 3000)

## Commands
- `npm start` - chạy production
- `npm run dev` - chạy với nodemon (auto-reload)
- `npm test` - chạy Jest tests (34 tests cho utility functions)

## Conventions
- Ngôn ngữ giao diện và system prompt: Tiếng Việt
- File cache: `.cache-creatives.json`, `.cache-insights.json`, `.cache-hd-thumbs.json` (gitignored)
- Không có TypeScript, ESLint, hay formatter config
