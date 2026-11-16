# T101 / T134 — Quy tắc đồng hồ khung giá

Nguồn yêu cầu là [RP3 §5.1](requirements/report3-srs.md) BR-P02, BR-P45 và BR-P48. T101 (#120, base `508fd0e`) đưa vào việc kiểm đồng hồ trụ và phương án dùng giờ CSMS. **T134 (quyết định D-I ngày 14/11/2026) thay quy tắc xử lý khi đồng hồ trụ sai**: đo độ lệch trên các bản tin gửi live trong cùng connection epoch rồi cộng vào giờ trụ; chỉ khi không có độ lệch nào dùng được mới tính cả phiên theo khung giá lúc CSMS nhận StartTransaction. Phiên không còn bị giữ vì đồng hồ. Mã: `apps/csms/src/reconciliation/tariff-clock.ts`, `apps/csms/src/sessions/charge-settlement.service.ts`, migration 0020 và 0023.

## Quy tắc (T134)

Độ lệch của một bản tin = giờ CSMS nhận − giờ trụ ghi trong bản tin. Dương nghĩa là đồng hồ trụ chậm.

1. **Đo theo từng epoch, chỉ trên bản tin live.** Ứng viên là StartTransaction, từng MeterValues.req (lấy mẫu mới nhất trong bản tin) và StopTransaction của phiên. Trong một epoch, bản tin có độ lệch nhỏ nhất là bản tin ít nằm chờ nhất; các bản tin cách nó không quá `REPLAY_SKEW_THRESHOLD_S` (5 giây) là nhóm live. Epoch chỉ cho số đo khi nhóm live có ít nhất hai bản tin cách nhau quá 5 giây trên đồng hồ trụ. Số đo là **trung vị** độ lệch của nhóm live.
2. **Phiên trải nhiều epoch.** Lấy số đo của epoch đầu tiên đo được. Epoch đo được nào sau đó lệch với nó quá dung sai thì đồng hồ đã đổi giữa phiên, không có một độ lệch chung (`tariff_clock_offset_unstable`, về bước 4). Epoch không đo được không tham gia.
3. **Đồng hồ sai** nghĩa là |số đo| > `TARIFF_CLOCK_TOLERANCE_S` (mặc định 300 giây). Khi đó cộng độ lệch, làm tròn tới giây, vào mọi mốc giờ trụ của phiên (bắt đầu, dừng, từng mẫu công tơ) rồi chia khung giá như thường; ghi `sessions.priced_clock = 'cp_offset'` và một bản ghi `tariff_clock_offset` có `offset_s=…`. Số đo trong dung sai, hoặc không đo được, thì dùng nguyên giờ trụ (`priced_clock = 'cp'`, không có bản ghi).
4. **Kiểm lại các mốc đã chỉnh** (bảng dưới). Có mốc không qua thì không có độ lệch nào giải thích được phiên: tính **cả phiên theo một khung giá**, khung có hiệu lực tại `received_started_at`, ghi `priced_clock = 'csms'` và một bản ghi `tariff_clock_fallback` có `reason=…`. Job quyết toán đi tiếp ngay, không chờ và không thử lại.

Use case: một trụ có đồng hồ chậm 10 phút, tài xế sạc 11:55–12:05. Giờ trụ ghi 11:45–11:55 nên trước T134 cả phiên bị tính giá Normal hoặc rơi về giờ CSMS và kẹt chờ số đo tại biên. Nay năm bản tin live đều lệch +600 giây, CSMS cộng 600 giây và chia đúng 5 phút Normal, 5 phút Peak (UC-CHG-03, BR-P02).

### Vì sao nhận diện live không dùng cờ `replayed`

OCPP 1.6 không có cờ live / phát bù. Cờ `replayed` của ReplayDetector so giờ trụ với giờ nhận, nên trụ chậm quá 5 giây thì mọi bản tin live đều mang cờ phát lại, và độ lệch dương không bao giờ đo được. Thời gian nằm trong hàng đợi offline chỉ làm độ lệch **lớn lên**, vì vậy độ lệch nhỏ nhất của epoch là mốc so không phụ thuộc đồng hồ trụ. Một loạt phát bù tới dồn (các bản tin tạo cách nhau một nhịp lấy mẫu, nhận cách nhau vài mili giây) có độ lệch khác nhau từng nhịp nên không tạo được hai bản tin cùng độ lệch.

### Giới hạn đã biết

- Một bản tin đơn lẻ không phân biệt được "đồng hồ chậm" với "nằm chờ trong hàng đợi". Phiên chỉ có StartTransaction live còn StopTransaction phát bù (hoặc ngược lại) không đo được và dùng nguyên giờ trụ.
- Phiên diễn ra hoàn toàn offline không có bản tin live. Đồng hồ nhanh bị phát hiện vì mốc giờ nằm ở tương lai so với lúc nhận (về bước 4). Đồng hồ **chậm** thì không phân biệt được với phát bù muộn: phiên được tính theo giờ trụ như một phiên offline bình thường.
- Nhịp lấy mẫu từ 5 giây trở xuống làm một loạt phát bù trông giống nhóm live. Cấu hình mặc định và staging dùng nhịp 10 giây (`METER_VALUE_SAMPLE_INTERVAL_S`).

## Dấu vết và điều kiện quyết toán

Các kiểm tra áp trên mốc giờ trụ **đã cộng độ lệch**. Mốc gốc trong DB (`cp_started_at`, `cp_stopped_at`, `meter_values.cp_timestamp`) không bị sửa.

| Bằng chứng | Cách kiểm tra |
| --- | --- |
| StartTransaction | Tìm CALL inbound hợp lệ theo trụ, `received_started_at`, `cp_started_at`, connector, idTag và meterStart. Kiểm lại chuỗi timestamp gốc và epoch của log. |
| StopTransaction | Tìm CALL inbound hợp lệ theo trụ, `received_stopped_at`, `cp_stopped_at`, transaction id và meterStop. Kiểm lại chuỗi gốc, thứ tự start/stop trên đồng hồ trụ và thứ tự nhận/epoch phía CSMS. |
| MeterValues và StopTransaction.transactionData | Kiểm từng timestamp của mẫu điện năng tích luỹ tổng. Mẫu phải thuộc khoảng start–stop, có bản tin gốc khớp thời điểm nhận, epoch và transaction. MeterValues còn khớp connector. Mẫu live (đến trong dung sai) không được lùi giữa các lần nhận của cùng epoch. Mẫu đến trễ, kể cả trễ hơn dung sai trong cùng epoch, được chấp nhận: đó là mẫu phát bù. |
| Connection epoch | Ghép `charge_point_connections` theo trụ và epoch. Thời điểm nhận phải nằm trong khoảng mở–đóng. Mốc giờ không được đi trước thời điểm nhận quá dung sai (`tariff_clock_future_timestamp`). Mốc đứng trước epoch nhận quá dung sai phải nằm trong lịch sử kể từ epoch 1 của trụ. |

Lý do rơi về giờ CSMS (`reason` của bản ghi `tariff_clock_fallback`): `tariff_clock_invalid_timestamp`, `tariff_clock_conflicting_stop`, `tariff_clock_frame_unverified`, `tariff_clock_epoch_unverified`, `tariff_clock_future_timestamp`, `tariff_clock_reversed_session`, `tariff_clock_sample_outside_session`, `tariff_clock_sample_frame_unverified`, `tariff_clock_sample_out_of_order`, `tariff_clock_offset_unstable`. Lý do `tariff_clock_ambiguous_delay` của T101 đã bỏ; bản ghi cũ mang lý do này vẫn đọc được.

Các truy vấn log dùng trụ và thời điểm nhận cụ thể, có thêm điều kiện epoch cho từng mẫu. Thời điểm nhận là khóa partition của `ocpp_message_log`. Frame bị kiểm schema từ chối vẫn đi theo đường CALLERROR và log hiện có.

**Timestamp của mẫu công tơ.** Timestamp dùng được cho khung giá phải có múi giờ và phần lẻ không quá mili giây (chữ số dư phải bằng 0, để việc chuẩn hoá không biến mẫu gần biên thành mẫu đúng biên). Từ T134, mẫu có timestamp thiếu múi giờ (coi là UTC) hoặc có phần lẻ dài hơn mili giây (cắt bớt) **vẫn được lưu** để không mất số đo điện năng; phiên bị đánh dấu `TARIFF_CLOCK_UNTRUSTED` và quyết toán theo giờ CSMS. Chỉ ngày giờ không tồn tại (30/02, giờ 24) mới không lưu được mẫu.

Giá Peak, Normal và Off-peak áp dụng theo lịch `Asia/Ho_Chi_Minh`. Tổng các phần tính bằng Wh và milli-VND, sau đó làm tròn half-up một lần theo BR-P45.

Với `cp` và `cp_offset`, mỗi biên khung giá bên trong phiên vẫn cần số đo tích luỹ đúng thời điểm (không nội suy): mẫu đã xác minh có giờ trụ đúng bằng biên trừ độ lệch, hoặc bằng chứng biên do operator ghi nhận qua `ChargeSettlementService.recordTariffBoundary` trên cùng trục giờ (`pricing_clock` = `cp` hoặc `cp_offset`). Thiếu thì job ở `tariff_coverage_or_boundary_meter_required`; đây là thiếu số đo, không phải lỗi đồng hồ, và có từ T72. Luồng nhập bằng chứng hiện chỉ có ở service, operator chưa có route hoặc UI. Với `csms` không có biên nào cần số đo; `recordTariffBoundary` trả `boundary_not_applicable`.

## Audit và quyết toán

- Quyết toán kiểm trạng thái `reconciled` và điều kiện meter trước khi đọc log gốc dưới khoá phiên. Phạm vi đủ điều kiện gồm app có intent và các ca được gán theo BE-24.
- Khi post, debit, statement, các phần giá và `sessions.priced_clock` / `priced_ended_at` được ghi trong cùng giao dịch, cùng với đúng một bản ghi `tariff_clock_offset` (resolution `tariff_clock=cp_offset offset_s=… epoch=… live_frames=…`) hoặc `tariff_clock_fallback` (`tariff_clock=csms_fallback reason=…`) nếu có chỉnh. Operator xem qua console. Audit tính giá vẫn được ghi khi tắt engine đối soát để chạy ablation. Retry giữ đúng một debit và cho phép số dư âm theo BR-P20.
- Bản tin lặp đúng timestamp và số đo tương đương giữ nguyên dữ liệu. Bản tin lặp có số đo mâu thuẫn giữ phiên chưa debit ở `review` và ghi bản ghi `conflict` có tiền tố `meter_evidence_conflict`. Bản ghi này không phải xung đột điện năng của đối soát: console (`reconciliation_conflicts`, `has_conflict`) và harness RQ1 (`conflict_records`) không đếm nó; console hiển thị loại `meter_evidence_conflict`. `OPERATOR_RESOLVED` cho phép quyết toán theo bằng chứng được xác nhận. Nếu đã có debit, bằng chứng muộn được ghi lại và statement đã phát hành được giữ nguyên.
- Cột pricing của statement đã post trước migration 0020 giữ `NULL`. Với K3/T108, dùng `(priced_ended_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` để nhóm theo ngày đã tính giá; với `cp_offset` đó là giờ dừng của trụ đã cộng độ lệch.
- Nhánh đọc sự kiện `TARIFF_CLOCK_HOLD` (dữ liệu thử nghiệm trước khi T101 merge, chưa từng được ghi trên `main`) đã bỏ.

## Đối chiếu mã nguồn

- **SteVe (`2ba0c8e`, GPL-3.0).** Validator Java và test biên thời gian là tham chiếu cho dung sai 300 giây. PowerMe còn kiểm log gốc và lịch sử epoch. [Validator](https://github.com/steve-community/steve/blob/2ba0c8e80c1aab258f55715a0c012d95b82cc146/src/main/java/de/rwth/idsg/steve/service/CentralSystemService16_ServiceValidator.java), [test](https://github.com/steve-community/steve/blob/2ba0c8e80c1aab258f55715a0c012d95b82cc146/src/test/java/de/rwth/idsg/steve/service/CentralSystemService16ServiceValidatorTest.java).
- **CitrineOS (`4fd7599`, Apache-2.0).** Handler OCPP 1.6 và test là tham chiếu về việc xác nhận StopTransaction lặp. Bộ tính giá TypeScript được đối chiếu với luồng quyết toán PowerMe. Khi thiếu bằng chứng, PowerMe giữ pending với lý do cụ thể và chỉ tính giá khi guard cho phép. [Handler](https://github.com/citrineos/citrineos-core/blob/4fd7599b91c2fb6e6065e7c9b94be69880cced27/packages/ocpp/src/handlers/requests/1.6/stop-transaction-request-ocpp-16-handler.ts), [test](https://github.com/citrineos/citrineos-core/blob/4fd7599b91c2fb6e6065e7c9b94be69880cced27/packages/ocpp/test/handlers/requests/1.6/stop-transaction-request-ocpp-16-handler.test.ts), [bộ tính giá](https://github.com/citrineos/citrineos-core/blob/4fd7599b91c2fb6e6065e7c9b94be69880cced27/packages/ocpp/src/modules/transactions/cost-calculator.ts).

T101 dùng các nguồn này ở mức tham chiếu thiết kế, không sao chép mã, thêm dependency hoặc mặc định chi phí bằng 0 khi thiếu bằng chứng.

## Kiểm thử local

Chạy từ thư mục gốc repo với Node 24 và dependencies đã cài. Mở PostgreSQL nhúng trên loopback bằng lệnh sau, rồi giữ terminal này mở trong lúc test.

```sh
npm run demo:db -w @powerme/csms
```

Ở terminal thứ hai, dùng URL `powerme_test` mà lệnh trên in ra. Suite tích hợp reset schema của database test. Ví dụ với cổng mặc định trong shell POSIX:

```sh
DATABASE_URL=postgresql://powerme:powerme@127.0.0.1:54330/powerme_test \
  npm test -w @powerme/csms -- --runInBand
npm run typecheck -w @powerme/csms
npm run build -w @powerme/csms
```

Trong PowerShell, đặt `$env:DATABASE_URL` bằng URL trên trước khi chạy cùng lệnh `npm test`. Dừng PostgreSQL bằng Ctrl+C ở terminal đầu.

WF-01 dùng gateway, log và epoch thật trong database test. Các ca T101 bao phủ biên giá, nửa đêm ICT, mẫu đến muộn sau kết nối lại, nhiều mẫu cùng frame, fallback, xung đột công tơ, số dư âm, chứng cứ biên và retry đồng thời. Các ca T134: (a) đồng hồ lệch đúng 10 phút (chậm và nhanh) với phiên vắt qua biên giá; (b) phiên hoàn toàn offline với đồng hồ sai; (c) mẫu phát bù tới trễ hơn 300 giây; độ lệch đổi giữa hai epoch; mẫu có timestamp thiếu múi giờ. Phép đo độ lệch là hàm thuần, test ở `src/reconciliation/tariff-clock.spec.ts`.
