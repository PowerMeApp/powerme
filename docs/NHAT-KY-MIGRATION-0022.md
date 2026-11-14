# Nhật ký migration 0022 — `0022_anh-mau-xe.sql`

**Ngày:** 14/11/2026 · **Task:** BE-38 (WP2) · **Người chịu trách nhiệm:** Ngô Văn Minh Trí
**File:** `apps/csms/drizzle/0022_anh-mau-xe.sql` (áp lên DB đã có 0000 → 0021; một transaction `BEGIN … COMMIT`)
**Nguồn:** Sơn (app Flutter) báo màn "Xe của tôi" và "Thêm xe" chỉ hiện ô vuông trống vì Driver API không trả ảnh mẫu xe.

**Vì sao là 0022:** migration mới nhất trên `main` lúc làm là `0021_top-up-ipn-ngoai-le.sql` (T32 Phần 6, Khang). PR nào merge sau phải đổi số (tên file, hằng `M0022` trong `test/migration-0022.integration.test.ts`, nhật ký này).

## 1. Thay đổi

| #   | Đối tượng                          | Thay đổi                                                                                                            | Use case                                                                                                           |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | `vehicle_models.image_url text`    | Cột mới, nullable. CHECK `vehicle_models_image_url_check`: bắt đầu bằng `https://`, không khoảng trắng, ≤ 500 ký tự | Tài xế DS-01 mở "Xe của tôi": thấy ảnh chiếc VF 8 thay cho ô vuông trống (UC-ACC-03, màn hình 13)                  |
| 2   | `vehicle_models.image_credit text` | Cột mới, nullable. CHECK `vehicle_models_image_credit_check`: chỉ có khi có `image_url`, 1–200 ký tự                | Ảnh giấy phép CC BY-SA phải ghi tên tác giả và giấy phép khi hiển thị; app lấy dòng này từ API thay vì tự ghi cứng |
| 3   | COMMENT                            | hai cột mới                                                                                                         |                                                                                                                    |

**Không sửa / xoá dữ liệu cũ:** mọi mẫu xe đang có giữ nguyên, hai cột mới NULL. Ảnh do `demo/seed-app.sql` điền (chỉ khi mẫu xe chưa có ảnh, nên chạy lại seed không ghi đè ảnh đã đổi tay).

**Vì sao lưu URL, không lưu file ảnh:** Driver API trên staging chưa mở ra internet và mọi route của nó cần JWT; phục vụ ảnh qua API buộc app gắn `Authorization` vào từng lần tải ảnh và không dùng được bộ đệm ảnh mặc định. URL ngoài thì `Image.network` tải thẳng được. Đổi lại, ảnh phụ thuộc máy chủ ngoài: app phải có ảnh thay thế khi tải lỗi.

**Vì sao ép `https://`:** URL do DB trả về được app tải nguyên văn; chặn `http://`, `javascript:`, chuỗi rỗng và khoảng trắng ngay ở DB để một dòng nhập tay sai không thành lỗi hiển thị hay tải ảnh qua kênh không mã hoá.

## 2. Nguồn ảnh trong seed

8 mẫu xe của seed dùng ảnh trên Wikimedia Commons, tất cả giấy phép **CC BY-SA 4.0** (đã đọc qua API của Commons ngày 14/11/2026). URL dạng `https://commons.wikimedia.org/wiki/Special:FilePath/<tên file>?width=640`, trả 302 tới ảnh JPEG thu nhỏ. Đã tải thử cả 8 URL (HTTP 200, `image/jpeg`) và xem từng ảnh.

| Mẫu xe                  | File trên Commons                                   | Tác giả        |
| ----------------------- | --------------------------------------------------- | -------------- |
| VinFast VF 3            | `VinFast_VF_3_HCMC.jpg`                             | Vnsg304        |
| VinFast VF 5 Plus       | `2025_VinFast_VF_5_in_Vinfast_Blue,_front_left.jpg` | Ethan Llamas   |
| VinFast VF e34          | `2024_VinFast_VFe34,_06-14-2024.jpg`                | Ethan Llamas   |
| VinFast VF 8 Plus       | `VinFast_VF_8_DSC_8474.jpg` (nhìn từ phía sau)      | Alexander Migl |
| Hyundai Ioniq 5         | `Hyundai_Ioniq_5_IAA_2021_1X7A0189.jpg`             | Alexander Migl |
| BYD Atto 3              | `BYD_Atto_3_1X7A6495.jpg`                           | Alexander Migl |
| Nissan Leaf             | `Nissan_Leaf_(ZE1)_DSC_7096.jpg`                    | Alexander Migl |
| Wuling HongGuang MiniEV | `2021_Wuling_Hongguang_Mini_EV_side_trimmed.jpg`    | Lamva          |

Giới hạn: ảnh là ảnh chụp ngoài đường / triển lãm, không đồng bộ góc chụp và nền; ảnh có thể bị Commons đổi tên hoặc gỡ. Muốn bộ ảnh đồng bộ thì thay `image_url` bằng ảnh của nhóm (đặt `image_credit` NULL nếu không cần ghi công).

## 3. Hệ quả cho mã khác (sửa cùng PR)

- `src/driver/vehicles.http.ts`: `GET /vehicle-models` và `VEHICLE_JSON` (phần tử `vehicles[]` của `/me`, kết quả `POST` / `PATCH /vehicles`) trả thêm `image_url`, `image_credit`.
- `src/db/schema/sessions.ts`: hai cột và hai CHECK.
- `docs/api/driver-api.openapi.yaml` 0.11.0, `docs/api/DRIVER-API-HOP-DONG.md`, `docs/THIET-KE-CSDL-VAT-LY.md`.
- Thêm trường vào response là thay đổi tương thích ngược với app đang chạy (app bỏ qua trường lạ).

## 4. Cách kiểm

`test/migration-0022.integration.test.ts`: (1) DB trước 0022 có seed → migrate → 8 mẫu xe giữ nguyên từng cột, ảnh NULL → seed lại điền đủ 8 ảnh, chạy lần nữa không ghi đè ảnh đã đổi tay; (2) DB sạch → hai CHECK chặn `http://`, khoảng trắng, `javascript:`, chuỗi rỗng, URL dài hơn 500, ghi công không có ảnh, ghi công rỗng / dài hơn 200; (3) schema TS khớp DB. `test/driver-vehicles.integration.test.ts`: API trả đúng `image_url` / `image_credit` (có ảnh và `null`).
