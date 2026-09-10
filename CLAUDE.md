# git/ — n8n workflows, forms, dashboards

## Dùng MCP n8n nào

Luật chọn server (bảng phân công, UUID connector, bẫy draft/published) đã chuyển lên **CLAUDE.md ở workspace root** — nó kế thừa xuống đây nên luôn có sẵn. Đừng chép lại vào file này, tránh 2 bản lệch nhau.

## Workflow có tài liệu riêng

| Thư mục | Việc |
|---|---|
| [`../zum-prd/`](../zum-prd/CLAUDE.md) | Pattern swatch → product nháp zumbamboo (workflow `kZvHwfNZ6Gz1L5E4`). **Tài liệu nằm ngoài repo này**, nhưng form của nó vẫn ở [`forms/zum_prd_form.html`](forms/zum_prd_form.html) |

## Compositor flatlay: 2 file, 1 engine
[`forms/flatlay-composite.html`](forms/flatlay-composite.html) (dev tool) và [`forms/zum_prd_form.html`](forms/zum_prd_form.html) (form production) chứa **cùng một khối engine byte-identical** giữa 2 dòng marker `// ===== SHARED BLOCK` … `// ===== END SHARED BLOCK =====`. Cả 2 vẫn là one-page HTML (khối được nhân đôi, không load script chung).
- Sửa engine (compose, analyzeGarment, hằng số, colour helpers) **chỉ trong `flatlay-composite.html`** → `.\forms\sync-shared.ps1 -Push` → commit **cả 2 file**.
- `.\forms\sync-shared.ps1` (không flag) diff 2 bản, exit 1 nếu lệch — chạy trước khi commit bất kỳ file nào trong 2 file này.
- **`GARMENTS`/`?v` KHÔNG còn trong shared block** (từ 2026-09-10): nằm ở khối page-local `// ===== GARMENT DATA =====` ngay trên SHARED BLOCK, KHÁC nhau giữa 2 file. Garment mang `flats:[...]` (1+ flatlay) + `models:[...]`. **Mỗi view mang `r`** = bề rộng pattern / bề rộng mock (từ 2026-09-10, thay cho `gw`/`bodyW`/`cal`/`K_BASE` cũ); chỉnh cỡ motif của một ảnh = sửa đúng số `r` của nó. **Thêm bộ mock+map mới → chạy `python forms/motif-r.py --flat <map flatlay> [--flat-r <r đang dùng>] [--k 0.62 nếu xếp cạnh nhau] <map model...>`** để lấy `r` cho từng view (model suy từ flatlay theo bodyW/W). Dev tool `flatlay-composite.html` có 4 garment: romper, pajama (**2 flatlay**), men pajama, women pajama; form `zum_prd_form.html` giữ 2 garment và vẫn dùng `flat:` số ít (1 flatlay). Thêm garment/flatlay vào dev tool: sửa GARMENT DATA của `flatlay-composite.html` (+ `<option>` dropdown nếu type mới), **KHÔNG -Push** (form thiếu ô grid → crash). Bump `?v` cũng sửa ở GARMENT DATA từng file.
- Code riêng từng trang (UI, webhook, NICHES) nằm ngoài khối; khối không được đụng DOM/state trang.
- **Sửa engine mà không được đổi output** (refactor, tối ưu): `node forms/regress-engine.js run <page> before.json` trên bản đã commit → sửa → `run … after.json` → `compare before.json after.json` phải in `IDENTICAL`. Chạy engine thật trong node-canvas trên đủ 12 garment, ~30s/lần, cần `NODE_PATH` trỏ tới thư mục có package `canvas`.
