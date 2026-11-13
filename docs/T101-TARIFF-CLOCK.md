# T101 — Quy tắc đồng hồ khung giá

Nguồn yêu cầu là [RP3 §5.1](requirements/report3-srs.md) BR-P02, BR-P45 và BR-P48. Nhánh `wp3/t101-quy-tac-dong-ho-khung-gia` dùng mã T101 được giao trực tiếp vì chưa tìm thấy mã MB tương ứng trong kế hoạch. Base local là `508fd0e`.

## Dấu vết và điều kiện quyết toán

| Bằng chứng | Cách kiểm tra |
| --- | --- |
| StartTransaction | Tìm CALL inbound hợp lệ theo trụ, `received_started_at`, `cp_started_at`, connector, idTag và meterStart. Kiểm lại chuỗi timestamp gốc và epoch của log. |
| StopTransaction | Tìm CALL inbound hợp lệ theo trụ, `received_stopped_at`, `cp_stopped_at`, transaction id và meterStop. Kiểm lại chuỗi gốc, thứ tự start/stop trên đồng hồ trụ và thứ tự nhận/epoch phía CSMS. |
| MeterValues và StopTransaction.transactionData | Kiểm từng timestamp của mẫu điện năng tích luỹ tổng. Mẫu phải thuộc khoảng start–stop, có bản tin gốc khớp thời điểm nhận, epoch và transaction. MeterValues còn khớp connector. Mẫu live lùi giữa các lần nhận hoặc được tạo trong cùng epoch nhưng đến trễ quá dung sai khiến quyết toán chuyển sang CSMS. Các mẫu trong cùng batch hoặc replay có thể đến khác thứ tự. |
| Connection epoch | Ghép `charge_point_connections` theo trụ và epoch. Thời điểm nhận phải nằm trong khoảng mở–đóng. Dùng `TARIFF_CLOCK_TOLERANCE_S` (mặc định 300 giây) để xác minh đồng hồ tính giá. ReplayDetector tiếp tục dùng `REPLAY_SKEW_THRESHOLD_S` (mặc định 5 giây). |

Độ trễ vượt dung sai được chấp nhận khi timestamp đứng trước epoch nhận quá dung sai và nằm trong lịch sử kể từ epoch 1 của trụ, có tính dung sai ở mốc đầu. Mẫu thuộc `transactionData` của StopTransaction khớp phiên cũng có thể được lấy sớm hơn trong cùng epoch. Mẫu MeterValues được tạo sau khi kết nối lại và nhận trễ quá dung sai sẽ dùng giờ CSMS khi quyết toán. Nhãn `replayed` của gateway dùng cho phân loại và theo dõi. Kiểm tra đồng hồ xác nhận tính nhất quán của log và epoch đã lưu.

Các truy vấn log dùng trụ và thời điểm nhận cụ thể, có thêm điều kiện epoch cho từng mẫu. Thời điểm nhận là khóa partition của `ocpp_message_log`. Trình phân tích kiểm ngày và offset trên chuỗi gốc trước khi dùng thời điểm đã chuẩn hoá. Phần lẻ có độ chính xác nhỏ hơn mili giây chỉ được chấp nhận nếu các chữ số dư đều bằng 0, để việc chuẩn hoá của JavaScript không biến mẫu gần biên thành mẫu đúng biên. Frame bị kiểm schema từ chối vẫn đi theo đường CALLERROR và log hiện có.

Giá Peak, Normal và Off-peak áp dụng theo lịch `Asia/Ho_Chi_Minh`. Phiên đủ điều kiện dùng giờ trụ đã xác minh cho cả live và replay. Nếu timestamp không đáng tin hoặc thiếu log xác minh, phiên dùng `received_started_at` và `received_stopped_at`. Tổng các phần tính bằng Wh và milli-VND, sau đó làm tròn half-up một lần theo BR-P45.

Mỗi biên bên trong phiên vẫn cần số đo tích luỹ đúng thời điểm theo BR-P02. Với giờ trụ, dùng mẫu đã xác minh đúng biên hoặc bằng chứng biên do operator ghi nhận. Với giờ CSMS, thời điểm nhận frame chưa chứng minh được thời điểm lấy mẫu, nên cần bằng chứng do operator xác nhận trên trục CSMS. Thiếu bằng chứng giữ job ở `tariff_coverage_or_boundary_meter_required`. Service `ChargeSettlementService.recordTariffBoundary` kiểm quyền operator sở hữu trụ, kiểm biên và khoảng số đo, lưu trục giờ cùng ghi chú, rồi đặt lịch retry ngay. Luồng này hiện chỉ có ở service. Operator chưa có route hoặc UI để nhập bằng chứng biên.

## Audit và quyết toán

- Quyết toán kiểm trạng thái `reconciled` và điều kiện meter trước khi đọc log gốc dưới khoá phiên. Phạm vi đủ điều kiện gồm app có intent và các ca được gán theo BE-24.
- Khi post, debit, statement, các phần giá và `sessions.priced_clock` / `priced_ended_at` được ghi trong cùng giao dịch. CSMS ghi đúng một record `tariff_clock_fallback` có resolution `tariff_clock=csms_fallback reason=…`. Operator xem qua console, và RQ1 tiếp tục đếm xung đột công tơ bằng `record_type='conflict'`. Audit tính giá vẫn được ghi khi tắt engine đối soát để chạy ablation. Retry giữ đúng một debit và cho phép số dư âm theo BR-P20.
- Bản tin lặp đúng timestamp và số đo tương đương giữ nguyên dữ liệu. Bản tin lặp có số đo mâu thuẫn giữ phiên chưa debit ở `review`. `OPERATOR_RESOLVED` cho phép quyết toán theo bằng chứng được xác nhận. Nếu đã có debit, bằng chứng muộn được ghi lại và statement đã phát hành được giữ nguyên.
- Job cũ chưa post được thử lại theo quy tắc mới. Nếu phiên đang `review`, operator xử lý qua `OPERATOR_RESOLVED`. Cột pricing của statement đã post trước migration 0020 giữ `NULL`. Với K3/T108, dùng `(priced_ended_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` để nhóm theo ngày đã tính giá.

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

WF-01 dùng gateway, log và epoch thật trong database test. Các ca T101 bao phủ biên giá, nửa đêm ICT, mẫu đến muộn sau kết nối lại, nhiều mẫu cùng frame, fallback, xung đột công tơ, số dư âm, chứng cứ biên và retry đồng thời.
