# git/ — n8n workflows, forms, dashboards

## Dùng MCP n8n nào

Luật chọn server (bảng phân công, UUID connector, bẫy draft/published) đã chuyển lên **CLAUDE.md ở workspace root** — nó kế thừa xuống đây nên luôn có sẵn. Đừng chép lại vào file này, tránh 2 bản lệch nhau.

## Workflow có tài liệu riêng

| Thư mục | Việc |
|---|---|
| [`compositor/zum-prd/`](compositor/zum-prd/CLAUDE.md) | Pattern swatch → product nháp zumbamboo (workflow `kZvHwfNZ6Gz1L5E4`). **Folder local-only, gitignore, KHÔNG push** (đã chuyển vào đây 2026-09-14, chỉ source ~90MB, bỏ ảnh sinh); form của nó vẫn ở [`compositor/zum_prd_form.html`](compositor/zum_prd_form.html) |

## Form TC: code dùng chung (từ 2026-10-12)
13 form (`forms/tc_form_*`, `tc_img_form_*`, `tc_vid_form`) load chung 3 file. Sửa phần chung ở đây, **không chép lại vào từng form**:
- [`forms/forms.css`](forms/forms.css): biến màu `:root`, nền trang, `.card`, `.status`, trạng thái `.submit-btn`, thanh chuyển form, panel hướng dẫn. Link trước `<style>` của form, nên rule riêng của form vẫn đè được.
- [`forms/forms.js`](forms/forms.js): đặt **đầu `.container`**. `data-switcher="tc"` (9 form TC) / `"img"` (Kid pajama, Others) vẽ thanh chuyển form tại chỗ; thêm form vào thanh = sửa `SWITCHERS`. Còn có `openGuide/closeGuide`, `escapeHtml`, `cleanProductUrl`, `showStatus`, `extractFolderId`.
- [`forms/product-type-combo.js`](forms/product-type-combo.js): dropdown Product type + mảng `PRODUCT_TYPES` của form 1_trang, 2, 7, 8 (form gọi `initProductTypeCombo()`).

## Form TC: luật layout (user chốt 2026-10-12, phải giữ đồng thời cả 4)
1. **Form 9, 10:** mép phải ô Print image thẳng mép phải ô Product URL.
2. **Trong một form:** các ô up ảnh (Print image, Ad images…) rộng bằng nhau.
3. **Trong một form có Image positions (form 2, 3, 6):** ô Image positions (ô chung + cột trong bảng) rộng bằng ô Print ID.
4. **Mọi form:** ô Print ID rộng bằng nhau.

Số hiện tại (desktop, nội dung card 704px = 760 − 2×28): Print ID = Image positions = **130px**. Form 9, 10: Print image = Ad images = **254px**, vì 704 − 254 − 36 (nút xoá) − 2×10 (gap) = 394 = 130 + 10 + 254. Form 1, 4: hai ô ảnh chia đôi (347/347).
- Đổi Print ID thành P thì phải đổi theo: ô ảnh form 9, 10 = (638 − P) / 2; Image positions form 2, 3, 6 = P; khung căn mép phải `.pos-field` form 2, 6 = P + 10 + 36.
- Sửa xong phải đo lại bằng `getBoundingClientRect` trên trang thật (desktop 1280px), không tính nhẩm. Các số trên chỉ khớp tuyệt đối khi card đạt bề rộng tối đa (cửa sổ ≥ ~792px).
- Không cùng nhóm luật nhưng cũng là chuẩn chung: chữ trong ô nhập 14px desktop / 16px ở ≤640px (iPhone tự zoom vào ô dưới 16px), placeholder màu `--text-muted`.

