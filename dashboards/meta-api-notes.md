# Meta Marketing API — Notes

API version: `v22.0`
Base URL: `https://graph.facebook.com/v22.0`

---

## 1. Insights Endpoint

```
POST act_{accountId}/insights
```

### Request params

| Param | Type | Mô tả |
|-------|------|--------|
| `level` | string | `ad` — group theo từng ad |
| `fields` | string | Danh sách fields cần trả về (comma-separated) |
| `time_range` | JSON string | `{"since":"2026-04-28","until":"2026-05-28"}` |
| `filtering` | JSON string | Array các filter objects (xem mục 2) |
| `sort` | string | `{field}_{ascending\|descending}`, vd: `spend_descending` |
| `date_preset` | string | Thay cho time_range: `last_30d`, `last_7d`, `this_month`, `maximum`... |
| `limit` | number | Số rows per page (default 100, max 500 khi paginate) |
| `time_increment` | string/number | `1` = daily, `monthly`, `all_days` (default) |
| `breakdowns` | string | `age`, `gender`, `country`, `publisher_platform`... |
| `action_attribution_windows` | JSON | Cửa sổ attribution cho actions |

### Async report flow

```
POST /insights → sync response (nhỏ) hoặc report_run_id (lớn)
    │
    ├─ Nếu có data trực tiếp → return luôn
    │
    └─ Nếu có report_run_id:
         GET /{reportId}?access_token=... (poll mỗi 2s)
              │
              ├─ async_status: "Job Running", async_percent_completion: 45
              ├─ async_status: "Job Completed" → fetch results
              ├─ async_status: "Job Failed" → retry hoặc throw
              └─ async_status: "Job Skipped" → retry hoặc throw
         │
         GET /{reportId}/insights?limit=500 (paginate)
              └─ paging.next → tiếp tục fetch
```

### Fields đang dùng

| Dashboard | Fields |
|-----------|--------|
| trang-mockup | `ad_id, ad_name, impressions, clicks, spend, actions, action_values` |
| van-featured-image | `ad_id, ad_name, spend, action_values` (chỉ cần spend + purchase) |
| vid-thao | `ad_id, ad_name, impressions, clicks, spend, actions, action_values, video_thruplay_watched_actions, video_avg_time_watched_actions, video_play_actions` |

### Metrics tính từ fields

| Metric | Công thức |
|--------|-----------|
| CTR | clicks / impressions * 100 |
| CPC | spend / clicks |
| CPM | spend / impressions * 1000 |
| Purchase Count | `actions` where action_type = `purchase` \| `omni_purchase` |
| Purchase Value | `action_values` where action_type = `purchase` \| `omni_purchase` |
| ROAS | purchase_value / spend |
| CPR | spend / purchase_count |
| AOV | purchase_value / purchase_count |
| 3-sec views | `actions` where action_type = `video_view` |
| Thruplays | `video_thruplay_watched_actions` (tổng value) |
| Avg watch time | weighted: Σ(avg_time × plays) / Σ(plays) |

---

## 2. Filtering (API-level)

### Syntax

```json
filtering=[
  {"field": "ad.effective_status", "operator": "IN", "value": ["ACTIVE", "PAUSED"]},
  {"field": "spend", "operator": "GREATER_THAN", "value": 0}
]
```

Nhiều objects = AND logic. Truyền dưới dạng `JSON.stringify(array)`.

### Operators

| Operator | Loại field | Ví dụ |
|----------|-----------|-------|
| `EQUAL` | string/number | `spend` = 100 |
| `NOT_EQUAL` | string/number | status != DELETED |
| `GREATER_THAN` | number | spend > 0 |
| `GREATER_THAN_OR_EQUAL` | number | impressions >= 1000 |
| `LESS_THAN` | number | cpc < 5 |
| `LESS_THAN_OR_EQUAL` | number | spend <= 500 |
| `IN_RANGE` | number | spend trong khoảng [a, b] |
| `NOT_IN_RANGE` | number | spend ngoài khoảng |
| `CONTAIN` | string | ad.name chứa "[" |
| `NOT_CONTAIN` | string | ad.name không chứa "test" |
| `IN` | array | status IN ["ACTIVE", "PAUSED"] |
| `NOT_IN` | array | status NOT IN ["DELETED"] |
| `STARTS_WITH` | string | campaign.name bắt đầu bằng "TC_" |
| `ANY` / `ALL` / `NONE` | labels | ad.adlabels match |
| `AFTER` / `BEFORE` | date | date range |

### Filterable fields

| Field | Ý nghĩa |
|-------|---------|
| `ad.name` | Tên ad |
| `ad.effective_status` | ACTIVE, PAUSED, DELETED, ARCHIVED, CAMPAIGN_PAUSED, ADSET_PAUSED, DISAPPROVED, WITH_ISSUES, IN_PROCESS |
| `ad.impressions` | Số impressions |
| `ad.adlabels` | Labels gắn trên ad |
| `adset.name` | Tên ad set |
| `campaign.name` | Tên campaign |
| `campaign.effective_status` | Status campaign |
| `spend` | Tổng spend |
| `impressions` | Tổng impressions |

**Lưu ý:** Dùng `campaign.name` chứ KHÔNG phải `campaign_name` (sẽ báo lỗi).

### Đang dùng ở mỗi dashboard

| Dashboard | API-level filtering | Server-side filtering |
|-----------|--------------------|-----------------------|
| trang-mockup | `ad.effective_status IN [ACTIVE, PAUSED]`, `spend > 0`, `sort=spend_descending` | qualified = valid format `[PrintID-TypeID_MockupID]` OR spend > $100 |
| van-featured-image | `ad.effective_status IN [ACTIVE]` (chỉ ở mode=active) | spend > $100 per ad_name, chỉ giữ top-spend ad per name, chỉ SHARE type (image) |
| vid-thao | Không có | spend > $1 |

