# Ảnh đếm ngón cho `hoc-dong-ho.html` (tab Số)

Bộ ảnh thay cho hình bàn tay/bàn chân vẽ bằng SVG. Mỗi phút = một ngón; ngón thứ `i` sẽ được
ghi đè một nhãn `giờ:phút` lên trên bằng CSS, nên **vị trí ngón phải cố định giữa các ảnh**.

## Cần đúng 22 file

| File | Nội dung |
|---|---|
| `tay-0.png` … `tay-10.png` | **Hai bàn tay trong CÙNG một ảnh**, giơ 0 → 10 ngón |
| `chan-0.png` … `chan-10.png` | **Hai bàn chân trong CÙNG một ảnh**, giơ 0 → 10 ngón |

`tay-0.png` = hai nắm tay. `tay-10.png` = hai bàn tay xoè hết.

## Bốn ràng buộc bắt buộc

1. **Cùng khung hình.** Cả 11 ảnh trong một bộ phải cùng góc máy, cùng khoảng cách, bàn tay ở
   đúng một chỗ trong khung. Chỉ khác nhau ở số ngón đang giơ. Lệch vị trí thì nhãn giờ:phút
   sẽ không nằm trên ngón.
2. **Cùng kích thước pixel** cho cả 22 file (ví dụ 1200×700). Tỉ lệ ảnh tay và ảnh chân có thể
   khác nhau, nhưng trong mỗi bộ phải đồng nhất.
3. **Thứ tự giơ ngón: TRÁI → PHẢI.** Ngón 1 là ngón ngoài cùng bên trái của bàn tay trái;
   ngón 10 là ngón ngoài cùng bên phải của bàn tay phải. Ảnh `tay-3.png` = ba ngón trái nhất
   đang giơ, bảy ngón còn lại cụp.
4. **Nền trong suốt (PNG có alpha).** Trang có nền kem `#fdf6f0`; ảnh có nền trắng/xám sẽ hiện
   thành một khối chữ nhật đè lên trang.

Ngón đang giơ nên **thẳng và tách nhau**, đủ chỗ ghi một nhãn cỡ `8:15` dọc thân ngón.

## Cách tạo cho ăn khớp nhau

Chụp máy ảnh thì để máy trên chân đế, không đụng vào giữa 11 lần bấm.

Tạo bằng AI ảnh thì đừng sinh 11 ảnh rời — gần như chắc chắn lệch nhau. Làm thế này:
sinh **một** ảnh `tay-10.png` (xoè hết) trước, rồi dùng chính ảnh đó làm ảnh gốc cho
image-to-image / inpainting, mỗi lần chỉ sửa vùng ngón cần cụp. Phần còn lại giữ nguyên pixel.

Prompt gốc (tiếng Anh, vì model ảnh ăn tiếng Anh tốt hơn):

```
Two open hands side by side, palms facing the camera, all ten fingers extended
and clearly separated, straight-on front view, soft even lighting, plain
transparent background, photorealistic, full hands visible with wrists at the
bottom edge
```

Rồi mỗi bước sửa: `curl the rightmost finger down into the palm, keep everything else identical`.

## Xong thì báo

Bỏ đủ file vào thư mục này rồi nhắn. Tôi sẽ đọc ảnh, lấy toạ độ từng ngón, và thay phần vẽ SVG
trong `hoc-dong-ho.html` bằng ảnh. Trong lúc chờ, tab Số vẫn dùng hình SVG cũ nên trang vẫn chạy.
