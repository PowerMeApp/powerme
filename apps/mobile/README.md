# PowerMe mobile — WP3

Flutter Driver App của Lý Hoàng Sơn (WP3), trong `apps/mobile`. Migration trên nhánh `WP3` từ `main` tại `f0cc5f36bf87de96e821ae8669151acfe1bb0ce1` giữ source, Android platform, assets, lockfile và tests của app local; không xây lại feature hay tích hợp backend.

**Đây là UI mô phỏng, chưa phải app tích hợp hoặc bản phát hành.** Auth chỉ kiểm tra đầu vào local; trạm, lịch sử và tài khoản là fixture. Nút simulate không liên lạc CSMS/VNPay. `PaymentScreen` vẫn có “Bill phiên sạc”, tiền từ summary và Visa 4242 giả: UI pay-after cũ xung đột với prepaid top-up. `simulatePaid()` chỉ nhận pending; unknown/checkout closed chưa khôi phục late settlement. `reconnect()` tự đổi sang live, không lấy snapshot backend. Chưa có auth-scoped cache/generation guard, release gate loại mock, consent/onboarding đầy đủ, credit ledger, loyalty chuẩn hay Fastest/Cheapest thật. Tests hiện có chỉ kiểm mock.

## Đọc trước khi phát triển

- [Hướng dẫn agent](AGENTS.md), [quy trình chung](../../CONTRIBUTING.md), [ADR-0001, phụ lục Flutter](../../docs/adr/0001-monorepo-npm-workspaces.md).
- [Design Brief WP2 G1/G12/G17](../../docs/DESIGN-BRIEF-WP2-INPUT.md): SRS chuẩn và OpenAPI/mobile APIs chưa được đưa vào repo. Chờ WP1/WP2 bàn giao; không dùng fixture hoặc DB schema thay API.
- [T13](../../docs/XAC-NHAN-STATE-MACHINE-T13.md), [schema/điểm pending](../../docs/THIET-KE-CSDL-VAT-LY.md), [ADR-0009](../../docs/adr/0009-quy-uoc-du-lieu.md) và [ADR-0012](../../docs/adr/0012-phien-the-vi-va-free-vend.md) là tham chiếu hiện trạng backend.

Đối chiếu nguồn: phiếu Main Doc 15/10/2026 là candidate còn chờ duyệt; SRS 09/10/2026 áp dụng khi tương thích. [Kế hoạch cũ](../../docs/KE-HOACH-POWERME.md) còn auto-full-only/cắt loyalty, [ADR-0002](../../docs/adr/0002-modular-monolith.md) còn gắn session với invoice; không dùng các dòng cũ ghi đè baseline mới bên dưới. T13/schema dùng `app_qr/rfid` và payment mode `free`, ADR-0009 dùng `app/rfid_online/rfid_wallet` và `unattributed`: mapping vẫn cần WP2/WP5 chốt, không tự đồng nhất `free` với `unattributed`. Client timeout/unknown khác server start-timeout `failed`. Giữ pending provider/VAT/refund/retention/credit thresholds, reservation fee/cutoff và approval; không quyết bằng mock.

## Chạy và kiểm tra

Chạy trực tiếp trong `apps/mobile`, với Flutter/Dart và Android toolchain đã có. Dùng cache pub hiện hữu khi offline; không nâng dependency hay tự cài SDK để vượt lỗi.

```text
flutter pub get --offline --enforce-lockfile
dart format --output=none --set-exit-if-changed lib test
flutter analyze --no-pub
flutter test --no-pub
flutter run --no-pub
```

`flutter run` cần thiết bị/emulator do developer chọn. Android là platform duy nhất hiện có. Debug build chỉ chạy khi SDK/NDK/Java/Gradle đã đủ, tắt tự tải SDK và dùng Gradle offline. Không cần `npm install` để dùng Flutter: lệnh đó bật hook ở repo gốc. `npm run mobile` hiện trỏ workspace nhưng `package.json` stub không có script chạy app; giữ stub để không phá root lockfile.

Giữ Riverpod/go_router, Gold `#D4AF37`, Teal `#00E0C2`, Rich Black `#0A0A0A`, Graphite `#141414` và tiếng Việt. `assets/brand` hiện chỉ có README; logo dùng placeholder, chưa có ảnh chuẩn. Không vẽ lại hoặc tuyên bố đã tích hợp logo chính thức.

Baseline nguồn cần triển khai: bốn mode full/timed/kWh/cost; VNPay top-up → server verified credit → debit sau close/reconciliation → statement/points; e-invoice thuộc top-up. Loyalty **Must**, reservation **Should**, availability alert **Could**. Candidate 15/10/2026 còn chờ duyệt; chi tiết SRS 09/10/2026 áp dụng khi tương thích. Đây là yêu cầu nguồn, không phải feature được migration nghiệm thu.
