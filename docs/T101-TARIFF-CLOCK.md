# T101 — Quy tắc đồng hồ khung giá

Nguồn yêu cầu là [RP3 §5.1](requirements/report3-srs.md) BR-P02, BR-P45 và BR-P48. Nhánh `wp3/t101-quy-tac-dong-ho-khung-gia` dùng mã T101 được giao trực tiếp vì chưa tìm thấy mã MB tương ứng trong kế hoạch. Base local là `508fd0e`.

## Dấu vết và điều kiện quyết toán

| Bằng chứng | Cách kiểm tra |
| --- | --- |
| StartTransaction | Tìm CALL inbound hợp lệ theo trụ, `received_started_at`, `cp_started_at`, connector, idTag và meterStart. Kiểm lại chuỗi timestamp gốc và epoch của log. |
| StopTransaction | Tìm CALL inbound hợp lệ theo trụ, `received_stopped_at`, `cp_stopped_at`, transaction id và meterStop. Kiểm lại chuỗi gốc, thứ tự start/stop trên đồng hồ trụ và thứ tự nhận/epoch phía CSMS. |
| MeterValues và StopTransaction.transactionData | Kiểm từng timestamp của mẫu điện năng tích luỹ tổng dùng cho quyết toán. Mẫu phải thuộc khoảng start–stop, có bản tin gốc khớp thời điểm nhận, epoch và transaction. MeterValues còn khớp connector. Mẫu live lùi giữa các lần nhận trong cùng epoch bị giữ. Các mẫu trong cùng batch hoặc replay có thể đến khác thứ tự. |
| Connection epoch | Ghép `charge_point_connections` theo trụ và epoch. Thời điểm nhận phải nằm trong khoảng mở–đóng. Dùng dung sai `REPLAY_SKEW_THRESHOLD_S` hiện có (mặc định 5 giây) cho timestamp live và giới hạn timestamp đi trước lúc nhận. |

Độ trễ lớn hơn dung sai chỉ được dùng khi timestamp đứng trước epoch nhận và nằm trong lịch sử kể từ epoch 1 của trụ, với cùng dung sai ở hai mốc. Timestamp trễ trong cùng epoch thiếu bằng chứng phân biệt clock lệch và truyền chậm nên bị giữ. Mẫu thuộc `transactionData` của một StopTransaction khớp phiên có thể được lấy mẫu sớm hơn trong cùng epoch. Kiểm tra này xác nhận tính nhất quán của bằng chứng CSMS đang lưu. Nó không xác thực độ chính xác của đồng hồ phần cứng. Nhãn `replayed` của gateway chỉ dùng để phân loại và theo dõi.

Các truy vấn log dùng trụ và thời điểm nhận cụ thể, có thêm điều kiện epoch cho từng mẫu. Thời điểm nhận là khóa partition của `ocpp_message_log`. Trình phân tích kiểm ngày và offset trên chuỗi gốc trước khi dùng thời điểm đã chuẩn hoá. Phần lẻ có độ chính xác nhỏ hơn mili giây chỉ được chấp nhận nếu các chữ số dư đều bằng 0, để việc chuẩn hoá của JavaScript không biến mẫu gần biên thành mẫu đúng biên. Frame bị kiểm schema từ chối vẫn đi theo đường CALLERROR và log hiện có.

Giá Peak, Normal và Off-peak áp dụng theo lịch `Asia/Ho_Chi_Minh`. Thời điểm lưu bằng `timestamptz`, kể cả biên UTC tương ứng với nửa đêm ICT. Dùng đồng hồ trụ đã kiểm tra cho cả live và replay. Mỗi biên bên trong phiên cần số đo đúng thời điểm hoặc bằng chứng biên có audit của operator theo T72. Thiếu biên giữ `tariff_coverage_or_boundary_meter_required`. Tổng các phần tính bằng Wh và milli-VND, sau đó làm tròn half-up một lần theo BR-P45.

## Xung đột, giữ quyết toán và giới hạn phục hồi

- Lặp đúng timestamp và số đo tương đương giữ nguyên dữ liệu. Stop lặp tiếp tục để lại audit `orphan_stop` theo đường hiện hành. Mẫu hoặc stop lặp mâu thuẫn ghi `TARIFF_CLOCK_HOLD` trong lịch sử phiên, kèm id log. Với đối soát bật, xung đột cũng ghi vào `reconciliation_records` và phiên chưa thu tiền chuyển review theo STM-1. Nếu đã có debit thì giữ statement đã phát hành và ghi bằng chứng đến muộn.
- Guard chạy trong giao dịch quyết toán, dưới khoá phiên dùng chung với cập nhật stop/meter. Lỗi đồng hồ hiển thị qua `charge_settlement_jobs.reason` và `settlement_reason` hiện có. Chế độ ablation vẫn bỏ đối chiếu công tơ và `reconciliation_records`. Guard tiền chạy cả khi ablation bật.
- Bằng chứng biên theo T72 có thể phục hồi job thiếu số đo biên nếu timeline đã qua kiểm tra. Generic review có thể xử lý verdict về năng lượng hoặc ghi nhận đã xem xung đột. Nó không sửa được clock, gỡ `TARIFF_CLOCK_HOLD` hay cho phép debit khi clock vẫn lỗi. Hiện chưa có quy trình được hỗ trợ để sửa timestamp hoặc giải toả hold này. Phiên giữ pending với lý do cụ thể.
- Quyết toán phiên cũ chưa post phụ thuộc vào việc còn log gốc và lịch sử epoch. Thiếu log sau retention, thiếu epoch hoặc provenance không rõ sẽ giữ pending. Statement đã post tiếp tục dùng cơ chế idempotency hiện có.
- Điều kiện đủ tư cách quyết toán gồm app có intent và các ca được gán theo BE-24.

