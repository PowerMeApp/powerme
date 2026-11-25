# T148 — Quyết toán RFID, phase 1–3 local

Ngày 24/11/2026. Nhánh `wp3/t148-quyet-toan-rfid`, nền T146
`e76238fa494d73f90bc1fd36700a35693cdc2c7e`; `origin/main` sau fetch là
`3138f859b4587f637b3b3f92516053d85d6fa34f`. Chưa commit/push/PR.
Phase 3 local đã nâng sau backup và primary review; xem trạng thái hiện tại dưới đây.

## Yêu cầu và cách thực hiện

Theo RP3 10/11 (BR-P08/P23/P34/P45), ADR-0013 và WF-02 D9: RFID online dùng
Charging Credit. Nội dung thẻ ví trong ADR-0012 là lịch sử, đã bị RP3/T110 thay thế.
`ChargeSettlementService` nhận thêm phiên `origin=rfid`, `payment_mode=csms_billed`,
có `driver_id`. Chủ nợ và phân loại lấy từ **sessions tại StartTransaction**;
block/unlink/chuyển chủ thẻ sau start không đổi khoản nợ đã phát sinh.
Không cần app intent hay xe mặc định. Nhánh app có intent khớp và ngoại lệ
operator-assigned có lịch sử `UNATTRIBUTED_ASSIGNED` được giữ nguyên.

Một `chargeTransaction` khóa phiên → credit → loyalty. Khối ghi SQL billing thô
của common settler được thay bằng `CreditLedgerService.post(tx, accountId,
'session_debit', -amount, {sessionId})`, rồi `LoyaltyService.earnForSession` trên
**cùng PoolClient**. `OcppGatewayModule` import `BillingModule` để tiêm hai service
bắt buộc. Không có fallback writer. Statement, segment, total và giải phóng reserve
cùng transaction; lỗi sau debit hoặc earn rollback toàn bộ phần tiền.

Điều kiện đối soát, meter cuối, energy khớp, promotion review và toàn bộ T134
CP/offset/CSMS clock giữ nguyên; BR-P45 cộng chính xác rồi half-up một lần tới VND.
Phiên 0 Wh/0 VND vẫn có debit 0, earn 0, statement. `in_shortfall` được âm thêm
(BR-P20), không kiểm lại start minimum khi thu nợ. Tài khoản thiếu →
`pending/credit_account_missing`; ledger từ chối closed → `pending/account_closed`
(D6), không ép trừ. Free vend và unattributed không debit/earn.

StopTransaction vẫn lưu stop/job và đối soát trước; lỗi billing không hủy ACK.
Khóa phiên và unique debit/earn/statement chặn thu trùng; job `posted` không bị
hạ trạng thái. Snapshot/statement thuộc đúng tài xế theo JWT. App Stop RFID trả
404; progress/history có `can_stop=false`, statement có sau quyết toán.

## Khôi phục lịch sử

[0029](../../apps/csms/drizzle/0029_t148-rfid-settlement-recovery.sql) chỉ khôi phục job
thiếu hoặc `ineligible` của phiên RFID có chủ, `csms_billed`, đã dừng không muộn hơn
thời điểm migration, trạng thái closed/review/reconciled, chưa có statement **và**
chưa có session debit. Đặt `pending/t148_rfid_recovered`, giữ số lần thử; không
đổi pending/posted, phiên khác hay bằng chứng tài chính. Đây là giới hạn bảo thủ
bằng phân loại/bằng chứng/trạng thái và thời điểm, không suy chủ từ registry mới.
Review/meter/giá chưa đủ vẫn chờ worker theo điều kiện hiện hành.
Xem [nhật ký 0029](../NHAT-KY-MIGRATION-0029.md).

Trong phase 1, migration chỉ chạy trên DB test. Sau primary review và backup riêng,
phase 3 đã áp 0029 đúng một lần lên local `powerme_rfid_local`; kết quả ở mục cuối.

## Nguồn nghiên cứu do primary bàn giao

Primary đã đọc source/test trước implementation; implementer ghi lại provenance
được cung cấp, không tuyên bố tự đọc hoặc xác minh lại upstream. Chỉ áp dụng ý tưởng,
không sao chép code, chạy/install source hoặc thêm dependency/license vào PowerMe.

