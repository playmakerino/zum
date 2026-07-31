# Zum — Pattern → products

Một pattern swatch upload lên form → tạo product nháp trên **zumbamboo** kèm ảnh flatlay + lifestyle do Gemini sinh.

## Thành phần

| Thứ | Ở đâu |
|---|---|
| Workflow | n8n `kZvHwfNZ6Gz1L5E4` — "Zum — Pattern → products (web form)", active |
| Webhook | `POST https://playmakerino.app.n8n.cloud/webhook/zum-prd-form` — **không auth** |
| Form | [`../forms/zum_prd_form.html`](../forms/zum_prd_form.html) |
| Sinh lại list niche/sub niche | [`../forms/gen-zum-form-data.ps1`](../forms/gen-zum-form-data.ps1) |
| Data table | `NP3546vWJsdplUya` "Product types (romper pajama)" — prompt, mockup, product type, design |
| Ảnh mockup gốc | Shopify Files của zumbamboo, `zum-mockup-*.jpg` |
| Credential Shopify | `cYEq8BpBlGNpI0Rq` "Shopify Access Token account" (= zumbamboo, có `write_products`) |
| Credential Gemini | `oViXXkn0dtiUO6Kj` |
| Telegram | chat `5417464732`, credential `bdUnCoL3dCvLEB2Y` |
| Báo lỗi | `settings.errorWorkflow` → `gPBHsBraqFiI6rTZ` "Error notifier" |

## Chuỗi node

```
Webhook → Respond OK → Parse input → Resize pattern → Prep pattern
→ Get product types → Download mockup → Change trim color
→ Flatlay → [Flatlay to binary → Downscale to BMP → Check flatlay bg → Flatlay bg clean?]
→ Lifestyle → Build product input → Create product → Check product
→ Upload lifestyle → Upload flatlay → Collect products → Send report
```

Data table trả 2 row → **2 item chạy song song** qua từng node, không có loop. Vì vậy mọi tham chiếu chéo phải dùng `$('Node').item` (theo pairedItem), **không** dùng `.first()` — `.first()` luôn trả item đầu, trộn dữ liệu 2 product type. Ngoại lệ: `$('Prep pattern').first()` hợp lệ vì node đó thật sự chỉ có 1 item.

Nhánh trong ngoặc là bộ kiểm nền flatlay: đo stdev 4 đường biên trên bản BMP thu nhỏ, ngưỡng 5, retry tối đa 1 lần bằng `$runIndex`.

## Ghi lên Shopify — chỗ dễ sai nhất

`productCreate` (GraphQL `2025-10`), không dùng node Shopify REST.

| Metafield | Type | Value phải là |
|---|---|---|
| `custom.design` | `metaobject_reference` | GID trần, lấy từ cột `design_gid` |
| `custom.niche` | `list.single_line_text_field` | **chuỗi JSON** `["Animals"]`, không phải `"Animals"` |
| `custom.sub_niche` | `list.metaobject_reference` | chuỗi JSON mảng GID; metaobject phải có sẵn |

Vì sub_niche là reference nên **form không cho gõ tự do** — list 315 mục được bake sẵn vào HTML kèm GID. Thêm sub niche mới trên store thì chạy lại `gen-zum-form-data.ps1`.

Quy ước khác của store:
- Title = `{pattern name} {title_suffix}`, với `title_suffix` đã chứa chữ "Bamboo" → `Neil The Seal Bamboo Convertible Zippy`
- `productType` là **số ít** (`Convertible Zippy`), khác `title_suffix` (số nhiều trong tên metaobject design)
- `vendor: Zumbamboo`, `status: DRAFT`

`productCreate` **trả HTTP 200 cả khi thất bại** — lỗi nằm ở `data.productCreate.userErrors`. Node `Check product` throw dựa trên đó; bỏ node này là ảnh sẽ upload vào `/products/undefined/images.json`.

Ảnh vẫn upload bằng **REST** `POST /products/{id}/images.json` với base64 attachment. GraphQL `productCreateMedia` chỉ nhận URL nên không dùng được cho ảnh sinh tại chỗ. Cần `legacyResourceId` (id số), không phải GID.

## Ngân sách execution — 1 mỗi lần submit

Ràng buộc user đặt ra, và là lý do thiết kế trông như vậy:

- Trang HTML **không có URL để nhận request vào**, nên n8n không push status về được. Mọi lần đọc trạng thái là thêm 1 execution.
- Vì thế: không probe POST, không polling, không nút refresh. Kết quả đi qua **Telegram**, gửi từ trong chính execution đó nên không tốn thêm.
- Danh sách "Sent" dưới form chỉ là localStorage của browser, không hỏi server.
- Chỉ khi workflow lỗi mới phát sinh execution thứ 2 (Error notifier).

Muốn có tiến độ theo từng bước mà vẫn 1 execution thì phải qua dịch vụ realtime trung gian (Ably/Pusher): n8n POST sang đó ngay trong execution, browser giữ WebSocket tới đó. Đã cân nhắc, chưa làm.

## Đã xoá — đừng đi tìm

- Workflow `Zum — Task status (web form)` (`R2w1g8XTjtILehrp`)
- Data table `Zum product tasks` (`VVHqBXQ6Yx5ze0KH`)
- Node `Create task row`, `Finish task`, 5 node `Step: …`, `Loop types` / `Loop back`

## Bảo mật

Webhook công khai — ai biết URL đều gọi được, tạo product nháp và đốt quota Gemini. Đây là lựa chọn có ý thức của user (bỏ Header Auth ngày 2026-07-31). Muốn khoá lại: bật `authentication: headerAuth` + credential `TBIa0bvq5y8yQfnj` "TC form auth" ở node Webhook, và trả `auth.js` + `TC_AUTH_HEADERS()` vào form như các form TC khác.

## Memory

Memory tự động lưu **theo cwd**. Chỉ khi mở Claude Code với chính thư mục này làm cwd thì mới có memory riêng; mở từ `D:\Bamboo\claude` thì memory rơi vào kho chung của workspace. Luật ổn định thì viết thẳng vào file này — CLAUDE.md kế thừa xuống mọi subfolder nên luôn được nạp.
