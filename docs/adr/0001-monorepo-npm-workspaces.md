# ADR-0001 — Monorepo với npm workspaces

| | |
|---|---|
| Trạng thái | Chấp nhận |
| Ngày | 03/09/2026 |
| Người quyết định | WP1, WP2 |
| Liên quan | PM-01, BE-01 |

## Bối cảnh

Đồ án có ba đầu ra chạy được (CSMS, dashboard, app) cộng simulator và tài liệu, do năm người làm song song trong 13 tuần. Cả ba đầu ra viết bằng TypeScript — đây là lý do bộ công cụ được chốt là "một ngôn ngữ cho cả ba đầu ra".

Ràng buộc chi phối:

- **M3 (18/10) yêu cầu một mạch E2E liền** đi qua cả ba đầu ra. Lệch hợp đồng API giữa chúng là rủi ro trực tiếp lên cột mốc.
- Quỹ công sức là 132 ngày công. Không có chỗ cho việc nhân bốn lần cấu hình CI và đồng bộ type thủ công giữa các kho mã.
- Quy trình review yêu cầu **mỗi PR một approve từ người khác**. Người review cần thấy được thay đổi ở cả hai phía của một hợp đồng API trong cùng một PR.

## Quyết định

Dùng **một kho mã duy nhất** với npm workspaces:

```
apps/csms · apps/dashboard · apps/mobile · packages/shared · simulator · infra · docs
```

Kiểu dữ liệu và hợp đồng API dùng chung nằm ở `packages/shared`, định nghĩa **một lần**, ba đầu ra cùng import.

Ranh giới sở hữu giữa năm work package được thực thi bằng [CODEOWNERS](../../.github/CODEOWNERS) chứ không bằng ranh giới kho mã.

## Hệ quả

**Được:**

- Đổi hợp đồng API và cập nhật cả ba phía trong **một PR nguyên tử**. Không có cửa sổ thời gian mà backend và app nói hai thứ tiếng khác nhau.
- Một cấu hình CI, một `docker compose`, một lệnh `npm install` cho người mới vào.
- Review chéo giữa các WP dễ hơn — mọi thứ nằm trong một lần checkout.
- Một dòng lịch sử git duy nhất, thuận cho việc dựng lại tiến trình khi viết báo cáo.

**Mất:**

- CI chạy lâu hơn vì mặc định build cả workspace. Nếu vượt quá ~10 phút thì thêm lọc theo đường dẫn thay đổi.
- Quyền không tách được ở mức kho mã. Chấp nhận được: cả năm người đều là thành viên nhóm, và `main` đã được bảo vệ bằng PR + approve.
- `apps/mobile` (Expo) có hệ thống build riêng, phải để ý cấu hình Metro khi resolve `packages/shared` ra ngoài thư mục app.

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Mỗi WP một kho mã riêng | Type dùng chung phải publish package hoặc copy tay. Với nhịp 2 tuần một sprint và cột mốc M3 đòi E2E liền mạch, chi phí đồng bộ vượt xa lợi ích về ranh giới sở hữu. |
| Monorepo dùng Nx hoặc Turborepo | Thêm một lớp công cụ phải học, trong khi lợi ích chính (cache, task graph) chỉ đáng giá khi CI đã chậm. Chưa chậm thì chưa cần. Có thể thêm sau mà không phải đổi cấu trúc thư mục. |
| Monorepo dùng pnpm workspaces | pnpm tốt hơn về đĩa và tốc độ, nhưng Expo / Metro có tiền sử trục trặc với symlink của pnpm. Không đáng đổi lấy rủi ro ở WP3 trong đồ án 13 tuần. |

## Phụ lục 10/2026 — app tài xế là Flutter

*Ghi ngày 23/10/2026 bởi Ngô Văn Minh Trí (WP2). Không đổi trạng thái ADR; chỉ ghi nhận thực tế đã lệch so với giả định lúc viết.*

Nhóm đã chốt app tài xế viết bằng **Flutter (Dart)**, không còn là React Native / Expo. Giả định "cả ba đầu ra viết bằng TypeScript" ở mục Bối cảnh không còn đúng. Cập nhật:

- `apps/mobile` vẫn nằm **trong monorepo** để giữ một dòng lịch sử git và một lần checkout cho review chéo, nhưng **ngoài npm workspaces** — Flutter có hệ thống build riêng (`pub`), không tham gia `npm install` / `npm run build --workspaces`.
- `packages/shared` phục vụ **backend + dashboard** (TypeScript). App không import được package này.
- Hợp đồng API giữa CSMS và app đi qua **`openapi.json` sinh từ NestJS**; phía app sinh client Dart từ file đó. Sự kiện Socket.IO có hợp đồng riêng.
- Dòng "Mất" về Expo / Metro và dòng loại pnpm vì Metro ở trên không còn áp dụng; lý do giữ npm workspaces giờ là tính đơn giản và việc nhóm đã commit theo nó.
