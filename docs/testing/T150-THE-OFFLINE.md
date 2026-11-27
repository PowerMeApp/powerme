# T150 — giảm rủi ro thẻ offline (BR-P52): ca test và cách demo

Nhánh `feat/t150-giam-rui-ro-the-offline`, tạo từ `origin/main` `23a15a8`. WF-03, người làm: Trí.

## Tình huống

Trụ mất mạng, tài xế quẹt một thẻ lạ hoặc thẻ đã bị khoá. Nếu trụ còn tự cho phép thẻ khi offline
(Authorization Cache / Local List với `LocalAuthorizeOffline=true`, hoặc
`AllowOfflineTxForUnknownId=true`) thì phiên vẫn chạy. CSMS chỉ biết khi trụ nối lại (phát lại
StartTransaction mang giờ cũ), và tiền không thu được, dẫn tới shortfall (BR-P20).

## Cách CSMS chặn

1. Sau mỗi BootNotification đã Accepted (không chặn phản hồi Boot), CSMS gửi `GetConfiguration`
   (LocalAuthorizeOffline, LocalPreAuthorize, AllowOfflineTxForUnknownId, AuthorizationCacheEnabled,
   LocalAuthListEnabled, SupportedFeatureProfiles), rồi `ChangeConfiguration` từng key trong ba key
   đầu về `false` nếu trụ chưa đặt false. Kết quả ghi vào `charge_point_offline_auth_checks`
   (migration 0030) và mỗi lệnh một dòng `remote_commands`; mọi frame nằm trong `ocpp_message_log`.
2. Cờ `offline_card_risk` = không xác nhận được cả ba key đều false (Rejected, NotSupported, key
   không có, RebootRequired, timeout, CALLERROR, hoặc trụ chưa từng được kiểm). Dashboard: huy hiệu
   "Rủi ro thẻ offline" ở màn 18 (danh sách trụ) và một dòng giải thích ở màn 20 (chi tiết trụ).
3. Giới hạn dự phòng (mặc định TẮT, `OFFLINE_TX_FALLBACK_S=0`): khi > 0, trụ có rủi ro và khai
   `SmartCharging` nhận `SetChargingProfile` `TxDefaultProfile` (connector 0, stackLevel 0, Relative,
   đủ công suất N giây đầu phiên rồi 0 W). Phiên có StartTransaction không phải phát lại được CSMS
   ghi đè bằng `TxProfile` không giới hạn cho đúng `transactionId`. Phiên bắt đầu offline (CSMS chưa
   biết transactionId) bị trụ cắt công suất sau N giây.

## Ca test đề xuất cho Report 5

Mã `TC-BRP52-*` là đề xuất (Report 5 ở Google Doc chưa có nhóm này). Ca có test tự động gắn mã ngay
trong tên test.

