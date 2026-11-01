# Map-first Discover UI — research và trace 30/10/2026

## Phạm vi và quyết định

Yêu cầu trực tiếp: tab đầu là map có pin/thông tin trạm; chọn trạm hoặc gợi ý theo đường bộ/giao thông/pin, rồi preview đường đi trong app. Chỉ UI với adapter local. FR-03/21; UC-CHG-01/07; BR-P03/32/33/38–43; NFR-RES và visual accessibility liên quan. Provider, GPS, traffic/routing và ranking thực vẫn pending WP2/WP4; không tuyên bố kết quả RQ2.

Đã fetch origin trước sửa; HEAD/origin/main `50a2010dfb217c2f3f6b40e2879a1661dff48f85`, divergence 0/0. Mobile và user diagrams đang WIP được giữ. Không cài repo/dependency, chỉ đọc GitHub source/tests/license. Lần gọi trong môi trường hạn chế lỗi DNS; đọc lại có quyền network thành công. Không chạy code upstream.

## Source chính chủ đã đọc

Flutter packages commit `3258d45ac0f73c86fbe53a2e2c7b0ea4946d793c`:

- [place_marker.dart](https://github.com/flutter/packages/blob/3258d45ac0f73c86fbe53a2e2c7b0ea4946d793c/packages/google_maps_flutter/google_maps_flutter/example/lib/place_marker.dart): stable marker identity, selected marker state, tap callback và deselection.
- [place_polyline.dart](https://github.com/flutter/packages/blob/3258d45ac0f73c86fbe53a2e2c7b0ea4946d793c/packages/google_maps_flutter/google_maps_flutter/example/lib/place_polyline.dart): polyline point list, width/join/cap/color, explicit add/remove/update.
- [polyline_updates_test.dart](https://github.com/flutter/packages/blob/3258d45ac0f73c86fbe53a2e2c7b0ea4946d793c/packages/google_maps_flutter/google_maps_flutter/test/polyline_updates_test.dart): initialization/removal/update by identity, mutable points and delayed platform updates. Đã đọc actual test code, không chỉ README.
- [LICENSE](https://github.com/flutter/packages/blob/3258d45ac0f73c86fbe53a2e2c7b0ea4946d793c/packages/google_maps_flutter/google_maps_flutter/LICENSE): Flutter Authors BSD 3-clause. Google Maps service/platform terms là phạm vi khác, không được suy từ license Dart plugin.

Flutter framework commit `00fdaaefcfea61be8bc6da210ecdd935de89d93a`:

- [draggable_scrollable_sheet.dart](https://github.com/flutter/flutter/blob/00fdaaefcfea61be8bc6da210ecdd935de89d93a/packages/flutter/lib/src/widgets/draggable_scrollable_sheet.dart): supplied ScrollController cho child scroll view; attach guard, initial/min/max size; animateTo không tự snap; lifecycle controller.
- [draggable_scrollable_sheet_test.dart](https://github.com/flutter/flutter/blob/00fdaaefcfea61be8bc6da210ecdd935de89d93a/packages/flutter/test/widgets/draggable_scrollable_sheet_test.dart): list controller wiring, drag/scroll replacement, min/max/snap cases, explicit animation checks.
- [LICENSE](https://github.com/flutter/flutter/blob/00fdaaefcfea61be8bc6da210ecdd935de89d93a/LICENSE): BSD 3-clause.

Hai repo chính chủ được dùng làm căn cứ pattern; không đánh giá chất lượng theo star. Một số URL example `draggable_scrollable_sheet.0/.1.dart` thử ban đầu trả 404; không dùng chúng làm evidence, đã thay bằng source framework/test thực.

## So sánh cách áp dụng

| Lựa chọn | Phù hợp / architecture | Dependency và security | License / bảo trì / đánh đổi |
| --- | --- | --- | --- |
| google_maps_flutter thật | Map SDK, marker/polyline/camera, thích hợp giai đoạn tích hợp provider; không tự cung cấp road routing/traffic ETA/battery ranking | Cần plugin/platform setup, key/billing/provider, permissions và network review; chưa được cho phép thêm dependency | BSD plugin, service terms riêng. Maintained chính chủ; không giải quyết nhu cầu UI offline hiện tại chỉ bằng cài package |
| Flutter CustomPainter + InteractiveViewer + DraggableScrollableSheet | Dựng local scene/route fixtures và interaction giống bản đồ; giữ controller/repository, phù hợp UI-only | SDK đã có; không key/GPS/network/new package. Auth/vehicle/request guards vẫn ở controller/adapter | Framework BSD, không source copy. Dễ test/render deterministic; không geographic accuracy/map tiles/routing/live traffic. Phải thay adapter và canvas/provider khi tích hợp thật |

Chọn cách thứ hai. Không sao chép widget demo nguyên khối; áp dụng ý tưởng stable selection, explicit ordered polyline, provided sheet ScrollController và lifecycle cleanup vào code PowerMe tự viết. Giữ notices đã có; không đem logo/tiles/data của Google vào app. No attribution bị loại bỏ.

## Data và giới hạn

- `road_route_fixtures.dart`: mỗi station có ordered path đi qua các đoạn đường trong scene, không dựng đoạn nối thẳng khi thiếu tuyến. Tên đường/khu vực chỉ trang trí cho sơ đồ tương đối; không dữ liệu địa lý được đo/kiểm ngoài đời.
- Adapter trả integer đường bộ m, travel seconds gồm traffic delay, traffic segments, timestamp và battery arrival fixture. Battery-use fixture không mô hình tiêu thụ được kiểm chứng; unknown model/battery giữ null/unknown. Location/battery không lưu history.
- `nearest` là extension theo yêu cầu người dùng, xếp bằng road fixture distance trong adapter. `fastest` giữ travel + wait + charge; không đổi thành nearest. `cheapest` giữ cost-based fixture. Không tính rank/ETA/distance/pin trong widgets.
- SRS §3.7 cho straight-line/30kmh fallback và external map handoff. Yêu cầu người dùng 30/10 override UI slice: preview road path nội bộ, không straight-line fallback. Không sửa shared SRS/backend và không coi policy/contract provider đã đồng bộ.
- Không voice/turn-by-turn/background GPS, trạng thái đến nơi hay đảm bảo an toàn hành trình. UI vẫn gọi “ước tính” và giữ lỗi/unknown nghiệp vụ, không thêm banner mock/demo.

## Kiểm tra cần giữ

Test route segments trên road scene, route missing/unknown battery/insufficient battery/wrong vehicle, nearest vs fastest semantics, late request/select/clear/auth-generation/dispose. Widget test pin → route → detail, suggestion input → result → route, ba tab, search/filter/no vehicle/hold access, 320px/200%. Preview 390×844 dùng font SDK sẵn, TextPainter thừa kế font theme; inspect tên đường, asset logo và route summary. Kết quả thực, số test/captures/build ở README; không dùng fixture pass làm NFR/integration evidence.
