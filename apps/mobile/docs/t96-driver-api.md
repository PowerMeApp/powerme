# T96 — Driver API

## 1. Chọn backend

Để test với staging, mở [SSH tunnel API được cấp](api-tunnel.md) và kiểm tra `http://127.0.0.1:3000/health`. Backend và DB staging chạy trên VM. Dùng tài khoản Driver test do nhóm cấp.

### Backend local

Chạy lệnh sau từ thư mục gốc repo và để terminal này mở. Runner khởi động Postgres nhúng local `powerme_demo` ở cổng `54330` và cấp `DATABASE_URL` local cho CSMS. Driver API dùng HTTP cổng `3000`. Cổng `9000` dành cho OCPP. [Runner demo của CSMS](../../csms/demo/README.md).

```powershell
npm run demo -w @powerme/csms -- --no-hmi
```

Để đăng nhập, trước khi chạy lệnh trên, đặt `DRIVER_API_JWT_SECRET_BASE64`, `DRIVER_API_JWT_ISSUER` và `DRIVER_API_JWT_AUDIENCE` riêng cho backend local trong terminal này. Secret phải là base64 chuẩn của ít nhất 32 byte ngẫu nhiên. Dùng tài khoản Driver đã đăng ký có mật khẩu trong DB local. Runner chưa cấp cấu hình JWT và dữ liệu seed chưa cấp tài khoản có mật khẩu để đăng nhập. Dùng môi trường riêng cho demo local, tránh nạp cấu hình `infra` hoặc staging.

## 2. Cấu hình URL và chạy mobile

Tạo `config/api.local.json` từ [file mẫu](../config/api.example.json) nếu chưa có. Mẫu dùng URL `http://10.0.2.2:3000/api/driver/v1` cho Android Emulator khi cổng API hoặc tunnel trên máy là `3000`. Nếu chạy desktop hoặc web trên cùng máy, đặt host `127.0.0.1`. Điền đúng cổng API đang dùng.

Mở `apps/mobile`, chọn Android Emulator và bấm **Run** với `lib/main.dart`. Hoặc chạy từ PowerShell:

```powershell
Set-Location E:/Project/PowerMe/powerme/apps/mobile
if (!(Test-Path config/api.local.json)) {
    Copy-Item config/api.example.json config/api.local.json
}
if (!(Test-Path config/vietmap.local.json)) {
    Copy-Item config/vietmap.example.json config/vietmap.local.json
}
& E:/MobileDev/Flutter/bin/flutter.bat run -t lib/main.dart
```

- HTTP debug chỉ chấp nhận `localhost`, `127.0.0.1` và `10.0.2.2`. Thiết bị Android thật cần URL HTTPS mà thiết bị truy cập được. Profile/release yêu cầu HTTPS và xác minh TLS mặc định.
- Build cần đủ hai file local. Để trống `tileApiKey` nếu chỉ dùng danh sách trạm. URL rỗng hoặc cấu hình API sai sẽ hiện lỗi kết nối. Stop/Run lại sau khi sửa file. File local được Git bỏ qua nhưng vẫn đóng gói vào app. Chỉ để URL và phiên bản consent công khai trong đó.
- Widget test và công cụ chụp ảnh dùng harness trong `test/support` cho các màn chưa nối API.

## 3. Kiểm thử thủ công

1. Dùng tài khoản Driver test đã được cấp. Kiểm tra lỗi khi nhập mật khẩu sai, sau đó đăng nhập đúng. Tài khoản phải hiện tên và danh sách xe từ `/me`; tài khoản mới có thể chưa có xe.
2. Bấm **Tải lại hồ sơ**. Ngắt backend local hoặc tunnel rồi tải lại để kiểm tra lỗi kết nối và việc giữ hồ sơ đã tải. Khôi phục kết nối rồi thử lại.
3. Để kiểm tra refresh, chờ access token hết hạn (900 giây từ khi cấp), giữ app chạy rồi bấm **Tải lại hồ sơ**. Nếu refresh token còn hợp lệ, app lấy access token mới và đọc lại hồ sơ. Đăng xuất hoặc đóng hẳn app rồi mở lại để kiểm tra yêu cầu đăng nhập lại.
4. Để thử đăng ký trên staging, đặt `API_CONSENT_VERSION` là `wp3-test-v1` trong `config/api.local.json`, rồi Stop/Run lại. Chọn **Đăng ký**, kiểm tra ô đồng ý mặc định chưa chọn, đọc nội dung rồi chủ động chọn đồng ý. Điền họ tên, email test chưa dùng, mật khẩu 8–128 ký tự và nhập lại mật khẩu. Tạo thành công sẽ mở **Tài khoản** sau khi tải `/me`. Đăng xuất rồi dùng email và mật khẩu vừa tạo để đăng nhập lại. Staging lưu tài khoản test thật. Backend chưa tạo xe ở bước này.