| Mã | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Test tự động |
|---|---|---|---|---|---|
| TC-BRP52-01 | Boot, trụ cho đổi key | Trụ có ba key, LocalAuthorizeOffline và AllowOfflineTxForUnknownId = true | Trụ gửi BootNotification | Boot.conf Accepted ngay; CSMS gửi GetConfiguration rồi ChangeConfiguration cho hai key đang true (key đã false thì `skipped`); trụ trả Accepted; `offline_card_risk = false`; ba dòng `remote_commands` | `apps/csms/test/t150-offline-auth-check.integration.test.ts` |
| TC-BRP52-02 | Trụ từ chối (Rejected) | AllowOfflineTxForUnknownId readonly = true | Như 01 | `offline_card_risk = true`, lý do `rejected`; `change_results` ghi Rejected | như trên |
| TC-BRP52-03 | Key không có / NotSupported / RebootRequired | Trụ thiếu key, hoặc trả NotSupported / RebootRequired | Như 01; với RebootRequired: Boot lại sau khi trụ áp giá trị | Lý do `key_missing` / `not_supported` / `reboot_required`; lần Boot sau đọc được false thì cờ tắt (dòng mới nhất quyết định) | như trên |
| TC-BRP52-04 | Timeout / CALLERROR, Boot không bị chặn | GetConfiguration không trả lời trong `OFFLINE_AUTH_CHECK_TIMEOUT_S`, hoặc CALLERROR | Như 01 | Lý do `no_response`, CSMS không lỗi; Boot.conf trả trước khi có lệnh nào ra; `OFFLINE_AUTH_CHECK_ENABLED=false` thì không gửi gì | như trên |
| TC-BRP52-05 | Dashboard hiện cờ | Lần kiểm mới nhất của trụ có rủi ro; trụ khác đã tắt được; trụ chưa kiểm | Mở màn 18 và màn 20 | API danh sách và chi tiết trả `offline_card_risk` + `offline_card_risk_reason` (`not_checked` cho trụ chưa kiểm), chi tiết có `offline_auth_check`; màn 18 có huy hiệu, màn 20 có dòng giải thích | `apps/csms/test/fe03-operator-monitoring.integration.test.ts`, `apps/dashboard/test/monitoring.test.tsx`, `apps/dashboard/test/chargePointDetail.test.tsx` |
| TC-BRP52-06 | Giới hạn dự phòng TxDefaultProfile | `OFFLINE_TX_FALLBACK_S=90`, trụ rủi ro có SmartCharging | Boot, rồi một phiên bắt đầu online | SetChargingProfile TxDefaultProfile `[0 s: rated W, 90 s: 0]` Accepted; phiên online nhận TxProfile cho đúng transactionId; mặc định (0) không gửi; trụ không có SmartCharging ghi `unsupported` | `apps/csms/test/t150-offline-auth-check.integration.test.ts` |
| TC-BRP52-07 | Kịch bản: chặn được | Trụ kịch bản `--offline-auth accept` | `offline-card` | Sau Boot ba key = false; offline trụ từ chối thẻ; không có phiên, không thể shortfall | thủ công (lệnh dưới) |
| TC-BRP52-08 | Kịch bản: thẻ lạ offline + phát lại | `--offline-auth reject` | `offline-card` (thẻ UNKNOWN-TAG-99) | Cờ bật; sau nối lại, Start/Meter/Stop là phát lại (cp_timestamp trước epoch mới); phiên `unattributed` + bản ghi `unknown_id_tag` (ADR-0012) | thủ công |
| TC-BRP52-09 | Kịch bản: thẻ bị khoá | `--offline-auth reject --tag DEMO-BLOCKED-01` | `offline-card` | Phiên vẫn được ghi, không gán tài xế (BR-P23) | thủ công |
| TC-BRP52-10 | Kịch bản: thẻ trong danh sách | `--offline-auth reject --tag DEMO-CARD-0001 --listed` | `offline-card` | Phiên `csms_billed` của tài xế gắn thẻ, quyết toán bình thường | thủ công |
| TC-BRP52-11 | Kịch bản: shortfall | `--offline-auth reject --tag DEMO-CARD-0001 --listed --offline-wh 400000` | `offline-card` | Chi phí > số dư, ví âm (BR-P20), tài xế không bắt đầu được phiên mới cho tới khi nạp | thủ công |
| TC-BRP52-12 | Simulator D1 | `OFFLINE_AUTH=normal` / `rejected` | `node simulator/d1-hmi/smoke.mjs` | ChangeConfiguration Accepted và đọc lại false; trụ cứng đầu Rejected; TxDefaultProfile Accepted, TxProfile cho phiên không có Rejected | `simulator/d1-hmi/smoke.mjs` (mục 5 và 10) |

## Demo cờ `offline_card_risk` (local)

```bash
# 1. Demo local (Postgres nhúng + CSMS, offset 80 → OCPP 9080, console/API 3080)
node apps/csms/demo/run-demo.mjs --port-offset 80 --no-hmi

# 2a. Trụ cứng đầu: key readonly → Rejected → cờ bật. Ca thẻ lạ offline + phát lại.
node apps/csms/demo/scripted-station.mjs offline-card --offline-auth reject \
  --url ws://localhost:9080/ocpp --fast
# 2b. Trụ ngoan: CSMS tắt được → cờ tắt, trụ từ chối thẻ offline
node apps/csms/demo/scripted-station.mjs offline-card --url ws://localhost:9080/ocpp --fast
```

Kiểm: dashboard (`apps/dashboard`, `npm run dev -w @powerme/dashboard`, trỏ API vào CSMS) → **Trụ
sạc** (màn 18) có huy hiệu "Rủi ro thẻ offline" ở trụ RH24D1-00001 sau 2a, mất sau 2b; bấm vào trụ
(màn 20) thấy dòng giải thích và các lệnh GetConfiguration / ChangeConfiguration trong "Lệnh gần
đây". Không có dashboard thì gọi thẳng `GET /api/operator/v1/charge-points` với token Operator.
HMI D1: `OFFLINE_AUTH=rejected` (hoặc `notsupported`) cho trụ cứng đầu.

## Giới hạn

- Không xác minh trên trụ Ruihua thật: tập key và phản hồi thật chưa biết (README d1-hmi, giả định 4).
- RebootRequired được tính là chưa xác nhận; CSMS không tự Reset trụ.
- TxDefaultProfile chỉ thử trên simulator; trụ thật có thể không hỗ trợ Relative hoặc đơn vị W.
  Phiên bắt đầu offline của thẻ hợp lệ cũng bị cắt sau N giây (đánh đổi có chủ đích, nên mặc định tắt).
- Trụ nối lại không gửi Boot (EXP-01) thì không kiểm lại; cờ giữ kết quả lần Boot trước.
