# Dùng Driver API trên VM qua SSH tunnel

## Chuẩn bị và mở tunnel

- Sau khi PR tích hợp được merge, người quản lý VM tạo cấu hình JWT phía backend, seed dữ liệu, thiết lập tunnel dev và tạo tài khoản PostgreSQL `app_dev` cho DB `powerme`.
- Dùng lệnh SSH do người quản lý VM cấp. Mobile cần forward cổng API `3000` trên loopback của máy Windows (`127.0.0.1`). Forward PostgreSQL `5433` dành riêng cho công cụ DB được cấp quyền. Không bind `0.0.0.0` hoặc mở cổng ra LAN.
- Chỉ gửi khóa công khai `id_ed25519.pub` cho quản trị viên được chỉ định. Giữ khóa riêng `id_ed25519` trên máy. Nếu chưa có cặp khóa, người dùng có thể chạy `ssh-keygen -t ed25519`; không ghi đè khóa hiện có.
- Nếu cổng local `3000` đang bận, hỏi trước khi dừng tiến trình đang dùng cổng. Nếu đổi cổng, thống nhất lại lệnh forward với người quản lý VM và cập nhật URL API tương ứng trên Windows và emulator.
- **Cấm chạy CSMS local thứ hai trỏ vào DB staging.** Hai CSMS dùng chung DB có thể chạy trùng bộ hẹn giờ, quyết toán hoặc tác vụ demo.

## Driver API từ Windows và Android Emulator

| Nơi gọi | URL gốc của Driver API |
| --- | --- |
| Máy Windows chạy tunnel | `http://127.0.0.1:3000/api/driver/v1` |
| Android Emulator trên máy đó | `http://10.0.2.2:3000/api/driver/v1` |

- Đặt URL phù hợp trong `API_BASE_URL` tại `apps/mobile/config/api.local.json`. Nếu đổi thiết bị hoặc cổng forward, sửa file rồi Stop/Run lại `lib/main.dart`. [Hướng dẫn chạy T96](t96-driver-api.md).
- `10.0.2.2` chỉ dành cho Android Emulator. Thiết bị thật cần phương án kết nối riêng được thống nhất với người quản lý VM.
- Flutter chỉ gọi API nghiệp vụ. Với request cần xác thực, gửi `Authorization: Bearer <access_token>` bằng JWT nhận từ đăng nhập. Secret ký JWT chỉ ở backend. Xem [hợp đồng Driver API](../../../docs/api/DRIVER-API-HOP-DONG.md).
- HTTP qua tunnel chỉ dùng cho phát triển. Không bỏ qua xác minh chứng chỉ hoặc bật cleartext toàn cục.
- Khi tunnel mất kết nối, xử lý như lỗi kết nối và thử lại sau khi tunnel được khôi phục. Không tự chuyển sang CSMS local hoặc mock.
- Giữ cấu hình Vietmap hiện hành cho Tile/vị trí và phạm vi backend Search/Place/Route của trạm đã chọn. Xem [thiết lập Vietmap](vietmap-setup.md).

## PostgreSQL chỉ dành cho công cụ quản trị

```text
DATABASE_URL=postgres://app_dev:<private-password>@127.0.0.1:5433/powerme
```

- Chỉ dùng URL này trong công cụ DB hoặc kết nối quản trị backend trên máy làm việc. Giữ mật khẩu riêng tư. Không đưa `DATABASE_URL` vào env, build, assets của Flutter hoặc kết nối trực tiếp từ app đến DB.
- Mặc định chỉ đọc. Chỉ ghi thủ công đúng bản ghi và phạm vi đã được cấp quyền. Không reset, migrate, seed hoặc chạy test trên DB dùng chung. Thao tác nghiệp vụ đi qua API, không lặp lại bằng SQL.