| Nguồn ghim và giấy phép | Bằng chứng đã được primary cung cấp | Fit, kiến trúc và tradeoff |
|---|---|---|
| Kill Bill, commit `8881b6617a7ef2d0bd5e1dd354d37405eb1362d6` (19/11/2026), [Apache-2.0](https://github.com/killbill/killbill/blob/8881b6617a7ef2d0bd5e1dd354d37405eb1362d6/LICENSE) | [DefaultInvoiceDao.java](https://github.com/killbill/killbill/blob/8881b6617a7ef2d0bd5e1dd354d37405eb1362d6/invoice/src/main/java/org/killbill/billing/invoice/dao/DefaultInvoiceDao.java) 468–503: existing entity trong transaction; 823–867: cùng external key kiểm amount/payment rồi trả existing. [TestInvoiceDao.java](https://github.com/killbill/killbill/blob/8881b6617a7ef2d0bd5e1dd354d37405eb1362d6/invoice/src/test/java/org/killbill/billing/invoice/dao/TestInvoiceDao.java) 284–313: payment giảm balance; 1215–1248: CBA sau commit | Atomicity của billing phù hợp. Engine Java đầy đủ không cần cho debit nội bộ NestJS; kéo engine tăng dependency, vận hành và bề mặt bảo mật. Dùng ledger/loyalty hiện có dễ bảo trì hơn. |
| Medusa, commit `8a43169b555ce1f7b3358ebd50016e076f57f3ba` (23/11/2026), [MIT core](https://github.com/medusajs/medusa/blob/8a43169b555ce1f7b3358ebd50016e076f57f3ba/LICENSE); Enterprise RBAC/SSO loại khỏi phạm vi | [payment-module.ts](https://github.com/medusajs/medusa/blob/8a43169b555ce1f7b3358ebd50016e076f57f3ba/packages/modules/payment/src/services/payment-module.ts) 783–906: khóa/reread trong transaction, provider bên ngoài; 995–1049: stable key/resume pending. [integration test](https://github.com/medusajs/medusa/blob/8a43169b555ce1f7b3358ebd50016e076f57f3ba/integration-tests/__tests__/services/payment-module/index.spec.ts) 1165–1188: duplicate một row; 1694–1719: timeout cùng key; 1751–1766: retry một provider call; 2198–2231: concurrent capture một accepted | Ý tưởng idempotency/concurrency TypeScript phù hợp. Provider/state machine thương mại không khớp RFID credit; không thêm HTTP/provider cho session debit. Dùng khóa/unique và durable jobs của PowerMe; không có dependency hay trust boundary mới. |

Không đổi biểu giá, model billing, dependency hay hệ thống thanh toán. Dùng server
captured owner, transaction và ràng buộc DB làm ranh giới bảo mật; dữ liệu test là
fixture bịa, không dùng mã đầu đọc/thẻ thật hay bí mật.

## Kiểm chứng và giới hạn

Feature RED trên product code cũ: RFID đi hết Authorize → Start → Meter → Stop →
reconciled, nhưng job `ineligible` thay vì `posted` (`red-1795511635206.log`).
Core GREEN: 1/1. Bộ mới: RFID 20/20 và migration 1/1, hai DB mới qua MB03 runner.
Có lỗi DB thật ở insert loyalty/statement để kiểm rollback sau debit/earn và ACK;
có ép chồng transaction bằng khóa PostgreSQL, không dùng runtime mock.
Các kiểm tra regression/typecheck/build/format và hash cuối được ghi trong handoff
ngoài repo tại `E:/Project/PowerMe/.review/t148-rfid-settlement-20261124/`.

BR-P19 cutoff cho phiên RFID vẫn là gap hiện có: `DriverChargingService.onMeter`
chỉ chọn phiên có app intent. Phase này quyết toán khoản nợ đã phát sinh, không mở
rộng cutoff. Đóng tài khoản khi còn khoản chưa quyết toán vẫn cần guard D6 (c) của
phần closure; phase này giữ `account_closed` rõ ràng.

## Phase 2 — Flutter local, đã review 24/11

Domain chỉ cho RFID csms_billed đã dừng, closed/reconciled, pending và không review
đọc tiếp. Controller giới hạn auto-poll hai phút từ lần nhận pending hợp lệ đầu
tiên, tính cả thời gian hidden/background; không đọc mạng khi ẩn và manual Refresh
không reset budget. Sau hết hạn vẫn Refresh được; posted đọc bảng kê sở hữu sẵn có
một lần. Review vẫn manual; unknown/legacy/nonbillable fail closed. Không mở RFID
Stop/retry, không tạo start context/xe hoặc tính tiền/điểm phía client.

RED mobile tái hiện pending không poll tới posted; RED bổ sung xác nhận Refresh
bị disabled sau cancel/background và hết budget. Sửa tại nhánh resume không poll
bằng notifyListeners, giữ cancellation/generation/no-overlap. 75 focused pass
(gồm 10 ca RFID mới), exit 0; một capture batch 2/2 pass, 4 PNG hai profile.
Navbar 320px/200% chồng chữ là giới hạn T146 đã biết, ngoài scope; ảnh posted
320 chỉ thể hiện phần đầu nội dung cuộn. Xem README/architecture/screens của mobile
và `PHASE2-HANDOFF.md` trong thư mục evidence cho kết quả analyzer/format cuối.

Backend tổng kiểm phase 1: 20 RFID + 1 migration + 53 app/session + 321 regression
pass, tất cả exit 0; batch 321 có actual Nest composition. Build/typecheck/format
exit 0. Trạng thái runtime ở cuối phase 2 còn chờ nâng; phase 3 đã xác minh lại tiến trình/cổng
và nâng local sau backup, không dùng readiness.json cũ làm bằng chứng đang chạy. Credit/loyalty
provider giữ refresh khi vào route; không thêm global background service.

## Phase 3 — local đã nâng và kiểm chứng 24/11

Trước startup, cluster owned ở `127.0.0.1:5546/powerme_rfid_local` đã được
xác minh dừng: không postgres process/listener, pg_ctl status exit 3. Theo phê duyệt
của người dùng, dùng **cold filesystem backup**, không phải pg_dump: copy đầy đủ
pgdata/WAL/config vào thư mục private review riêng. 1.919 file, 79.176.294 byte;
source ổn định và mọi SHA-256 khớp. Backup có thể cần WAL crash recovery do lần
dừng trước không sạch. Inventory chạy PG riêng, read-only, không migrate/seed,
rồi dừng sạch; chỉ có phiên 1 RFID của driver 1, reconciled 599 Wh, job ineligible.

Build BE actual dist exit 0; existing owned runner áp 0029 và seed idempotent bằng
private credentials cũ. Hậu kiểm read-only: biểu giá lưu **3.800 VND/kWh**, 599 Wh
→ **2.276 VND**, **2 điểm** theo exact segment + half-up tổng một lần. Đúng một
session_debit, một earn, một statement và job posted. Credit driver 1 từ 500.000
còn **497.724 VND**, loyalty từ 0 lên 2; account còn lại và lịch sử cũ giữ nguyên.
Sau thêm một recovery scan, số đếm vẫn một lần. Sessions vẫn **1**, meter values
**5**, commands **0**; không tự tạo/sạc/dừng phiên mới. Card được so khớp bằng
private parameter và vẫn liên kết đúng, không công bố identifier.

JWT login thật và GET credit/history/sessions/progress/statement của owner trả 200;
unauthenticated 401, existing seeded driver khác 404 cho progress/statement bằng
JWT ký local hợp lệ, không tạo account. RFID can_stop=false. HMI online/Boot Accepted;
API 3000, OCPP 9000, HMI 8100, PG 5546 đều bind 127.0.0.1 và process path đã kiểm.
API/HMI được giữ chạy. Đây là local recovery đã xác minh, không là staging hay
bằng chứng hardware E2E. Mobile API config giữ byte SHA-256 cũ; không đọc staging
infra/.env/SSH/DB, không commit/push hay cài SDK/dependency mới, không đổi brand/nav.
APK debug build --no-pub exit 0, đã install -r và mở trên Pixel_6 hiện có; process
và foreground activity đã xác minh. Không tự login/swipe/Start/Stop; không tuyên bố
hardware hoặc staging E2E.

Evidence private: `E:/Project/PowerMe/.review/t148-rfid-settlement-20261124/`:
`runtime-backup.json`, cold source/copy manifests, `runtime-before.json`,
`runtime-after.json`, `runtime-stability.json`, `runtime-listeners.json`.
`FINAL-HANDOFF.md` và `final-manifest.json` ghi APK/device status và check exits cuối.