API cho operator giải toả clock hold, cơ chế giữ bằng chứng cho các job pending qua kỳ retention và quyết toán RFID `csms_billed` thông thường (T115) nằm ngoài phạm vi T101.

## Đối chiếu mã nguồn

- **SteVe (`2ba0c8e`, GPL-3.0).** Validator Java và test biên thời gian là tham chiếu về kiểm timestamp. PowerMe dùng dung sai giây sẵn có và bằng chứng epoch của CSMS. Ngưỡng 5 phút của SteVe chỉ dùng để đối chiếu. [Validator](https://github.com/steve-community/steve/blob/2ba0c8e80c1aab258f55715a0c012d95b82cc146/src/main/java/de/rwth/idsg/steve/service/CentralSystemService16_ServiceValidator.java), [test](https://github.com/steve-community/steve/blob/2ba0c8e80c1aab258f55715a0c012d95b82cc146/src/test/java/de/rwth/idsg/steve/service/CentralSystemService16ServiceValidatorTest.java).
- **CitrineOS (`4fd7599`, Apache-2.0).** Handler OCPP 1.6 và test là tham chiếu về việc xác nhận StopTransaction lặp. Bộ tính giá TypeScript được đối chiếu với luồng quyết toán PowerMe. Khi thiếu bằng chứng, PowerMe giữ pending với lý do cụ thể và chỉ tính giá khi guard cho phép. [Handler](https://github.com/citrineos/citrineos-core/blob/4fd7599b91c2fb6e6065e7c9b94be69880cced27/packages/ocpp/src/handlers/requests/1.6/stop-transaction-request-ocpp-16-handler.ts), [test](https://github.com/citrineos/citrineos-core/blob/4fd7599b91c2fb6e6065e7c9b94be69880cced27/packages/ocpp/test/handlers/requests/1.6/stop-transaction-request-ocpp-16-handler.test.ts), [bộ tính giá](https://github.com/citrineos/citrineos-core/blob/4fd7599b91c2fb6e6065e7c9b94be69880cced27/packages/ocpp/src/modules/transactions/cost-calculator.ts).

T101 dùng các nguồn này ở mức tham chiếu thiết kế, không sao chép mã, thêm dependency hoặc mặc định chi phí bằng 0 khi thiếu bằng chứng.

## Kiểm thử local

Runner dùng PostgreSQL nhúng đã cài sẵn trong workspace, Node 24.22.1 và database mới `powerme_test` trên loopback riêng. Thư mục cluster và log nằm dưới `E:/Project/PowerMe/.review/t101`. Không sử dụng DB, migration, seed hay CSMS trên staging.

| Lệnh | Kết quả |
| --- | --- |
| `node .review/t101/run-isolated.mjs pg-clean-baseline wf01-driver-charging.integration be24-unattributed.integration wf03-ablation.integration wf03-exp01.integration session-history.integration` với `T101_SOURCE_DIR` trỏ vào bản archive `508fd0e` | 206 test pass, 5 suite. |
| `node .review/t101/run-isolated.mjs pg-review-recheck wf01-driver-charging.integration -t "review exposes pending reason"` | Test T72 đi qua operator review thật và post đúng số tiền. |
| `node .review/t101/run-isolated.mjs pg-final-exact tariff-clock.spec replay-detector.spec reconciliation.service.spec wf01-driver-charging.integration be24-unattributed.integration wf03-ablation.integration wf03-exp01.integration session-history.integration be18-operator-resolve.integration` | 276 test pass, 9 suite. Log `jest-pg-final-exact.log`. |
| `npm run format:check`, `npm run typecheck -w @powerme/csms`, `npm run build -w @powerme/csms` | Pass. |
| `npm run lint` | Exit 0. Các workspace hiện không có script lint riêng. |

Các ca tariff trong WF-01 dùng gateway và log/epoch thật trong DB local, với thời điểm CP và receipt cố định do test đưa vào. Các ca live thường dùng OCPP WebSocket local. Test bao phủ biên đúng giờ, hai khung giá, nửa đêm ICT, replay nhận muộn, clock sai hoặc lùi, lặp tương đương Wh/kWh, xung đột trước và sau debit, thiếu số đo biên và settlement đồng thời. Bằng chứng là test phần mềm trên PostgreSQL 17.10 nhúng. Staging PostgreSQL 16.4 và phần cứng trụ chưa được kiểm thử.
