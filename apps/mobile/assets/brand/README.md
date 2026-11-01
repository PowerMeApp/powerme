# PowerMe brand crop

`powerme-master-lockup.png` là bản sao nguyên byte từ asset người dùng cung cấp tại `E:/Project/PowerMe/assets/brand`, theo README nguồn: crop raster P + POWERME + slogan, **533 × 310**, nền đen, không trong suốt/vector. Giữ tỷ lệ; không redraw, xóa nền hoặc upscale.

SHA-256: `9391b1d0dbaaa72061884f86409ee951ab05cc2a400bc4d3fe393567145ffacb`.

Header compact dùng thêm hai crop nguyên byte từ cùng thư mục nguồn:

| Asset | Kích thước | SHA-256 |
| --- | --- | --- |
| `powerme-master-icon.png` | 200 × 194 | `76b860270cb67ddb4eb251f3c169cadc7e4a9223c6662ef72aa60f039c3d205a` |
| `powerme-wordmark.png` | 520 × 77 | `cd20ba988cddc3aa866e70ef407e04d063adfb7a2d4d13790e388cb701ab7ba6` |
| `powerme-secondary-icon.png` | 198 × 203 | `98361edbb5826ca9a0214d130c0de3e9211d99afe3d9f55c093f4acdfbb2ad22` |

Đã đối chiếu hash cả bốn asset với bản nguồn ngày 30/10. Secondary là bản sao nguyên byte từ `E:/Project/PowerMe/assets/brand/powerme-secondary-icon.png`, dùng cho dịch vụ/cổng/phiên sạc; main lockup/ribbon/wordmark giữ nhận diện auth/header. Source PNG vẫn nền đen; `BrandMark`/`ChargingMark` giữ tỷ lệ và hòa pixel đen vào đúng solid surface lúc render bằng screen color filter, không sửa ảnh hoặc dùng tint trắng. Xem quy tắc và giới hạn tại [design-system](../../docs/design-system.md). Không dựng chữ POWERME bằng font thay ảnh. Launcher/splash platform vẫn là scaffold Flutter. Chưa bundle Montserrat/Cinzel vì không có font/license được bàn giao; dùng font hệ thống.
