# Vietmap — bản đồ nền và vị trí theo yêu cầu 30/10/2026

## Điền key và chạy Android Studio

File local đã được tạo: `E:/Project/PowerMe/powerme/apps/mobile/config/vietmap.local.json`.
Điền key Tile/Map của riêng bạn vào giá trị `apiKey`; không gửi key vào chat.

```json
{"apiKey": "DIEN_KEY_CUA_BAN"}
```

File thật bị gitignore; template commit được là `config/vietmap.example.json`.
Sau khi clone mới, copy template thành `vietmap.local.json` trước `flutter pub get`/build.
Không ghi key vào Dart define, source, README, log, QR hay manifest. Không overwrite file local khi cập nhật code.
Key maps phía client vẫn có thể bị trích từ app; ignore chỉ tránh commit. Dùng key riêng cho development, hạn mức và restrictions do Vietmap hỗ trợ; không dùng credential thanh toán/signing.

Mở `E:/Project/PowerMe/powerme/apps/mobile` trong Android Studio; chọn Flutter SDK `E:/MobileDev/Flutter`, chọn thiết bị Android API 24 trở lên, chạy `lib/main.dart`. Sau đổi key, Stop rồi Run lại để đóng gói asset mới. Không cần Google Maps key. Style dark được xác minh theo tài liệu chính thức:
`https://maps.vietmap.vn/maps/styles/dm/style.json?apikey={your-apikey}`.

Bản đồ khởi đầu quanh Nhà Văn hóa Sinh viên ĐHQG TP.HCM, Đông Hòa (10.87534, 106.80003, zoom 16). Đây là camera mặc định, không là vị trí người dùng.
Bấm **Vị trí của tôi** trên map để xin quyền foreground và lấy một vị trí. Không xin khi mở màn, không theo dõi nền/stream, không lưu vị trí vào history hoặc gửi backend. Nếu từ chối/tắt GPS/timeout, map vẫn pan/zoom; dùng search/list trạm để tiếp tục. Quyền bị từ chối vĩnh viễn: bật lại trong Android Settings → Apps → PowerMe/driver_app → Permissions → Location.

## Phạm vi và kiến trúc

`main` đọc config local → `DemoApp(mapConfig: config)` compose live Vietmap surface. `DemoApp()` không config chỉ dành cho local harness/preview hiện có; không fallback âm thầm từ live-map lỗi sang sơ đồ. Key rỗng/config lỗi hiển thị chưa mở được map, không gọi provider bằng key mẫu.

Stations extension: `MapLocationRepository` (domain Dart) ← `DeviceLocationRepository` (geolocator), `MapLocationController` (Riverpod, scope/dispose/request guard) → surface. UI không gọi geolocator trực tiếp. Một tap lấy một fix, duplicate tap coalesced; late result sau đổi auth/dispose không áp vào state. Camera/controller native thuộc presentation; VietmapGL tự dispose native controller.

Giữ nguyên lớp UI brand, search/filter/danh sách/chọn trạm và ba tab. Theo yêu cầu mới, hai trụ giả lập Đông Hòa có Station.location riêng để hiển thị marker; trạm khác thiếu location không có pin trên Vietmap. Không chuyển mapX/mapY tương đối thành địa lý hoặc vẽ tuyến fixture lên map thật. Tính đường, traffic, pin/xếp hạng và route API chưa tích hợp. Existing suggestion fixtures chỉ là UI local, không sử dụng GPS mới để tuyên bố ranking thật. Không gọi BE, navigation SDK hay OCPP.

SDK giữ logo và attribution mặc định, nâng lên trên bottom sheet. Có trạng thái style loading, sau 20 giây chưa load hiển thị lỗi chung + retry; không hiển thị raw exception/URL có key. SDK chưa expose tile-auth callback ổn định: style loaded không chứng minh mọi tile tải được; cần kiểm trực tiếp với key hợp lệ và kiểm quota/401/403/network trên thiết bị. Không tuyên bố lỗi 401 đã được test. Web và iOS chưa kiểm thiết bị; trọng tâm Android. Không bypass TLS.

## Nghiên cứu source, so sánh và giấy phép