`wp3-test-v1` ghi nhận nội dung **Quyền riêng tư của bạn** ở chế độ API trong [OnboardingScreen](../lib/features/auth/presentation/onboarding_screen.dart): thông tin tài khoản và xe phục vụ dịch vụ sạc, dữ liệu phiên sạc, thanh toán và tín dụng phục vụ vận hành, đối soát và hỗ trợ tài khoản. Tài xế có thể xem hồ sơ trong Tài khoản và phải tích ô đồng ý xử lý dữ liệu cho các mục đích được nêu. Đây là phiên bản dùng cho kiểm thử staging. Khi cấu hình production, dùng phiên bản tương ứng với nội dung chính sách production. Để trống hoặc bỏ trường cấu hình sẽ ẩn Đăng ký.

## 4. Kiểm thử xe qua tunnel API

1. Giữ [tunnel hiện tại](api-tunnel.md) và `config/api.local.json` hiện có. Chọn Android Emulator rồi chạy `lib/main.dart` với cấu hình đang dùng.
2. Đăng nhập bằng tài khoản Driver test chưa có xe hoặc tạo tài khoản test nếu cấu hình consent hiện tại đã mở đăng ký. Xác nhận **Tài khoản → Xe của tôi** báo danh sách trống.
3. Bấm **Thêm xe**, chọn một mẫu từ danh mục, nhập biển số test chưa dùng và bấm **Lưu xe**. Kiểm tra biển số theo dạng server trả, chuẩn cổng và **Xe mặc định** trên xe đầu tiên.
4. Thêm xe thứ hai, để app mở hơn 900 giây, rồi bấm **Đặt mặc định**. Kiểm tra thao tác thành công ngay lần bấm đầu nếu phiên làm mới còn hiệu lực. Gỡ xe mặc định và xác nhận xe còn lại trở thành mặc định. Gỡ xe cuối rồi tải lại hồ sơ để kiểm tra danh sách trống.
5. Nếu mất kết nối khi thêm xe và kết quả chưa rõ, kết nối lại và chọn **Tải lại hồ sơ**. Kiểm tra app vẫn ở form và giữ biển số, mẫu xe, lựa chọn mặc định và bộ lọc. Đối chiếu danh sách xe trước khi thử lưu lại. Nếu nhận lỗi biển đã đăng ký, kiểm tra lỗi chỉ hiện trên form vừa gửi.

## 5. Kiểm thử tìm trạm và gợi ý trên emulator

