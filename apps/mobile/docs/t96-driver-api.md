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
& E:/MobileDev/Flutter/bin/flutter.bat run -t lib/main.dart
```

- HTTP debug chỉ chấp nhận `localhost`, `127.0.0.1` và `10.0.2.2`. Thiết bị Android thật cần URL HTTPS mà thiết bị truy cập được. Profile/release yêu cầu HTTPS và xác minh TLS mặc định.
- Thiếu file, URL rỗng hoặc cấu hình sai sẽ hiện lỗi kết nối. Stop/Run lại sau khi sửa file. File local được Git bỏ qua nhưng vẫn đóng gói vào app. Chỉ để URL và phiên bản consent công khai trong đó.
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
4. Thêm xe thứ hai, bấm **Đặt mặc định** trên xe đó, rồi **Gỡ xe** và xác nhận. Kiểm tra xe đầu tiên trở lại mặc định. Gỡ xe cuối và xác nhận danh sách trống. Sau đó bấm **Tải lại hồ sơ** để đối chiếu.
5. Nếu mất kết nối khi lưu/gỡ, kết nối lại và dùng **Tải lại hồ sơ** để kiểm tra kết quả trước khi thử lại. Nếu nhập lại biển đang đăng ký, UI hiện lỗi biển đã được đăng ký và giữ form.

## Hợp đồng và ranh giới

- Nguồn ở `508fd0e9636982f36ce76a1df1fcb25656e4e27f`: [Driver HTTP](https://github.com/PowerMeApp/powerme/blob/508fd0e9636982f36ce76a1df1fcb25656e4e27f/apps/csms/src/driver/driver.http.ts), [DriverAccounts](https://github.com/PowerMeApp/powerme/blob/508fd0e9636982f36ce76a1df1fcb25656e4e27f/apps/csms/src/driver/driver-account.ts), [charges HTTP](https://github.com/PowerMeApp/powerme/blob/508fd0e9636982f36ce76a1df1fcb25656e4e27f/apps/csms/src/driver/charges.http.ts), [OpenAPI](https://github.com/PowerMeApp/powerme/blob/508fd0e9636982f36ce76a1df1fcb25656e4e27f/docs/api/driver-api.openapi.yaml).
- `POST /auth/login`, `POST /auth/register` và `POST /auth/refresh` gửi JSON và không gắn Bearer. `GET /me` dùng access Bearer và không truyền user ID. ID đến từ `/me` và giữ kiểu chuỗi. Payload `/me` không chứa email. App không lấy email đã nhập để điền hồ sơ. Trường số xe nullable được kiểm kiểu theo hợp đồng. Hồ sơ dùng tên mẫu xe, biển số, cổng và cờ mặc định. Form thêm xe hiển thị dung lượng pin, tầm hoạt động, công suất DC tối đa và cổng sạc của mẫu đã chọn từ `GET /vehicle-models`.
- Token và snapshot nằm trong bộ nhớ. Refresh chỉ thay access token, giữ refresh token ban đầu với thời hạn do server quản lý. Một nhóm GET 401 chia sẻ một refresh đang chạy và từng GET được thử lại tối đa một lần. 401 cuối hoặc 403 hủy scope. Lỗi mạng khi đã vào tài khoản giữ snapshot trước và hiện nút tải lại. Logout hủy I/O đang chờ, xóa token/snapshot, và vô hiệu kết quả từ phiên cũ. Backend chưa có thu hồi từng refresh token.
- API mode giới hạn ở auth, tài khoản và xe. Tài khoản chuyển sang đăng nhập khi bị chặn hoặc phiên hết hạn. Nếu POST đăng ký có kết quả chưa rõ, UI hướng dẫn thử đăng nhập trước khi gửi lại. Client chỉ gọi Driver API.
- BE-34 tại `92af36653c6f6e363f6344017b871d5a2e708d4d` triển khai GET danh mục, POST thêm, PATCH chỉ `is_default: true` và DELETE 204. App đọc lại `/me` sau thành công và dùng dữ liệu server cho xe mặc định. Giới hạn client với biển ASCII theo `normalizePlate` thực tế (tối đa 64 ký tự thô, 12 ký tự sau chuẩn hóa, ít nhất 5 chữ/số). Server chuẩn hóa NFKC, kiểm tra đầu vào Unicode và so trùng. Xem [handler](../../csms/src/driver/vehicles.http.ts), [integration tests](../../csms/test/driver-vehicles.integration.test.ts) và [OpenAPI](../../../docs/api/driver-api.openapi.yaml).

## Nghiên cứu trước triển khai

Dio `5.9.2` đã có trong cache cục bộ và là dependency trực tiếp duy nhất bổ sung. So sánh hai cách dùng cùng transport, theo nguồn cfug/dio được coordinator ghim ở `f1bef462289b40992d625d4eb2a2f42321217573`:

| Cách dùng | Fit, chi phí và đánh đổi |
| --- | --- |
| `QueuedInterceptorsWrapper` với lần refresh trong `onError` | Ví dụ và test upstream cho thấy cách so token của request cũ, tuần tự hóa xử lý lỗi và tránh refresh trùng. Áp dụng toàn client thuận tiện cho nhiều route, nhưng cần loại auth requests/mutations, quản lý queue và đảm bảo không đệ quy. Ví dụ in headers, dữ liệu và lịch sử token. |
| Dio với điều phối tại protected read | Chỉ có một protected route trong slice. Future refresh chung theo phiên, cancel token và so token cũ giải quyết cạnh tranh mà không serialize mọi GET. Chi phí là mỗi protected route tương lai cần đi qua luồng có guard. Điều phối hẹp để không retry POST hoặc ghi credential. |

Tham khảo [queued example](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/example_dart/lib/queued_interceptor_crsftoken.dart), [interceptor tests](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/dio/test/interceptor_test.dart), [adapter source](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/dio/lib/src/adapter.dart) và [MIT license](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/dio/LICENSE). Đối chiếu source example, adapter và test trên main công khai, cùng license/package cache của 5.9.2. Mượn ý so token cũ và inject adapter, tự viết luồng phiên và fixture theo PowerMe. Không copy code mẫu hoặc sinh client. Giữ [notices](../THIRD_PARTY_NOTICES.md).

Slice xe dùng source và test Flutter trong SDK 3.44.2 đã cài, ghim `c9a6c484230f8b5e408ec57be1ef71dee1e77020`, [BSD-3-Clause](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/LICENSE). `DropdownButtonFormField<String>` dùng ID làm value và tích hợp `Form.validate` với ít state, đổi lại không lọc bằng bàn phím. `DropdownMenu` hỗ trợ lọc theo nhãn và hữu ích cho danh mục dài, cần quản lý thêm text/selection để chữ gõ không thành giá trị gửi. Cả hai có sẵn trong Material. Chọn form field và áp dụng kiểm tra chọn mục/thiếu mục theo nguồn, dùng code PowerMe và giữ xác thực mẫu xe tại backend. [Dropdown form source](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/material/dropdown.dart), [form tests](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/material/dropdown_form_field_test.dart), [filter source](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/material/dropdown_menu.dart), [filter tests](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/material/dropdown_menu_test.dart).

Restyle danh mục dùng cùng bản Flutter `c9a6c484230f8b5e408ec57be1ef71dee1e77020` và giấy phép BSD-3-Clause. So với `DropdownButtonFormField`, `ChoiceChip` hiển thị bộ lọc hãng ngay trên form và phù hợp với một hãng đang chọn. `FilterChip` dành cho nhiều lựa chọn. Thẻ mẫu xe cho phép đọc lựa chọn và thông số trong cùng màn hình, đổi lại cần giữ ID và kiểm tra danh mục trước khi gửi. Cả ba widget có sẵn trong Flutter. App dùng widget và API có sẵn, giữ kiểm tra mẫu xe ở backend và tự viết phần lọc theo dữ liệu PowerMe. [ChoiceChip source](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/material/choice_chip.dart), [ChoiceChip tests](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/material/choice_chip_test.dart), [FilterChip source](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/material/filter_chip.dart), [FilterChip tests](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/material/filter_chip_test.dart).

## Bằng chứng local

Người dùng đã xác nhận đăng nhập, đăng xuất và đăng ký trên staging. Sau xác nhận, fake auth và cấu hình ghép các màn chưa tích hợp được chuyển vào `test/support`, rồi bỏ entrypoint chạy preview.

Trong lần kiểm tra trước, Flutter format kiểm 104 file, không cần định dạng lại. Full suite qua 96/96 trên checkout chính. Sau khi sửa lint constructor, analyze sạch và 11/11 test API/widget qua lại. Các test thay transport Dio bằng fixture trong tiến trình và kiểm hợp đồng phía Flutter cùng giao diện.

Trong lần build trước, Gradle `--offline :app:assembleDebug` chạy thành công với URL emulator. Kiểm APK xác nhận Android và Flutter cùng tham chiếu cấu hình debug có ba host tunnel. Build còn cảnh báo Kotlin Gradle Plugin của Vietmap.