- Repo người dùng: https://github.com/vietmap-company/flutter-navigation-example tại `6f1d792dd48c97a3d7fabec8c44f384b48a088dd`. Đã đọc `lib/features/map_screen/maps_screen.dart`, `pubspec.yaml`, `test/widget_test.dart`, `LICENSE`. Source dùng VietmapGL + navigation, Bloc/Dio/Geo; SDK constraint example cũ `<3.0.0`, không clone scaffold vào app Dart 3.12. Test upstream là counter scaffold, không chứng minh map/location hoạt động. Giấy phép MIT (2023 Vietmap Application Co., Ltd). Chỉ tham khảo cách compose map/camera, không copy code ứng dụng hoặc key/demo styles.
- SDK chính chủ https://github.com/vietmap-company/vietmap_flutter_gl tại `a2ca23982c156d285c344878c299efc0eb7ef11b`; dependency chọn **vietmap_flutter_gl 4.1.1** khóa trong pubspec/lock. Đọc source package `lib/src/vietmap_gl.dart`, `controller.dart`, `LICENSE`: constructor style/camera, style loaded lifecycle, addCircle, camera animate và widget-owned dispose. BSD-3-Clause, xem notice. Native min SDK 24/JitPack theo docs package; thêm native surface và nhiều transitive deps là đánh đổi cần thiết để render street vector. Không thêm navigation/offline engine.
- Geolocator chính chủ https://github.com/Baseflow/flutter-geolocator tại `527cea04d91cc09dfe2f5802f88073a7cb7bc820`, đọc `geolocator/example/lib/main.dart` permission/service lifecycle. Chọn **14.0.2** SDK compatible và lock transitive; MIT. Viết adapter riêng lấy current fix có timeout, không copy stream/background flow.
- So với flutter_map: renderer raster thuần Flutter dễ test/multiplatform hơn và ít native config. Tuy nhiên tài liệu Vietmap hiện hành chỉ liệt kê raster satellite `st`, street/light/dark là vector style; không đoán endpoint PNG street cũ. Chọn Vietmap GL để giữ đường/nhãn thật phù hợp mục tiêu UI. Không thêm flutter_map cùng lúc hoặc cả navigation SDK.
- Tài liệu đã tra: https://maps.vietmap.vn/docs/map-api/tilemap/ và https://pub.dev/packages/vietmap_flutter_gl . Terms/quota/key capabilities theo tài khoản Vietmap; không giả định dịch vụ miễn phí.

## Kiểm chứng

Analyzer sạch, toàn suite **79/79 pass** (72 cũ + 7 mới). Test config invalid/redacted diagnostics, locate chỉ theo intent/duplicate/dispose, bốn lỗi explicit không fake coordinate và missing-key không fallback schematic. Đây là unit/widget checks, chưa là live tiles/GPS/permission integration. Android build ghi kết quả cuối trong README.

## Hai trụ giả lập Đông Hòa — 30/10

Địa điểm do người dùng xác nhận: Nhà Văn hóa Sinh viên cơ sở ĐHQG TP.HCM, Đông Hòa. Hai vị trí fixture, không khẳng định có charger/chỗ đỗ thực tế:

| ID | Latitude, longitude | Cổng |
| --- | --- | --- |
| station-powerme-nvhs-01 | 10.87505, 106.79965 | CCS2 120 kW, số 1 |
| station-powerme-nvhs-02 | 10.87585, 106.80055 | CCS2 60 kW, số 1 |

Nguồn địa điểm lượt trước lưu: https://www.openstreetmap.org/node/9593572489 . Lượt tiếp tục không truy cập lại được trang/API OSM; giữ tọa độ fixture đã lưu, chưa xác minh thực địa. Tọa độ hai trụ được dựng cho UI, không phải charger data của OSM.

Marker dùng secondary icon gốc, canonical stationId → selected sheet → detail/start. Search/filter/compatibility dùng cùng StationsState.stations với danh sách. Native writes xếp hàng, style epoch bỏ thao tác cũ khi reload/retry; tháo tap listener khi đổi controller/dispose. Camera không ghi GPS position; định vị vẫn opt-in qua device adapter. Hai trụ chưa có tuyến đường: route null, không mượn route trung tâm TP.HCM hoặc giả xếp hạng.

Kiểm chứng: 82/82 test pass, analyzer sạch. Test mới kiểm fixture/connector identity, search/power/status filters và callback selection → sheet/detail/start, bỏ selected pin khi lọc. Chưa kiểm native symbol taps/style reload/tiles/GPS trên thiết bị thật. Không đọc/đổi key local; không đổi native/dependency/backend, không build Android lại.