1. Đăng nhập bằng tài khoản Driver test đã có xe mặc định. App mở **Khám phá**. Nếu chưa có xe, chọn **Thêm xe** từ Khám phá. Nếu đã có xe nhưng thiếu mặc định, chọn xe trong Tài khoản.
2. Tìm theo tên hoặc địa chỉ trạm, thử từ khóa tiếng Việt có dấu và không dấu. Dùng các chip tình trạng cổng và mục **Điểm đi và bộ lọc** để tùy chọn hiện trạm chỉ dành cho VinFast với xe khác hãng. Khi có hơn 20 kết quả, dùng **Trang sau** và **Trang trước**. Đổi giữa **Bản đồ** và **Danh sách** để kiểm tra giữ từ khóa, bộ lọc và trang. Bấm nút xóa từ khóa để về trang đầu. Bộ lọc tình trạng áp dụng ở cấp trạm theo hợp đồng. Chi tiết hiện mọi cổng tương thích backend trả về, kể cả trạng thái đã báo và thông tin khả dụng hiện tại.
3. Chọn **Dùng vị trí của tôi** để xin quyền foreground. Có thể từ chối và tiếp tục tìm theo tên. Với **Chọn địa chỉ**, bấm **Tìm địa chỉ** để gửi từ khóa qua PowerMe đến Vietmap, rồi xác nhận một mục để lấy tọa độ. **Bỏ điểm đi** xóa tọa độ khỏi các truy vấn tiếp theo.
4. Bấm **Gợi ý** trong Khám phá. Màn chỉ hỏi **Pin hiện tại (%)** và cho phép để trống. Thử `0` và `25,5` với điểm đi đã chọn, rồi bấm **Xem gợi ý** sau khi đọc thông báo Vietmap. Kiểm cổng đề xuất, thời gian chờ/sạc, chi phí ước tính và thông tin đường bộ nếu có. Bỏ trống pin hoặc điểm đi để xem danh sách trạm phù hợp kèm lý do thiếu ước tính. Thử `80` và `100` để kiểm số nhập còn nguyên và lý do pin đã đạt 80%; khi để trống hoặc pin từ 80% trở lên, thông báo Vietmap ẩn. Nhập ngoài khoảng 0–100% để kiểm lỗi tại chỗ. Dùng nút trên thẻ và xác nhận để lấy tuyến riêng.
5. Với cấu hình **Vietmap Tile** hợp lệ trong `config/vietmap.local.json`, bản đồ tự hiện khi mở **Khám phá**. Chọn trạm từ kết quả hoặc pin. Trong chi tiết, chọn **Xem đường đi** khi đã có điểm đi. Kiểm quãng đường, ETA, dải tuyến và chú giải trong khung bản đồ. Nếu thiếu Tile, tóm tắt tuyến và chỉ dẫn có sẵn vẫn dùng được. Nếu backend chưa cấu hình dịch vụ Search/Route hoặc provider lỗi, app hiện lỗi và cho thử lại.
6. Đổi xe mặc định hoặc đăng xuất rồi đăng nhập lại. Kiểm điểm đi, chi tiết đã chọn và kết quả cũ được bỏ.

## 6. Kiểm thử tra mã cổng trên thiết bị

1. Đăng nhập bằng tài khoản có xe mặc định. Kiểm thứ tự **Khám phá / Quét QR / Tài khoản**, rồi mở **Quét QR**.
2. Dùng mã của trụ thử nghiệm tương thích. Quét `powerme:connector:<display_code>/<connector_no>` hoặc nhập `<display_code>/<connector_no>`, với số cổng 1 hoặc 2. Kiểm tên trạm, mã trụ, số cổng và trạng thái báo về.
3. Từ chối quyền camera và tra lại bằng nhập tay. Thử mã sai, cổng không tương thích và mất kết nối, rồi nhập lại hoặc chọn **Quét lại**. Kiểm rằng xác nhận bắt đầu sạc không xuất hiện.

## Hợp đồng và ranh giới

