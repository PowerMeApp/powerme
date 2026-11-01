# Thiết kế và thương hiệu

Giữ nhận diện khách hàng. UI cũ/Stitch là tham khảo hình ảnh; [SRS](../../../docs/requirements/report3-srs.md) và [screens](screens.md) quyết định nội dung. Ghi sai khác để review.

| Token | Giá trị |
| --- | --- |
| Gold | `#D4AF37` |
| Teal | `#00E0C2` |
| Rich Black | `#0A0A0A` |
| Graphite | `#141414` |

Dùng Flutter `ThemeData`/`ColorScheme`/`TextTheme`, token spacing/radius/size và shared button/input/card/status/sheet/empty/error/pending. Không Tailwind, không WebView thay Flutter UI. Màu phụ chữ/semantic state khai báo riêng và review độ đọc; không đổi 4 màu gốc. Không chỉ dùng màu để báo trạng thái; hỗ trợ text scaling/safe area/bàn phím/trợ năng, copy tiếng Việt và VND/ICT rõ.

## Logo và font

Shared `BrandMark` dùng [crops gốc](../assets/brand/README.md): lockup 533×310 ở đăng nhập; ribbon 200×194 và wordmark 520×77 ở header compact onboarding/discovery. `ChargingMark` dùng secondary icon 198×203 gốc ở Start, empty/pending charging và avatar station/connector. Giữ tỷ lệ bằng `BoxFit.contain` và byte hash; không dựng lại wordmark bằng font hoặc thay ribbon bằng tia sét. Theme dùng đúng bốn token gốc. Launcher/splash platform vẫn là scaffold, chưa phải nhận diện hoàn chỉnh.

Không bọc logo bằng khung #000000. Runtime dùng `Image.color = backgroundColor` + `colorBlendMode: BlendMode.screen`: screen kết hợp pixel ảnh với đúng màu nền solid (#0A0A0A hoặc #141414), nên pixel đen trở thành màu surface và nét vàng/teal được giữ. Đây là color filter lên ảnh, không blend tự động với phía sau; caller phải truyền đúng màu surface. Không tint trắng, không dùng trên gradient không đồng nhất hoặc coi crop là ảnh alpha; file gốc giữ nguyên. Pixel render tests kiểm cả hai nền và màu artwork, không chỉ kiểm thuộc tính widget.

Brand board định hướng Cinzel/Trajan Pro cho wordmark và Montserrat cho UI. Wordmark hiện nằm trong lockup gốc; chưa có font file/license bàn giao để bundle. UI dùng font hệ thống; ảnh review dùng Roboto có sẵn trong SDK, không thêm dependency/font vào app. Không báo brand đã xong.

App cũ `E:/Project/PowerMe/apps/mobile` chỉ là tham khảo visual tùy chọn; không là dependency/requirement. Người clone không cần thư mục đó.

## Chỉnh theo review giao diện 30/10

- Đối chiếu bố cục discovery/card/charging của app local cũ và brand board `docs/sources/brand/powerme-brand-board.jpg` ngoài repo; giữ nguyên contract và policy của app mới. Nền raster được hòa vào solid surface lúc render như trên, không sửa byte/xóa nền/redraw asset.
- `HeroCard`: gradient graphite pha teal/gold nhẹ và viền accent; chỉ dùng cho tín dụng, SOC, điểm và identity. Thẻ thường/input có viền xám giảm alpha; menu dùng divider mảnh.
- Home compact theo review mới: logo → tiêu đề → tín dụng với số dư trái/nạp phải → search → bốn quick actions (Mã cổng/Gợi ý/Giữ chỗ/Sơ đồ) → xe → bộ lọc → trạm. Ba tab Khám phá/Phiên sạc/Tài khoản cố định ở ba màn chính, không lặp Phiên sạc trong quick actions. Hàng xe có vùng bấm tối thiểu 48px; ở màn nhỏ/text lớn cho cuộn và tự xuống dòng, không giảm target/font để ép vừa. Giữ chỗ/lịch sử/điểm vẫn có menu Tài khoản. Thông tin tên/địa chỉ/operator/tariff/disclosure cùng card ở Station Detail; trạng thái từng cổng độc lập.
- Charging: SOC lớn, progress chỉ khi có SOC; null hiển thị chưa xác định. `MetricGrid` 2 cột, đổi 1 cột khi màn <340px, vùng nội dung hẹp hoặc text scale >1.3. Status pill gồm chữ + dot, không chỉ dùng màu. Không đổi lifecycle/quality/settlement để làm đẹp.
- Bảng kê/checkout dùng key-value ngang, căn giá trị phải và divider; chuyển dọc khi hẹp/text lớn. Profile identity trước menu, edit trong identity card. History actions căn trái; schematic có halo và hàng chú thích bấm được. Không biến schematic thành bản đồ/GPS thật.

Ảnh review là output Flutter render test tại 390×844; xem manifest và kiểm tra thực tế trong README. Không coi ảnh render là kiểm thử thiết bị hay chứng nhận accessibility.

## Hallmark

[Nutlope/hallmark](https://github.com/Nutlope/hallmark) là tham khảo tùy chọn về phân cấp/khoảng cách/typography/thao tác. Task này **chưa cài Hallmark**; không thêm dependency Dart. Linter HTML/CSS của repo không kiểm Dart widgets. Trước dùng code/asset đọc source/license tại commit tham khảo, ghi attribution cần thiết; chỉ áp dụng gợi ý phù hợp Flutter và giữ palette/logo.


## Map-first Discover — yêu cầu 30/10

Thay bố cục home cuộn dọc ở record trước: header logo gốc + credit entry nhỏ, search; map chiếm phần lớn viewport đầu ở 390×844, xe/filter overlay, pin có tên/cổng trống/công suất. Tuyến teal, đoạn chậm gold có nhãn chữ/ETA delay; không dùng màu như chỉ báo duy nhất. Dưới là draggable sheet collapsed/expanded/list và chọn trạm/route summary, ba tab còn nguyên. Thẻ route không che tuyến mặc định; pan/zoom/reset không cần location permission. At 320px/200%, thông tin/nút trong sheet và suggestion cuộn được, không giảm text scale; hình chữ trên nền bản đồ là trang trí, pin có semantics đầy đủ.

Bản đồ tương đối và tuyến dựng sẵn chỉ phục vụ review UI, không map tiles hay dẫn đường thực. Dùng font theme cho TextPainter để render tên đường nhất quán với chữ ngoài canvas; không bundle font mới. Main/secondary asset byte và palette giữ nguyên.
