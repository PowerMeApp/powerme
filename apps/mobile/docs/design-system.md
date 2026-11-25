# Thiết kế và thương hiệu

## T96 — five UX review fixes, 23/11

Stop/Retry occupies a fixed, content-sized footer above the existing five tabs; ≥48dp targets remain visible without scrolling at 390px/100% and 320px/200% in VI/EN. Other FlowPages retain their existing body when no footer action is supplied. Confirmation and server lifecycle still determine behavior.

Station detail uses the explicit QR-at-station action. Selected vehicle models collapse the catalog with Change model/Keep selected model controls, preserving the draft. Minimum-point validation stays inline, including with a simulated keyboard inset; blank/0 continues without points. Money uses shared integer VI/EN currency/sign formatting, with maximum and actual amounts separately labelled. No text shrinking, fixed clipping height or decorative financial calculation.

Original gold `#D4AF37`, teal `#00E0C2`, black `#0A0A0A`, graphite `#141414`, logo bytes, theme/font fallback, 20dp gutters, 12dp radii and central Sạc remain. One bounded 15-frame batch was directly inspected and accepted by primary; no correction/recapture. The credit-ledger app-bar has offscreen white-block glyphs, and the 390px selected-model heading is partly scrolled/clipped at the top, not proof of a font defect. Those headers are not claimed visually verified. [README](../README.md#t96--five-ux-review-fixes-2311) records actual checks and fixture/native/keyboard limits; these renders do not certify device accessibility or performance.

## T96 — UI consistency polish, 23/11

Comparable cells now share width and content-driven row height: metric values sit at the bottom; an odd last metric fills the row. Selectable charging modes share a complete equal 2×2 rhythm at normal width, while narrow/200% text uses natural stacked cards. Preset rows use the same sizing; touch targets remain ≥48dp. No global fixed card height, aspect-ratio clipping or text shrinking; passive mode/status badges retain their compact sizing.

Estimated duration labels use whole-minute ceiling in VI/EN, preserving zero and localized unknown; measured elapsed remains `HH:mm:ss`. Original gold/teal/black/graphite, gradients, 20dp gutters, 12dp cell radii, five tabs/central Sạc, font fallback and four logo PNG bytes remain. Existing account summary pair already meets row sizing and is unchanged. Final seven fixture frames and capture limitations are linked from README; this is refinement of the approved look, not a new design or device certification.

## Tài khoản, điểm và nạp tín dụng — Stitch ZIP (6), 20/11

Nguồn visual là ba HTML/PNG và DESIGN từ ZIP6 người dùng cung cấp, hash/source path ở README/architecture. Chỉ đọc reference, không execute HTML, tải CDN/ảnh/font hoặc đưa policy screenshot vào app. Dùng native Flutter, brand **#D4AF37 / #00E0C2 / #0A0A0A / #141414**, original PNG byte/font theme giữ nguyên; logout lấy semantic error của theme, không thêm hex palette.

- Tài khoản: logo/identity thật, hai summary tín dụng/xe mặc định, nhóm finance/rewards và vehicle/discovery; history ghi Phiên sạc và bảng kê. Garage count có xe/vehicle(s), trailing badge ở normal, stack cùng label/description ở narrow/large text; credit row không lặp Xem. Logout error outline/tint giữ confirmation. Không copy VIP/NFC/Autocharge/tier, claim chứng nhận hoặc dữ liệu identity/credit/vehicle giả.
- Loyalty: hero vàng lớn, teal CTA và info inset theo ZIP; read-only available balance 6000 không biến thành redeem maximum 2500. Header normal 390 giữ badge + refresh; narrow/200% dùng full-width badge rồi refresh riêng để PowerMe không tách ký tự, giữ key/48dp và không giảm text scale. Loading/error/retry/zero là state thật; zero CTA vẫn nạp không dùng điểm. Không tạo ledger/history/expiry/reserved khi T149 chưa có.
- Top-up: hiển thị tín dụng VND, số tiền/preset, live quote/max/clear và summary. Minimum 50.000/maximum 2.000.000 dùng constants hiện có; không dùng 20k, minimum 500 điểm, rate 10, 50% hay khóa 5 phút trong ZIP. Exact maximum lấy server max discount, partial không suy payable; CTA **Xem số tiền thanh toán / Review payment amount** trước authoritative GET, rồi status disclosure/continue VNPay như cũ. Không auto-open khi số tiền chưa hiển thị/không khớp; Return URL không paid.

Một correction batch theo coordinator gồm đúng bốn sửa nêu trên, một confirmation batch, đã được coordinator xác nhận đạt phạm vi đó; không thêm polish/capture. 390×844/100% và 320×844/200%, VI/EN, 4 capture cases/174 PNG; normal pages phủ outer list, biến thể có first/header và vùng nội dung. Preview `E:/Project/PowerMe/.review/t145-stitch6/preview-3-screens-390-vi.png` dùng ba ảnh UI normal first-frame thực tế có logo, coordinator đã duyệt; không ghép header, không so ZIP hoặc retouch.

**Giới hạn bằng chứng:** Một số ảnh state/cuộn vẫn thiếu chrome app bar: `390-1x-vietnamese/loyalty-zero-01.png` và `390-1x-vietnamese/top-up-partial-unknown-summary-02.png`; zero đã có body title, pending GET/normal frames có logo. Decoded asset và các assertion lấy mẫu pixel pass không chứng minh mọi header PNG đã paint. Coordinator xác nhận bốn sửa UI đã đạt; không thêm vòng UI/capture. Chưa kiểm device/emulator/iOS, API đăng nhập staging, thanh toán thật hoặc NFR. Đây là offscreen render dùng SDK Roboto + transport/localized-profile fixture, không chứng minh font/device native hay screenshot mọi state hoàn hảo. Các assertions RawImage/decoded/sample pixel chỉ là diagnostics; `capture-confirmation-audit.json` ghi `all_state_header_painting_verified=false`. Full regression 229/229 và offline Android debug **30s** là functional/build checks, tách khỏi giới hạn ảnh; logs/trace ở README/screens/architecture.

## Charging theo Stitch ZIP (5) — 19/11

Đã đọc năm HTML/PNG M06, M07, M08, M09, M09-A cùng DESIGN trong ZIP. Native Flutter giữ hierarchy thẻ cổng/xe, 2×2 chế độ có teal selected, preset/custom và tóm tắt; M07 có vòng chờ, timeline và panel quyết định tín dụng bo góc trên với Apply/Top up/Edit. M08 dùng ring lớn theo mode, nhãn mode chỉ đọc, ba số điện năng/thời gian/tạm tính và context trạm/xe. M09 có bốn pha adaptive trên cùng; M09-A là bottom sheet Material với một mode/mục tiêu của phiên. Ở 320px/200%, nhãn và số liệu xếp dọc/cuộn, không giảm cỡ chữ hoặc vùng chạm 48dp. Ring lớn chữ lớn tách readout ra ngoài, không animate số giả nên Remove animations không tạo timer giả.

Điều chỉnh bắt buộc so với ZIP: bỏ Demo/Live CSMS/Backend Limit/OCPP 2.0.1, số đo kW/V/A, đồ thị mẫu, SoC/BMS%, 100% tương thích, thông số/giá/địa chỉ cổng chưa có trong lookup. Ảnh xe dùng hồ sơ, credit hoặc fallback có sẵn; không hardcode xe/350kW hay tải ảnh HTML. Full không hứa mobile dừng tại 100%; không khẳng định chốt mở, 0A, an toàn rút cáp, VAT đã phát hành hoặc trừ tín dụng bằng điểm. Chỉ giữ số và trạng thái có bằng chứng API.

Giá trị actual có thể vượt target; chỉ nét vòng clamp, không clip số. Timed lấy elapsed server, money lấy estimate T134; maximum tariff hiển thị riêng, statement vẫn authoritative debit. M09 bốn pha quan sát được là yêu cầu / phản hồi trụ / nhận chỉ số chốt / ghi sổ; trường hợp app không gửi stop ghi “Theo trạng thái phiên”. Không mô phỏng relay/lock. M07 tự chuyển sau effect thay nút Theo dõi; nút mở lại chỉ phục vụ Back hoặc quay về phiên đã có. Màu/logo/byte assets và font theme/fallback hiện có giữ nguyên.

Giữ nhận diện khách hàng. UI cũ/Stitch là tham khảo hình ảnh; [SRS](../../../docs/requirements/report3-srs.md) và [screens](screens.md) quyết định nội dung. Ghi sai khác để review.

| Token | Giá trị |
| --- | --- |
| Gold | `#D4AF37` |
| Teal | `#00E0C2` |
| Rich Black | `#0A0A0A` |
| Graphite | `#141414` |

Dùng Flutter `ThemeData`/`ColorScheme`/`TextTheme`, token spacing/radius/size và shared button/input/card/status/sheet/empty/error/pending. Không Tailwind, không WebView thay Flutter UI. Màu phụ chữ/semantic state khai báo riêng và review độ đọc; không đổi 4 màu gốc. Không chỉ dùng màu để báo trạng thái; hỗ trợ text scaling/safe area/bàn phím/trợ năng, copy tiếng Việt và VND/ICT rõ.

## Logo và font

Shared `BrandMark` dùng [crops gốc](../assets/brand/README.md): lockup 533×310 ở đăng nhập; ribbon 200×194 và wordmark 520×77 ở header compact onboarding/discovery. `ChargingMark` dùng secondary icon 210×208 gốc ở Start, empty/pending charging và avatar station/connector. Giữ tỷ lệ bằng `BoxFit.contain` và byte hash; không dựng lại wordmark bằng font hoặc thay ribbon bằng tia sét. Theme dùng đúng bốn token gốc. Icon màn hình chính trên Android và iOS dùng ảnh raster dẫn xuất từ `powerme-secondary-icon.png`. Splash vẫn dùng scaffold Flutter.

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