- Nguồn ở `508fd0e9636982f36ce76a1df1fcb25656e4e27f`: [Driver HTTP](https://github.com/PowerMeApp/powerme/blob/508fd0e9636982f36ce76a1df1fcb25656e4e27f/apps/csms/src/driver/driver.http.ts), [DriverAccounts](https://github.com/PowerMeApp/powerme/blob/508fd0e9636982f36ce76a1df1fcb25656e4e27f/apps/csms/src/driver/driver-account.ts), [charges HTTP](https://github.com/PowerMeApp/powerme/blob/508fd0e9636982f36ce76a1df1fcb25656e4e27f/apps/csms/src/driver/charges.http.ts), [OpenAPI](https://github.com/PowerMeApp/powerme/blob/508fd0e9636982f36ce76a1df1fcb25656e4e27f/docs/api/driver-api.openapi.yaml).
- `POST /auth/login`, `POST /auth/register` và `POST /auth/refresh` gửi JSON và không gắn Bearer. `GET /me` dùng access Bearer và không truyền user ID. ID đến từ `/me` và giữ kiểu chuỗi. Payload `/me` không chứa email. App không lấy email đã nhập để điền hồ sơ. Trường số xe nullable được kiểm kiểu theo hợp đồng. Hồ sơ dùng tên mẫu xe, biển số, cổng và cờ mặc định. Form thêm xe hiển thị dung lượng pin, tầm hoạt động, công suất DC tối đa và cổng sạc của mẫu đã chọn từ `GET /vehicle-models`.
- Token và snapshot nằm trong bộ nhớ. Refresh chỉ thay access token, giữ refresh token ban đầu với thời hạn do server quản lý. Một nhóm GET 401 chia sẻ một refresh đang chạy và từng GET được thử lại tối đa một lần. 401 cuối hoặc 403 hủy scope. Lỗi mạng khi đã vào tài khoản giữ snapshot trước và hiện nút tải lại. Logout hủy I/O đang chờ, xóa token/snapshot, và vô hiệu kết quả từ phiên cũ. Backend chưa có thu hồi từng refresh token.
- API mode mở auth, tài khoản, quản lý xe, Khám phá, gợi ý, chi tiết trạm và tra mã QR. Sau đăng nhập mặc định vào Khám phá. App chuyển sang đăng nhập khi bị chặn hoặc phiên hết hạn. Nếu POST đăng ký có kết quả chưa rõ, UI hướng dẫn thử đăng nhập trước khi gửi lại.
- Quét QR và nhập tay gọi `GET /connectors/by-code/{displayCode}/{connectorNo}?vehicle_id=…` với Bearer và xe mặc định thuộc hồ sơ hiện tại. Kiểm tra quyền và tương thích ở backend. Xem [OpenAPI](../../../docs/api/driver-api.openapi.yaml), [Driver HTTP](../../csms/src/driver/driver.http.ts) và [resolver](../../csms/src/sessions/driver-charging.service.ts).
- BE-34 tại `92af36653c6f6e363f6344017b871d5a2e708d4d` triển khai GET danh mục, POST thêm, PATCH chỉ `is_default: true` và DELETE 204. App đọc lại `/me` sau thành công và dùng dữ liệu server cho xe mặc định. Giới hạn client với biển ASCII theo `normalizePlate` thực tế (tối đa 64 ký tự thô, 12 ký tự sau chuẩn hóa, ít nhất 5 chữ/số). Server chuẩn hóa NFKC, kiểm tra đầu vào Unicode và so trùng. Xem [handler](../../csms/src/driver/vehicles.http.ts), [integration tests](../../csms/test/driver-vehicles.integration.test.ts) và [OpenAPI](../../../docs/api/driver-api.openapi.yaml).
- Tìm trạm dùng `GET /stations` với `q`, xe mặc định, bộ lọc, mỗi trang 20 trạm và giới hạn `page ≤ 100000` theo hợp đồng. Gợi ý dùng cùng endpoint với `sort=smart`, `page=1`, `page_size=3`. App hiển thị thứ tự backend, chọn `best_connector_id` trong từng trạm và trình bày các ước tính do backend trả. Khi thiếu pin/vị trí/thông số xe, server sắp theo khoảng cách nếu có điểm đi hoặc theo tên nếu không có. Kết quả dự phòng trong bán kính ngầm theo chính sách MB03, hiện không có cờ riêng trong response. Xem [station search source](../../csms/src/sessions/station-search.ts) và [OpenAPI](../../../docs/api/driver-api.openapi.yaml).
- ApiApp gửi `target_soc_percent=80` làm mốc ước tính. `soc_percent` chỉ được gửi khi pin hợp lệ và dưới 80%. Pin bỏ trống hoặc từ 80% trở lên vẫn dùng điểm đi nếu có để CSMS sắp trạm phù hợp theo khoảng cách, bỏ `location_consent`. Với pin hợp lệ dưới 80%, app gửi `location_consent=true` khi người lái bấm **Xem gợi ý** với điểm đi đang chọn.
- Tìm địa chỉ dùng `GET /places/autocomplete` theo lần bấm, không gửi tọa độ định hướng. `GET /places/resolve` chỉ chạy sau xác nhận, dùng `ref_id` và `location_consent=true`. Route chỉ gọi `GET /stations/{site_id}/route` sau khi chọn trạm, có điểm đi và bấm xem đường. Provider chỉ dùng cho địa chỉ và tuyến đã chọn. App nhận `LineString` GeoJSON, chuyển từ [kinh độ, vĩ độ] sang tọa độ địa lý để vẽ. API trả chất lượng giao thông unknown. Link chi tiết trực tiếp chỉ phục hồi được trạm đã chọn trong phiên và xe hiện tại vì hợp đồng chưa có endpoint đọc chi tiết theo ID. [Road HTTP](../../csms/src/driver/road.http.ts).

## Nghiên cứu trước triển khai

### Xem trước chỉ dẫn và giao thông từng đoạn

- Driver API có thể bổ sung `instructions`, `traffic_segments` và `congested_distance_m` cho tuyến; `road_estimate` của gợi ý có thể kèm `congested_distance_m`. Giữ trường cũ `traffic_quality: unknown` để tương thích. Flutter đọc metadata tùy chọn và không tự gọi Route v4, suy ra mật độ giao thông hoặc xếp hạng. Quãng đường và ETA dùng dữ liệu tuyến. Thiếu dữ liệu ùn tắc không được hiểu là 0.
- Khoảng chỉ số bao gồm hai đầu và có thể nối ở một điểm chung. Một chỉ dẫn có thể neo tại một điểm. Đoạn giao thông phải có ít nhất một cạnh. Dải ngoài hình học hoặc chồng lấn khiến app bỏ mảng tương ứng. Đoạn thiếu dữ liệu dùng màu xám, đi chậm dùng vàng, ùn tắc dùng đỏ và ít ùn tắc dùng teal. Chú giải theo màu xuất hiện ngay dưới bản đồ trong cùng khung.
- Trên thiết bị, chọn **Xem đường đi**, đối chiếu dải tuyến với chú giải rồi bấm **Bắt đầu xem trước**. Qua từng chặng bằng **Chặng trước** và **Chặng tiếp**, kiểm biểu tượng rẽ tại điểm đầu của khoảng chỉ số và cờ ở chặng đến nơi. **Kết thúc** đưa bản đồ về khung toàn tuyến. Khi đổi điểm đi, bản xem trước cũ đóng. Nếu Tile lỗi, vẫn đọc được quãng đường, ETA và từng chặng có sẵn. Khoảng cách chỉ dẫn là chiều dài từ đầu chặng tới chỉ dẫn tiếp theo.
- Đã đối chiếu ví dụ `addPolyline` với `controller.dart`, `annotation_manager.dart` và interface của Vietmap Flutter GL 4.1.1 (BSD-3-Clause). PowerMe dùng `addPolylines` cho tuyến đã có và `addImage`/`addSymbol` cho biểu tượng theo chặng. Flutter Navigation SDK cung cấp sự kiện `onRouteProgressChange` cho hành trình thực và cần plugin native cùng khóa riêng. Bản xem trước thủ công dùng dependency GL hiện có và dữ liệu từ Driver API. Các test trong gói GL chỉ có khung iOS. PowerMe tự viết mã, kiểm bằng fixture Driver API và để phần hiển thị native cho smoke trên thiết bị. [Route v4](https://maps.vietmap.vn/docs/vi/map-api/route-version/route-v4/) · [Mã hướng rẽ](https://maps.vietmap.vn/docs/assets/agents/routing.txt) · [Ví dụ vẽ tuyến](https://github.com/vietmap-company/flutter-navigation-example/blob/dev/lib/features/map_screen/maps_screen.dart#L151-L157) · [GL 4.1.1](https://pub.dev/packages/vietmap_flutter_gl/versions/4.1.1) · [Navigation SDK](https://maps.vietmap.vn/docs/sdk-mobile/Flutter/navigation/) · [Ví dụ Navigation SDK](https://pub.dev/packages/vietmap_flutter_navigation/example)

Dio `5.9.2` đã có trong cache cục bộ và là dependency trực tiếp duy nhất bổ sung. So sánh hai cách dùng cùng transport, theo nguồn cfug/dio được coordinator ghim ở `f1bef462289b40992d625d4eb2a2f42321217573`:

| Cách dùng | Fit, chi phí và đánh đổi |
| --- | --- |
| `QueuedInterceptorsWrapper` với lần refresh trong `onError` | Ví dụ và test upstream cho thấy cách so token của request cũ, tuần tự hóa xử lý lỗi và tránh refresh trùng. Áp dụng toàn client thuận tiện cho nhiều route, nhưng cần loại auth requests/mutations, quản lý queue và đảm bảo không đệ quy. Ví dụ in headers, dữ liệu và lịch sử token. |
| Dio với điều phối tại protected read | Chỉ có một protected route trong slice. Future refresh chung theo phiên, cancel token và so token cũ giải quyết cạnh tranh mà không serialize mọi GET. Chi phí là mỗi protected route tương lai cần đi qua luồng có guard. Điều phối hẹp để không retry POST hoặc ghi credential. |

Tham khảo [queued example](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/example_dart/lib/queued_interceptor_crsftoken.dart), [interceptor tests](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/dio/test/interceptor_test.dart), [adapter source](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/dio/lib/src/adapter.dart) và [MIT license](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/dio/LICENSE). Đối chiếu source example, adapter và test trên main công khai, cùng license/package cache của 5.9.2. Mượn ý so token cũ và inject adapter, tự viết luồng phiên và fixture theo PowerMe. Không copy code mẫu hoặc sinh client. Giữ [notices](../THIRD_PARTY_NOTICES.md).

Slice xe dùng source và test Flutter trong SDK 3.44.2 đã cài, ghim `c9a6c484230f8b5e408ec57be1ef71dee1e77020`, [BSD-3-Clause](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/LICENSE). `DropdownButtonFormField<String>` dùng ID làm value và tích hợp `Form.validate` với ít state, đổi lại không lọc bằng bàn phím. `DropdownMenu` hỗ trợ lọc theo nhãn và hữu ích cho danh mục dài, cần quản lý thêm text/selection để chữ gõ không thành giá trị gửi. Cả hai có sẵn trong Material. Chọn form field và áp dụng kiểm tra chọn mục/thiếu mục theo nguồn, dùng code PowerMe và giữ xác thực mẫu xe tại backend. [Dropdown form source](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/material/dropdown.dart), [form tests](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/material/dropdown_form_field_test.dart), [filter source](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/material/dropdown_menu.dart), [filter tests](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/material/dropdown_menu_test.dart).

Restyle danh mục dùng cùng bản Flutter `c9a6c484230f8b5e408ec57be1ef71dee1e77020` và giấy phép BSD-3-Clause. So với `DropdownButtonFormField`, `ChoiceChip` hiển thị bộ lọc hãng ngay trên form và phù hợp với một hãng đang chọn. `FilterChip` dành cho nhiều lựa chọn. Thẻ mẫu xe cho phép đọc lựa chọn và thông số trong cùng màn hình, đổi lại cần giữ ID và kiểm tra danh mục trước khi gửi. Cả ba widget có sẵn trong Flutter. App dùng widget và API có sẵn, giữ kiểm tra mẫu xe ở backend và tự viết phần lọc theo dữ liệu PowerMe. [ChoiceChip source](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/material/choice_chip.dart), [ChoiceChip tests](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/material/choice_chip_test.dart), [FilterChip source](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/material/filter_chip.dart), [FilterChip tests](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/material/filter_chip_test.dart).

## Ảnh mẫu xe BE-38

OpenAPI 0.11.0 trả `image_url` và `image_credit` nullable trong danh mục, `/me` và kết quả POST/PATCH. Sau thao tác xe, app vẫn đọc lại `/me` để lấy hồ sơ đã xác nhận. URL seed dùng `commons.wikimedia.org/wiki/Special:FilePath` và có thể chuyển hướng tới `thumb.wikimedia.org` hoặc `upload.wikimedia.org`. Xem [hợp đồng BE-38](https://github.com/PowerMeApp/powerme/blob/e5d55e48ef1f2d8665637fda0b9a4f3ebd96ac7b/docs/api/DRIVER-API-HOP-DONG.md#L288-L293) và [seed](https://github.com/PowerMeApp/powerme/blob/e5d55e48ef1f2d8665637fda0b9a4f3ebd96ac7b/apps/csms/demo/seed-app.sql#L124-L141).

Flutter `Image.network` chuyển headers tùy chọn vào `NetworkImage`, hỗ trợ callback ảnh mặc định và tái sử dụng cache ảnh. Dùng widget có sẵn giúp tách tải ảnh công khai khỏi Dio giữ token, tránh thêm dependency hoặc tự quản lý cache ảnh. Đã đối chiếu [widget source](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/widgets/image.dart), [headers của NetworkImage](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/painting/_network_image_io.dart), [test fallback](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/widgets/image_test.dart) và [giấy phép BSD-3-Clause](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/LICENSE).

Khi smoke, mở nhà xe, chi tiết, quản lý và preview mẫu xe có ảnh. Kiểm tra ảnh và dòng ghi công nguyên văn. Chọn thêm mẫu chưa có ảnh để kiểm tra ảnh minh họa mặc định. Gỡ xe và đặt mặc định chỉ gửi request sau xác nhận.

## Nghiên cứu T96 discovery

T96 discovery dùng các gói đã khóa. Dio 5.9.2 (MIT, SHA-256 trong lockfile `aff32c08…`) được đối chiếu với `lib/src/dio_mixin.dart`, `lib/src/options.dart`, `test/cancel_token_test.dart` và `test/options_test.dart` trong cache. Query map đi qua Dio và cùng luồng Bearer/refresh/cancel của Driver API. Vietmap Flutter GL 4.1.1 (BSD-3-Clause, `f4bab17b…`) được đối chiếu với controller `addPolyline`, ví dụ `animate_camera.dart` và platform interface `PolylineOptions.geometry`. Gói phát hành chỉ có test iOS khung, không có test route thực. Native Tile dùng lại symbol/camera và geometry từ backend. Phương án gọi Search/Route trực tiếp trong ứng dụng mẫu sẽ đưa thông tin xác thực provider xuống client và bỏ qua kiểm tra xe của CSMS. Phương án dùng Driver API giữ kiểm tra quyền ở server và dùng dependency hiện có. Không sao chép source upstream. [Dio 5.9.2](https://pub.dev/packages/dio/versions/5.9.2), [Vietmap Flutter GL 4.1.1](https://pub.dev/packages/vietmap_flutter_gl/versions/4.1.1), [notices](../THIRD_PARTY_NOTICES.md).

Người kiểm tra đã đối chiếu ví dụ Vietmap tại commit MIT `6f1d792dd48c97a3d7fabec8c44f384b48a088dd`. Màn mẫu tạo VietmapGL từ Tile style và thêm polyline qua native controller. Repository mẫu gọi thẳng provider. Widget test mẫu chỉ kiểm counter. [Map screen](https://github.com/vietmap-company/flutter-navigation-example/blob/6f1d792dd48c97a3d7fabec8c44f384b48a088dd/lib/features/map_screen/maps_screen.dart), [API repository](https://github.com/vietmap-company/flutter-navigation-example/blob/6f1d792dd48c97a3d7fabec8c44f384b48a088dd/lib/data/repository/vietmap_api_repository.dart), [widget test](https://github.com/vietmap-company/flutter-navigation-example/blob/6f1d792dd48c97a3d7fabec8c44f384b48a088dd/test/widget_test.dart), [license](https://github.com/vietmap-company/flutter-navigation-example/blob/6f1d792dd48c97a3d7fabec8c44f384b48a088dd/LICENSE).

## Bằng chứng local

Flutter 3.44.2 trên SDK/cache có sẵn ở E. `dart format --output=none --set-exit-if-changed lib test` kiểm 118 file, 0 thay đổi. `flutter analyze --no-pub` sạch. `flutter test --no-pub` đạt 127/127, trong đó nhóm startup/discovery riêng đạt 14/14. Widget test kiểm vị trí map trong layout và geometry truyền vào VietmapSurface. Hiển thị native Tile/polyline cần smoke trên emulator. Log `t96-discovery-*-final.log` nằm trong `.review` của workspace.

Kiểm backend riêng do người điều phối chạy bằng Node 24 trên Postgres nhúng riêng. Năm suite đạt 130 test gồm 35 discovery, 57 smart, 20 auth, 6 charges và 12 vehicles. Người điều phối cũng xác nhận tunnel staging trả health 200 và GET stations, places, route thiếu Bearer trả 401. Kiểm mobile tự động dùng transport fixture. Smoke đã đăng nhập, quyền hệ điều hành và hiển thị Tile/polyline trên emulator cần xác nhận riêng.

Người dùng đã xác nhận đăng nhập, đăng xuất và đăng ký trên staging. Sau xác nhận, fake auth và cấu hình ghép các màn chưa tích hợp được chuyển vào `test/support`, rồi bỏ entrypoint chạy preview.

Trong lần kiểm tra trước, Flutter format kiểm 104 file, không cần định dạng lại. Full suite qua 96/96 trên checkout chính. Sau khi sửa lint constructor, analyze sạch và 11/11 test API/widget qua lại. Các test thay transport Dio bằng fixture trong tiến trình và kiểm hợp đồng phía Flutter cùng giao diện.

Trong lần build trước, Gradle `--offline :app:assembleDebug` chạy thành công với URL emulator. Kiểm APK xác nhận Android và Flutter cùng tham chiếu cấu hình debug có ba host tunnel. Build còn cảnh báo Kotlin Gradle Plugin của Vietmap.
