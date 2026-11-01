# Hướng dẫn coding WP3 — đọc tự động

Phạm vi ghi chỉ `apps/mobile`; giữ diagrams/backend/scaffold/WIP người dùng. Đọc [CONTRIBUTING](../../CONTRIBUTING.md), [README](README.md) và **hai canonical coding references sau trước mọi coding/review slice**:

1. **[docs/screens.md](docs/screens.md)** — đủ 15 source views, FR/UC/BR/NFR, Must/Should/Could, chức năng/states, acceptance và implementation status. Đây là nguồn checklist màn hình/chức năng duy nhất của mobile.
2. **[docs/architecture.md](docs/architecture.md)** — exact class/signature/enum WF01, package/dependency PKG-3, folder/layers, composition/guards/checks. Đây là nguồn coding architecture duy nhất của mobile.

Đọc matching source SRS/registration và nguyên class/package/sequence diagram mà hai file dẫn tới. Không code từ screenshot hoặc old fixture policy. Nếu hướng dẫn cũ mâu thuẫn nguồn mới/yêu cầu trực tiếp thì ghi rõ xung đột, không âm thầm chọn policy. Candidate v1.3 26/10 vẫn pending approval: WP2 status/time-left; WP4 suggestion/RQ2.

## Trước và sau mỗi slice

- Fetch latest và so branch/main trước implementation, giữ local WIP; resolve conflict trước coding. Dùng ref latest đã được verify, không coi origin/main cũ là mới nhất.
- Ghi trace vào phần tiến độ screens.md: view/function → FR/UC/BR/NFR → class/package → dependencies/DEC → acceptance/tests. Đối chiếu method signatures và dependencies architecture.md trước thêm class.
- Research code/tests nguồn chính chủ proportionate trước new feature; ghi URLs/commit/license/phần áp dụng. Không tải/chạy dependency chưa được phép.
- Implement bounded slice; cập nhật status screens.md và contract extension architecture.md trong cùng slice. Ghi **đang làm / local đã kiểm / pending integration** trung thực; không đánh Done theo UI đẹp hoặc fixture pass.
- Chạy format/analyze/test/build phù hợp trong nested mobile; TMP/TEMP E:/Project/PowerMe/.review. Không outer checker trỏ app standalone cũ. Báo actual results và limits README; không commit/push/deploy tự động.

## User override mới nhất — 28/10

**UI tài xế không hiển thị Demo/mock/sample/dữ liệu mẫu/mô phỏng/cảnh báo kỹ thuật hoặc badge.** Ranh giới local/mock chỉ ghi README. Quyết định này thay demo-label rules trong design-system/mock-scenarios/guide cũ; không tạo warning banner để thỏa tài liệu cũ. Giữ business states thật: stale/unknown/empty/error/retry. Không giả outcome thành công, fake login, dead CTA cho payment/auth/map/command chưa làm.

Giữ exact brand gold D4AF37, teal 00E0C2, black 0A0A0A, graphite 141414 và crops logo thật; 20px gutters/8px spacing/12px card/48px targets. UI dùng font fallback nếu chưa có Montserrat/license, không tự cài. [design-system](docs/design-system.md) là visual support; [mock-scenarios](docs/mock-scenarios.md) là future scenario plan; không là canonical requirement/architecture thứ ba. Historical mb-01-foundation chỉ research record.

## Coding boundaries

Riverpod/go_router đã có; không dependency mới nếu chưa được phép. Feature-first domain/interface/data/application/presentation; adapters/store/scope chọn tại app/composition. Widget render/intent, không import mock/DTO/HTTP hoặc filter dataset/tính money/credit/points/rank. StationsController/StationRepository/StationOption theo WF01, async find(vehicleId,query); future suggest không giả implemented. Domain thuần Dart, no generated WP2 contract giả.

Giữ auth/request generation guards, dispose/clear và bỏ late response; fixed local AuthScope không là auth thật. Năm station statuses + updatedAt/quality, nullable unknown; connection/session/payment/settlement/invoice riêng. Accepted≠effect, return≠paid; unknown không failed; stable keys và integer units. Không API/OCPP/payment/network thật, secrets hoặc TLS bypass trong slice local.

Comment mới/sửa 1–2 dòng ngắn về intent/ràng buộc, lý do dài đặt docs. Không tạo màn rỗng/class stub chỉ để đủ 15 views/tám packages. Giữ source license/generated metadata bắt buộc.