---

## 3. Creative Info

```
GET /?ids={ad_id1},{ad_id2},...&fields=id,creative{...}&access_token=...
```

Batch 50 ads/request. Fields tùy dashboard:

| Dashboard | Creative fields |
|-----------|----------------|
| trang-mockup | `id,creative{id,name,object_type,object_story_spec}` |
| van-featured-image | `id,creative{id,object_type,object_story_spec,asset_feed_spec}` — cần thêm link + image_hash |
| vid-thao | `id,creative{id,name,object_type,object_story_spec{template_data}}` |

### object_type values

| object_type | Ý nghĩa | Format hiển thị |
|-------------|---------|-----------------|
| `SHARE` | Image ad (link post) | Image |
| `VIDEO` | Video ad | Video |
| `PHOTO` | Carousel/Photo ad | Carousel |

### Catalog/DPA detection

```js
is_catalog = !!creative.object_story_spec?.template_data
```

Nếu có `template_data` → dynamic product ad (catalog), thumbnail sẽ không có ý nghĩa.

---

## 4. Thumbnails & Images

Ba cách lấy hình ảnh, tùy dashboard:

### a) HD Thumbnail (trang-mockup, vid-thao)

```
GET /?ids={creative_id1},{creative_id2},...
    &fields=thumbnail_url
    &thumbnail_width=480&thumbnail_height=480
    &access_token=...
```

- Batch 50/request
- Cache 24h (Meta CDN URLs expire nhanh)
- Chỉ fetch cho non-catalog creatives

### b) Full-res Image via adimages (van-featured-image)

```
GET /act_{accountId}/adimages
    ?hashes=["hash1","hash2",...]
    &fields=hash,url
    &access_token=...
```

- Lấy `image_hash` từ `creative.object_story_spec.link_data.image_hash`
- Fallback: `creative.asset_feed_spec.images[0].hash`
- Trả về URL ảnh gốc full-res
- Nếu hash không tìm thấy → fallback sang thumbnail_url (1080x1080)

### c) Thumbnail fallback (van-featured-image)

```
GET /?ids={creative_id},...
    &fields=id,thumbnail_url
    &thumbnail_width=1080&thumbnail_height=1080
    &access_token=...
```

Dùng khi adimages không trả về kết quả.

---

## 5. Caching Strategy

### Server-side file cache

| Cache | File | TTL | Nội dung |
|-------|------|-----|----------|
| Insights | `.cache-insights.json` | Theo logic dashboard | Raw rows từ insights API |
| Creatives | `.cache-creatives.json` | 30 ngày | Creative info (id, name, type, is_catalog) |
| HD Thumbnails | `.cache-hd-thumbs.json` | 24 giờ | Thumbnail URLs (Meta CDN expire nhanh) |
| Images | `.cache-images.json` | 24 giờ | Full-res image URLs (van-featured-image) |

### Client-side localStorage cache

| Dashboard | Key | Nội dung |
|-----------|-----|----------|
| trang-mockup | `trang_mockup_mockups`, `trang_mockup_creatives` | Processed data cho render ngay khi mở trang |
| vid-thao | `vidthao_creatives_{days}d` | Grouped creative data |

### Insights cache strategy khác nhau

| Dashboard | Strategy |
|-----------|----------|
| trang-mockup | Cache theo số ngày (key = "30"), invalidate khi refresh |
| van-featured-image | **Incremental**: lưu `lastUntil`, chỉ fetch ngày mới, append vào cache |
| vid-thao | Cache theo days param (key = "7", "30"...), invalidate khi refresh |

---

## 6. Error Handling

### Meta API error codes

| Code | Subcode | Ý nghĩa | Xử lý |
|------|---------|---------|--------|
| 190 | 463 | Token expired | Yêu cầu generate token mới |
| 190 | 467 | Token revoked | User đổi password hoặc revoke access |
| 4 | — | Rate limit (app-level) | Đợi vài phút |
| 17 | — | Rate limit (account-level) | Đợi vài phút |

### Async report failures

- `Job Failed` → trang-mockup retry tối đa 3 lần (delay tăng dần)
- `Job Skipped` → xử lý giống Job Failed
- vid-thao lưu thêm `error_code`, `error_subcode`, `error_user_msg` từ poll response
- Timeout: 60 polls × 2s = 120s max

### HTML error page

Meta đôi khi trả về HTML thay vì JSON (server quá tải). trang-mockup detect bằng:
```js
if (typeof respData === 'string' && respData.includes('<!DOCTYPE html'))
```

---

## 7. Rate Limit Header

```
x-fb-ads-insights-throttle
```

vid-thao track header này qua các poll request. Có thể dùng để throttle requests trước khi bị rate limit.

---

## 8. Có thể cải thiện

- [ ] vid-thao: thêm API-level filtering (`spend > 0`, `ad.effective_status`)
- [ ] van-featured-image: thêm `spend > 0` filter ở API level (hiện chỉ filter server-side)
- [ ] Tất cả: dùng `date_preset=last_30d` thay vì tính time_range thủ công (đơn giản hơn)
- [ ] Xem xét `ad.effective_status NOT_IN ['DELETED']` thay vì `IN ['ACTIVE','PAUSED']` để không miss ads vừa bị pause ở campaign/adset level (CAMPAIGN_PAUSED, ADSET_PAUSED) mà vẫn có spend