## Compositor flatlay: 2 file, 1 engine
[`compositor/pattern-mockup.html`](compositor/pattern-mockup.html) (dev tool) và [`compositor/zum_prd_form.html`](compositor/zum_prd_form.html) (form production) chứa **cùng một khối engine byte-identical** giữa 2 dòng marker `// ===== SHARED BLOCK` … `// ===== END SHARED BLOCK =====`. Cả 2 vẫn là one-page HTML (khối được nhân đôi, không load script chung).
- Sửa engine (compose, analyzeGarment, hằng số, colour helpers) **chỉ trong `pattern-mockup.html`** → `.\compositor\sync-shared.ps1 -Push` → commit **cả 2 file**.
- `.\compositor\sync-shared.ps1` (không flag) diff 2 bản, exit 1 nếu lệch — chạy trước khi commit bất kỳ file nào trong 2 file này.
- **`GARMENTS`/`?v` KHÔNG còn trong shared block** (từ 2026-09-10): nằm ở khối page-local `// ===== GARMENT DATA =====` ngay trên SHARED BLOCK, KHÁC nhau giữa 2 file. Garment mang `flats:[...]` (1+ flatlay) + `models:[...]`. **Mỗi view mang `r`** = bề rộng pattern / bề rộng mock (từ 2026-09-10, thay cho `gw`/`bodyW`/`cal`/`K_BASE` cũ); chỉnh cỡ motif của một ảnh = sửa đúng số `r` của nó. Trong một garment, `r` giữ **số ô motif ngang ngực bằng nhau** giữa các view: tỷ lệ theo bề rộng thân áo (panel id 1) đo trên map. **Thêm mock+map mới → `python compositor/motif-r.py --ref <map một view đã có r> --ref-r <r của nó> <map mới...>`** in ra `r` từng view, không cần chỉnh mắt; garment hoàn toàn mới thì chỉnh mắt `r` flatlay đầu tiên rồi dùng nó làm `--ref`. Xem thử bằng `node compositor/regress-engine.js render <page> <outdir> [key] [overrides.json]`. Dev tool `pattern-mockup.html` có 4 garment: romper, pajama (**2 flatlay**), men pajama, women pajama; form `zum_prd_form.html` giữ 2 garment và vẫn dùng `flat:` số ít (1 flatlay). Thêm garment/flatlay vào dev tool: sửa GARMENT DATA của `pattern-mockup.html` (+ `<option>` dropdown nếu type mới), **KHÔNG -Push** (form thiếu ô grid → crash). Bump `?v` cũng sửa ở GARMENT DATA từng file.
- Code riêng từng trang (UI, webhook, NICHES) nằm ngoài khối; khối không được đụng DOM/state trang.
- [`compositor/pattern-mockup-v2.html`](compositor/pattern-mockup-v2.html) là **trang testing**: engine = SHARED BLOCK (sync-shared.ps1 -Push đẩy sang cả v2), render y hệt production (`{center:true}`, chấm xanh lơ có thì chạy, Body + rest theo `bodyOpt`, 1 ảnh/view). GARMENTS để **trống** từ 2026-10-08, thêm view cần thử vào; view nhận `br` riêng (body ratio, `V(mock,map,r,name,bc,br)`), không có `br` thì dùng br đo trên `bodyRef` của garment. **br = bề rộng thân / bề rộng ô pattern** (br lớn = in thân to; trước 2026-10-08 tên là k/K và đảo chiều: pattern / thân), bề rộng in thân = Body size × br × r × W.
- [`compositor/print-area-tuner.html`](compositor/print-area-tuner.html): xem/chỉnh r, bc, br từng view (lưới All-over + Body + rest, flatlay đầu tiên bên trái), đọc GARMENTS + engine trực tiếp từ `pattern-mockup.html` nên phải mở qua http; KHÔNG ghi file, kết quả ra qua nút Copy (`mockup id r= bc=`, thêm `br=` khi view có br riêng). `pattern-mockup.html` cũng nhận `br` (tham số thứ 5 của `V`).
- **Map 3 kênh (từ 2026-09-16):** R = id×20 · G ≥ 250 vạch = trục grain (thẳng = góc, cong = trục tay/chân, nội suy pháp tuyến + `AX_RMIN` fold guard) · **B ≥ 250 chấm xanh dương = 4 góc rẻ quạt** (production + testing) · **G+B ≥ 250 chấm xanh lơ = 4 góc phối cảnh** (production đọc thành homography từ 2026-09-17, `1225847`; map hiện tại chưa có chấm này nên chưa chạy. Chỉ `opt.quads:false` mới tắt). Pixel có B ≥ 250 không bao giờ là vạch. Engine production còn displace nếp nhăn theo gradient (`DISP_AMP 12 / DISP_BLUR 8`) và mép mềm theo **độ phủ đọc từ map** (raster map có làm mịn, R/(id×20) tại pixel chạm id 0; không blur mask, không bán kính feather — blur mask từng tạo quầng sáng quanh dây quần trắng/bàn tay trên print tối); tone vẫn multiply.
- **Sửa engine mà không được đổi output** (refactor, tối ưu): `node compositor/regress-engine.js run <page> before.json` trên bản đã commit → sửa → `run … after.json` → `compare before.json after.json` phải in `IDENTICAL`. Chạy engine thật trong node-canvas trên đủ 12 garment, ~30s/lần, cần `NODE_PATH` trỏ tới thư mục có package `canvas`.

## Dashboards: CSS + dropdown dùng chung (từ 2026-10-14)
3 dashboard `dashboards/vid-thao`, `trang-mockup`, `van-featured-image` (mỗi cái 1 service Render free, chỉ deploy folder của nó) dùng chung giao diện kiểu Shopify Analytics:
- **Bản gốc ở [`dashboards/shared/`](dashboards/shared/)**: `shared.css` (token Polaris đo từ admin.shopify.com Reports) + `shared.js` (thanh đầu trong suốt, hiện nền trắng + kẻ khi cuộn; vẽ lại mọi `<select>` thành nút xám + menu; select gốc vẫn giữ `.value`/`onchange`). Sửa ở đây → `.dashboardssharedsync-shared.ps1` copy vào `public/` cả 3 → commit cả bản gốc lẫn 3 bản copy. `-Check` báo bản copy lệch.
- Thứ tự nạp trong index.html: `style.css` (riêng) → `shared.css` → `responsive.css` (breakpoint riêng, phải nạp sau để thắng shared).
- User chốt: trang cuộn (không cuộn riêng bảng), top bar dính: trái = tiêu đề + Updated, phải = action. Bảng nằm trong `.card` bo 20px; hàng đầu `.card-head` chứa filter/tab, hàng cuối `.card-foot` chứa debug/load log để header và dòng Total không chạm góc bo. Dòng Total nằm trong <thead> ngay dưới tên cột (giống Summary của Shopify), dính cùng header, nền #f2f2f2; log ở hàng cuối căn giữa; không dùng màu tím, nút trắng viền mảnh.
- van-featured-image: tab Active ads / All ads trong card chỉ chọn chế độ, nút Load Data mới tải.
