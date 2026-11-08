# Quy trình coding WP3

Đọc [CONTRIBUTING](../../../CONTRIBUTING.md); quy tắc task/nhánh/commit/PR của nhóm áp dụng cho mobile. Chỉ ghi `apps/mobile`, bảo toàn WIP và nguồn chung.

## Baseline và nhánh

**Trạng thái MB-01 sau preflight mới:** branch `wp3/mb-01-nen-tang-flutter-demo`, HEAD `91d8ec072f004ded56c6584bcf6a96284e8a9cdf`, bằng `refs/powerme-sync/heads/main` đã fetch; không còn chênh main/conflict. `origin/main` là ref cũ (chậm 16 commit). Giữ diagrams/scaffold WIP, chỉ ghi mobile; không commit/push. Phần dưới là ghi nhận preflight cũ, đã được thay thế bởi trạng thái này.

Preflight 28/10/2026 đã fetch main `91d8ec072f004ded56c6584bcf6a96284e8a9cdf` tại `refs/powerme-sync/heads/main`. Branch BE hiện tại `wp3/mb-04-t72-sua-loi-backend-wf01`, HEAD be78cfb, lệch 3 local / 13 main commit; remote branch cũ đã xóa. Main không có thay đổi mobile chồng lấn, README giống bản cũ. Chưa rebase vì WIP/scaffold/UML local phải giữ.

Trước coding Flutter: fetch lại, kiểm status/diff/main, bảo toàn WIP bằng cách có thể khôi phục; chuẩn bị nhánh task riêng từ main mới nhất rồi chuyển đúng thay đổi mobile đã review. Không đưa Flutter vào PR BE cũ/rebase mù trên WIP.

Tên nhánh: `wp3/<ma-mb-viet-thuong>-<mo-ta-khong-dau>`, chọn **mã MB thật từ kế hoạch nhóm**. Không tự tạo task hoặc suy T20/T22/T31/T72 là MB đã duyệt. Commit đúng hai khoảng trắng trước mã:

```text
<loại>(mobile): <mô tả>  [MÃ-MB-THỰC-TẾ]
```

Điền mã thật, không commit placeholder. Một task/nhánh, PR nhỏ theo CONTRIBUTING, không push main. Bước docs không cài dependency/bật hook/commit/push/đổi nhánh.

## Nguồn và phân công

Đọc [SRS](../../../docs/requirements/report3-srs.md), [package](../../../diagrams/report4/package/PKG-3/PKG-3.puml), [class](../../../diagrams/report4/class/CD-1/CD-1.puml), [sequence](../../../diagrams/report4/sequence/SD-1a/SD-1a.puml). [README](../README.md) ghi mức duyệt và baseline drift.

Phiếu v1.3 chưa có trong working tree; đọc [bản GitHub bất biến](https://github.com/PowerMeApp/powerme/blob/91d8ec072f004ded56c6584bcf6a96284e8a9cdf/docs/requirements/registration-form-v1.3.md), hoặc từ root repo:

```powershell
git show 91d8ec072f004ded56c6584bcf6a96284e8a9cdf:docs/requirements/registration-form-v1.3.md
git show 91d8ec072f004ded56c6584bcf6a96284e8a9cdf:docs/requirements/report3-srs.md
```

Candidate 26/10 chờ hội đồng Review 2 duyệt: WP2 status/time-left, WP4 suggestion/RQ2, WP3 driver UI, WP5 billing/loyalty. Không tiếp tục gán time-left cho WP4 theo guide cũ. BR-P45 tại main mới tính chính xác mỗi segment rồi tổng/round half-up một lần/phiên; ghi sai khác baseline, không sửa nguồn chung trong task mobile.

## Research và triển khai

1. Map FR/UC/BR-P/NFR, owner/approval; đọc code/test hiện có.
2. Research GitHub chính chủ/được duy trì, đọc code/test thực tế; không chỉ README/stars. So hai cách khi hữu ích, không ép số lượng.
3. So ngắn gọn độ khớp requirement, kiến trúc, dependency, security, license, bảo trì/đánh đổi.
4. Chọn cách phù hợp, viết/điều chỉnh vào dự án, giữ code hiện có; ghi URL/commit/phần áp dụng/attribution. Viết lại không tự xóa nghĩa vụ license.
5. Không tự tải/chạy code lạ/cài dependency. Nguồn không truy cập được thì báo giới hạn; không bịa research. Sửa docs/format/lỗi nhỏ không cần research mới.

Làm từng slice: nền composition/domain/theme → Auth/Profile → Stations → Charging → Payments/History/Loyalty → Support/Should reservation. Đối chiếu visual/docs và ghi khác biệt trước mở rộng. Mock local là cấu hình chủ động, không tự fallback API lỗi sang mock. Contract/client generated để bước API sau với OpenAPI WP2 và toolchain pin.

Comment mới/sửa chỉ 1–2 dòng ngắn, lý giải dài vào docs. Không thêm lớp rỗng hoặc rewrite toàn app chỉ vì đã research.

## Kiểm tra/bàn giao

Task docs: kiểm 7 Markdown/link tương đối/diff whitespace; không app tests hoặc tuyên bố đã chạy UI. Khi coding: format/analyze, test logic/widget của slice, kiểm màn hình bằng tool có sẵn; không cài tool để làm xanh. Chọn nhánh từ [mock scenarios](mock-scenarios.md), gồm auth switch/version cũ/unknown/late result.

Báo file đổi, kết quả thực tế/screenshot, phần chưa kiểm và lệch docs. Mock pass không chứng minh backend/OCPP/VNPay/device/NFR/RQ2. Merge/Done theo CONTRIBUTING cần bằng chứng riêng.
