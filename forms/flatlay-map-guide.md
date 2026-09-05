# Hướng dẫn tạo panel map bằng Photoshop (cho `flatlay-composite.html`)

Map là một ảnh PNG cùng kích thước với ảnh mockup. Mỗi pixel của map cho biết pixel tương ứng trên mockup thuộc **mảnh vải nào** (hoặc là viền, hoặc là nền). Code đọc **kênh Red** của map và chia cho 20 để ra id mảnh. Ví dụ dùng xuyên suốt: ảnh on-model [`zum-model-romper-4.jpg`](https://admin.shopify.com/store/422aa5-ca/content/files/43565949976829), 1024 × 1280 px.

## 1. Yêu cầu kỹ thuật (bắt buộc)

| Mục | Giá trị | Vì sao |
|---|---|---|
| Kích thước | **đúng bằng ảnh gốc** (1024 × 1280 với ví dụ trên) | Code đọc map và mock theo cùng chỉ số pixel. Lệch 1 px là toàn bộ viền sai |
| Định dạng | PNG-24, RGB 8 bit | JPEG nén làm giá trị màu nhiễu, id bị đọc sai |
| Màu mỗi mảnh | Xám phẳng, **R = G = B = id × 20** | Chỉ kênh R được đọc, nhưng đặt cả 3 kênh bằng nhau để nhìn và kiểm tra dễ |
| Anti-alias | **Tắt hoàn toàn** | Pixel mép có giá trị trung gian (ví dụ 30 giữa mảnh 20 và 40) sẽ bị đọc thành mảnh khác. Dung sai chỉ ±9 |
| Số giá trị trong file | Chỉ có 0, 20, 40, 60, 80, 100, 120, 140, 160, 180 | Bất kỳ giá trị nào khác đều là lỗi |

Bảng id:

| id | R = G = B | Ý nghĩa |
|---|---|---|
| 0 | 0 | Nền: giường, da, tóc, tay/chân bé đè lên áo, mọi thứ không phải áo |
| 1–8 | 20–160 | Mảnh vải in hoạ tiết. Mỗi mảnh may rời nhau = một id riêng |
| 6 | 120 | **Dành riêng** cho mặt trong cổ áo (mặt trái của vải, code in ngược và làm nhạt). Không dùng 6 cho mảnh thường |
| 9 | 180 | Viền (trim): bo cổ, bo tay, bo chân, dây kéo (cả băng vải và răng). Code đổi màu khối này theo màu viền người dùng chọn |

## 2. Vì sao phải tách từng mảnh

Code tính cho mỗi id một **trục chính** (hướng dài nhất của mảnh) rồi xoay hoạ tiết theo trục đó, và **dịch pha** hoạ tiết khác nhau giữa các id để đường may cắt hoạ tiết như vải thật. Hệ quả:

- Tay áo phải tách khỏi thân. Thân trái tách khỏi thân phải (đường dây kéo).
- Mảnh bị gập mạnh (tay co ở khuỷu, chân co ở gối trên 30°) nên tách thành 2 id: phần trên và phần dưới khớp. Nếu để chung một id, trục chính là hướng trung bình của cả mảnh và hoạ tiết sẽ lệch ở cả hai đoạn.
- Nếp nhăn, bóng đổ **không** cần tách. Sáng tối lấy từ ảnh gốc, map chỉ cần biết pixel thuộc mảnh nào.

Kế hoạch id cho `zum-model-romper-4.jpg` (map flatlay romper hiện có dùng cùng cách chia):

| id | Vùng |
|---|---|
| 1 | Thân trước trái (bên trái ảnh), gồm cả ống chân trái nếu chân thẳng |
| 2 | Tay trái |
| 3 | Thân trước phải, gồm cả ống chân phải nếu chân thẳng |
| 4 | Tay phải |
| 5 | Dự phòng: dùng cho ống chân/cẳng tay tách ra khi khớp gập mạnh (trong ảnh này chân phải co lên, nên tách ống chân phải thành id 5) |
| 6 | Mặt trong cổ. Ảnh này kéo khoá kín, không thấy mặt trong → **bỏ trống** |
| 7, 8 | Đáy quần (gusset) hoặc thêm một mảnh tách nữa |
| 9 | Bo cổ, dây kéo, bo tay ×2, bo chân ×2 |

## 3. Các bước trong Photoshop

### 3.1 Mở file và kiểm tra chế độ

1. Mở ảnh gốc (`zum-model-romper-4.jpg`).
2. `Image > Mode`: phải là **RGB Color** và **8 Bits/Channel**. Không chuyển sang Grayscale: chế độ Grayscale áp dot gain, giá trị 20 sẽ không còn là 20 khi lưu.
3. `Image > Image Size`: ghi lại kích thước (1024 × 1280). Không crop, không resize từ đây về sau.

### 3.2 Tạo lớp nền đen

1. `Layer > New > Layer`, đặt tên `00 background`.
2. `Edit > Fill`, Contents: **Black**. Đây là id 0 cho toàn ảnh.
3. Kéo lớp này lên trên ảnh gốc. Giảm Opacity xuống ~50% trong lúc vẽ để còn thấy ảnh; **trước khi xuất phải đưa về 100%**.

### 3.3 Tắt anti-alias ở mọi công cụ chọn

Làm một lần trước khi bắt đầu, và kiểm tra lại mỗi khi đổi công cụ:

- **Pen tool (P)**: vẽ path xong, nhấn chuột phải > `Make Selection`. Trong hộp thoại: Feather Radius = **0**, bỏ tick **Anti-aliased**.
- **Polygonal Lasso (L)**: trên thanh Options, bỏ tick **Anti-alias**, Feather = 0.
- **Magic Wand / Quick Selection**: không dùng để tạo vùng cuối cùng. Nếu lỡ dùng, sau đó `Select > Modify > Contract 0` không sửa được mép; phải chuyển vùng chọn qua path (`Paths panel > Make Work Path`, Tolerance 0.5) rồi `Make Selection` lại với Anti-aliased tắt.
- **Tô sửa lỗi**: dùng **Pencil (B, nhấn Shift+B để đổi từ Brush)**, không dùng Brush. Pencil luôn cho mép cứng. Hardness của Brush 100% vẫn còn anti-alias.

### 3.4 Vẽ từng mảnh

Thứ tự: mảnh lớn trước, mảnh nhỏ và viền sau, vì lớp trên đè lớp dưới.

1. Tạo lớp mới, đặt tên theo id, ví dụ `01 body-left`.
2. Dùng Pen tool vẽ path theo **đường may** bao quanh mảnh. Với thân trái: đi từ vai, dọc đường may raglan xuống nách, xuống hông, xuống ống chân, vòng lên theo mép trong của dây kéo. Bám sát mép ngoài của viền, phần viền sẽ được phủ đè sau nên không cần chừa.
3. `Make Selection` (Feather 0, Anti-aliased tắt).
4. `Edit > Fill > Contents: Color`. Trong Color Picker, gõ vào ba ô **R, G, B** cùng một giá trị = id × 20 (thân trái: 20, 20, 20). Không chọn màu bằng cách click vào bảng màu.
5. `Select > Deselect`. Lặp lại cho mảnh kế tiếp.
6. Viền (id 9, giá trị 180) vẽ **sau cùng** trên lớp riêng, đè lên các mảnh. Dây kéo lấy cả băng vải hai bên lẫn răng. Bo cổ lấy toàn bộ dải bo.

### 3.5 Da, tóc và những thứ che lên áo

Tất cả về **0 (đen)**:

- Bàn tay bé nắm lại phía trên bo tay: phần da lòi ra ngoài bo là nền, đã đen sẵn.
- Cằm, tóc đè lên cổ áo: tạo lớp `99 skin` trên cùng, vẽ vùng da bằng Pen tool > Fill Black.
- Bàn chân trần dưới bo chân: nền.
- Ga giường lộ giữa hai chân: nền.

Sai phổ biến: để da thành id 9 vì "cùng vùng bo tay". Khi đó da sẽ bị đổi màu theo màu viền.

### 3.6 Kiểm tra trước khi xuất

1. Đưa Opacity mọi lớp về **100%**, tắt lớp ảnh gốc (icon mắt).
2. `Layer > Flatten Image` (lưu bản PSD có lớp trước khi flatten để còn sửa).
3. Mở `Window > Histogram`, chọn **Expanded View**, Channel: RGB. Histogram đúng chỉ có các **cột đứng rời nhau** tại 0, 20, 40 … 180. Nếu thấy chân cột loang ra hai bên, có pixel anti-alias.
4. Tìm pixel lỗi: Magic Wand, Tolerance **0**, bỏ tick Contiguous, bỏ tick Anti-alias. Shift+click lần lượt vào mỗi vùng màu đúng. `Select > Inverse`. Nếu vùng chọn còn gì (thanh trạng thái hiện marching ants), đó là pixel sai. Tô đè bằng Pencil với giá trị của mảnh xung quanh.
5. `Image > Image Size` lần cuối: vẫn 1024 × 1280.

### 3.7 Xuất PNG

`File > Export > Export As`:

- Format: **PNG**, bỏ tick Transparency (map không có vùng trong suốt), bỏ tick Smaller File (8-bit).
- Image Size: Scale **100%**, không đổi Width/Height.
- Color Space: **bỏ tick Convert to sRGB** và bỏ tick Embed Color Profile. Nếu tài liệu đang ở profile khác sRGB, việc convert sẽ làm giá trị 20 thành 19 hoặc 22.
- Không dùng `Save for Web` với PNG-8 có Dither.

Đặt tên theo ảnh gốc, đổi `model` giữ nguyên và thêm `map`: `zum-model-romper-4.jpg` → **`zum-model-map-romper-4.png`**. Map flatlay hiện có theo cùng quy ước: `zum-flatlay-mock-romper.jpg` ↔ `zum-flatlay-map-romper.png`.

## 4. Kiểm tra bằng script sau khi xuất

Chạy trên máy có Python + Pillow. In ra kích thước và danh sách giá trị có trong file. Kết quả đúng: kích thước bằng ảnh gốc, mọi giá trị chia hết cho 20, không quá 10 giá trị.

```bash
python -c "from PIL import Image; from collections import Counter; im=Image.open('zum-model-map-romper-4.png').convert('RGB'); print(im.size); c=Counter(p[0] for p in im.getdata()); print(sorted(c.items()))"
```

Nếu xuất hiện giá trị lẻ (ví dụ 33 với vài trăm pixel), quay lại bước 3.6 mục 4.

## 5. Đưa vào form

1. Upload PNG lên Shopify `Content > Files`, copy URL CDN (có `?v=`).
2. Trong `flatlay-composite.html`, thêm cặp `mock` + `map` vào `GARMENTS` theo mẫu của `romper` và `pajama`.

Lưu ý: hiện code chỉ ghép cho ảnh flatlay. Ảnh on-model đã có map vẫn cần thêm phần render ở tab "On model" (`#shotModel`) trước khi hiện được kết quả.
