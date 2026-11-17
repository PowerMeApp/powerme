# T101 / T134 — Quy tắc đồng hồ khung giá

Nguồn yêu cầu là [RP3 §5.1](requirements/report3-srs.md) BR-P02, BR-P45 và BR-P48. T101 (#120, base `508fd0e`) đưa vào việc kiểm đồng hồ trụ và phương án dùng giờ CSMS. **T134 (quyết định D-I ngày 14/11/2026) thay quy tắc xử lý khi đồng hồ trụ sai**: đo độ lệch trên các bản tin gửi live trong cùng connection epoch rồi cộng vào giờ trụ; chỉ khi không có độ lệch nào dùng được mới tính cả phiên theo khung giá lúc CSMS nhận StartTransaction. Phiên không còn bị giữ vì đồng hồ, và không còn bị giữ vì thiếu mẫu công tơ ở biên khung giá. Mã: `apps/csms/src/reconciliation/tariff-clock.ts`, `apps/csms/src/sessions/charge-settlement.service.ts`, migration 0020 và 0023.

Các điểm ghi "quyết định 17/11" là quyết định của Trí ngày 17/11/2026 sau review PR #154, theo uỷ quyền của PM (Ân để Trí tự quyết các câu hỏi mở của T134).

## Quy tắc (T134)

Độ lệch của một bản tin = giờ CSMS nhận − giờ trụ ghi trong bản tin. Dương nghĩa là đồng hồ trụ chậm.

1. **Đo theo từng epoch, chỉ trên bản tin live.** Ứng viên là StartTransaction, từng MeterValues.req (lấy mẫu mới nhất trong bản tin) và StopTransaction của phiên (quyết định 17/11: StopTransaction được tính). Một **cụm live** là các bản tin của epoch có độ lệch cách nhau không quá `REPLAY_SKEW_THRESHOLD_S` (5 giây), tức khoảng nhận giữa bản tin đầu và cuối cụm xấp xỉ khoảng giờ trụ của chúng, và đủ dài để không thể là một loạt phát bù tới dồn: trải ít nhất 60 giây trên đồng hồ trụ, hoặc có từ ba bản tin trải quá 10 giây. Số đo của cụm là **trung vị** độ lệch.
2. **Đồng hồ đổi trong một epoch.** Một epoch có hai cụm live lệch nhau quá dung sai nghĩa là đồng hồ bị chỉnh giữa chừng (Heartbeat.conf đồng bộ giờ): `tariff_clock_offset_unstable`, về bước 5. Hai cụm trong dung sai (mạng nghẽn đều) thì lấy cụm lệch nhỏ nhất, vì thời gian chờ chỉ làm độ lệch lớn lên.
3. **Đồng hồ sai** khi có epoch đo được |độ lệch| > `TARIFF_CLOCK_TOLERANCE_S` (mặc định 300 giây). Khi đó (quyết định 17/11) **mọi** epoch có bản tin của phiên phải đo được và khớp nhau trong dung sai; có epoch không đo được hoặc lệch nhau thì `tariff_clock_offset_unstable`, về bước 5. Đạt thì cộng độ lệch của epoch đầu, làm tròn tới giây, vào mọi mốc giờ trụ của phiên (bắt đầu, dừng, từng mẫu công tơ) rồi chia khung giá như thường; ghi `sessions.priced_clock = 'cp_offset'` và một bản ghi `tariff_clock_offset` có `offset_s=…`.
4. **Đồng hồ không sai**: mọi số đo trong dung sai, hoặc không epoch nào đo được. Dùng nguyên giờ trụ (`priced_clock = 'cp'`, không có bản ghi); không cần mọi epoch đo được.
5. **Kiểm lại các mốc** (đã chỉnh hoặc giữ nguyên; bảng dưới). Không ổn định, hoặc có mốc không qua, thì không có độ lệch nào giải thích được phiên: tính **cả phiên theo một khung giá**, khung có hiệu lực tại `received_started_at`, ghi `priced_clock = 'csms'` và một bản ghi `tariff_clock_fallback` có `reason=…`. Job quyết toán đi tiếp ngay, không chờ và không thử lại.

Use case: một trụ có đồng hồ chậm 10 phút, tài xế sạc 11:55–12:05. Giờ trụ ghi 11:45–11:55 nên trước T134 cả phiên bị tính giá Normal hoặc rơi về giờ CSMS và kẹt chờ số đo tại biên. Nay năm bản tin live đều lệch +600 giây, CSMS cộng 600 giây và chia đúng 5 phút Normal, 5 phút Peak (UC-CHG-03, BR-P02).

### Vì sao nhận diện live không dùng cờ `replayed`

OCPP 1.6 không có cờ live / phát bù. Cờ `replayed` của ReplayDetector so giờ trụ với giờ nhận, nên trụ chậm quá 5 giây thì mọi bản tin live đều mang cờ phát lại, và độ lệch dương không bao giờ đo được. Nhịp thì không phụ thuộc đồng hồ trụ: bản tin live được nhận cách nhau đúng bằng khoảng chúng được tạo, còn một loạt phát bù tới dồn (các bản tin tạo cách nhau một nhịp lấy mẫu, nhận cách nhau vài chục mili giây) có độ lệch khác nhau từng nhịp.

Ba cửa sổ tính sai mà review #154 chỉ ra, và cách đã đóng (đều có test đi qua gateway, biên 12:00 ICT):

| Ca | Tình huống | Trước | Nay |
| --- | --- | --- | --- |
| H1 | Trụ chậm 10 phút, phiên thật 11:50–12:21; Heartbeat.conf lúc 12:14:30 đồng bộ giờ, bản tin từ 12:15 lệch 0 | Cụm lệch nhỏ nhất (sau khi chỉnh) thắng: `cp`, không bản ghi, 10 phút Peak bị tính Normal | Hai cụm live lệch nhau 600 giây trong một epoch: `tariff_clock_offset_unstable`, giờ CSMS, có bản ghi |
| H2 | Đồng hồ đúng, phiên offline, mẫu cuối 11:49:55,0 và stop 11:50:00,5 phát bù lúc 12:30, tới cách nhau 0,6 giây | Hai bản tin lệch nhau 4,9 giây, trải 5,5 giây giờ trụ: bị đọc thành đồng hồ chậm ~2403 giây | Cụm hai bản tin phải trải ít nhất 60 giây: không đo được, tính Normal theo giờ trụ |
| H3 | Trụ nhanh 10 phút, bắt đầu thật 11:40, mẫu live tới 11:55, rớt mạng, nối lại có Boot chỉnh giờ, stop thật 12:05 | Epoch 2 không đo được nên nhận −600 giây của epoch 1 | Đồng hồ sai mà epoch 2 không đo được: `tariff_clock_offset_unstable`, giờ CSMS, có bản ghi |

### Giới hạn đã biết

- **Một bản tin đơn lẻ** không phân biệt được "đồng hồ chậm" với "nằm chờ trong hàng đợi". Phiên chỉ có một bản tin live trong epoch (hoặc hai bản tin cách nhau dưới 60 giây) không đo được và dùng nguyên giờ trụ.
- **Phiên diễn ra hoàn toàn offline** không có bản tin live nào (quyết định 17/11: giữ cách dùng giờ trụ khi các mốc qua kiểm tra, chỉ rơi về giờ CSMS khi kiểm tra thất bại; nếu rơi về giờ CSMS thì phiên offline có đồng hồ đúng bị tính theo khung giá lúc nối lại). Hệ quả:
  - Đồng hồ **chậm** không phát hiện được, vì giống hệt phát bù muộn. Ví dụ: trụ chậm 30 phút, phiên thật 11:50–12:10 (10 phút Normal, 10 phút Peak), phát bù lúc 12:30. Giờ trụ ghi 11:20–11:40, mọi kiểm tra đều qua, cả phiên bị tính Normal.
  - Đồng hồ **nhanh** chỉ bị phát hiện khi mốc giờ còn nằm ở tương lai lúc CSMS nhận. Độ trễ nối lại lớn hơn độ nhanh thì không phát hiện được. Ví dụ: trụ nhanh 20 phút, phiên thật 11:30–11:50 (toàn Normal), phát bù lúc 12:40. Giờ trụ ghi 11:50–12:10 đã ở quá khứ, 10 phút bị tính Peak.
- **Đồng hồ sai và phiên kết thúc offline** (StopTransaction phát bù ở epoch sau): epoch sau không đo được nên phiên rơi về giờ CSMS dù phần live đo được. Đây là giá của quyết định 17/11 về nhiều epoch (thà một khung giá có bản ghi còn hơn cộng một độ lệch không kiểm được).
- **Nhịp lấy mẫu rất ngắn**: ba bản tin phát bù trải quá 10 giây giờ trụ mà được nhận cũng trải ngần ấy thời gian thì không còn là một loạt tới dồn; trường hợp đó được coi là live.

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

**Timestamp của mẫu công tơ.** Timestamp dùng được cho khung giá phải có múi giờ và phần lẻ không quá mili giây (chữ số dư phải bằng 0). Bước kiểm schema của `ocpp-rpc` (`strictMode`) **cho qua** cả timestamp thiếu múi giờ lẫn timestamp có phần lẻ dài hơn mili giây (đã kiểm bằng test gửi bản tin thô qua gateway thật), nên nhánh xử lý dưới đây chạy được trong thực tế. Từ T134 các mẫu đó **vẫn được lưu** để không mất số đo điện năng; phiên bị đánh dấu `TARIFF_CLOCK_UNTRUSTED` và quyết toán theo giờ CSMS. Phần lẻ dài hơn mili giây thì cắt tới mili giây. Thiếu múi giờ thì không biết trụ ghi giờ nào (đọc là UTC thì giờ địa phương lệch 7 giờ và đối soát thấy `gap_detected` giả), nên mẫu được lưu với **giờ CSMS nhận** làm `cp_timestamp` thay thế (cộng thứ tự trong bản tin tính bằng mili giây để các mẫu cùng bản tin không trùng mốc). Chỉ ngày giờ không tồn tại (30/02, giờ 24) mới không lưu được mẫu. Chưa đổi: `StartTransaction.timestamp` và cột `cp_timestamp` của `ocpp_message_log` vẫn đọc bằng `new Date()`, thiếu múi giờ thì theo múi giờ máy chủ.

Giá Peak, Normal và Off-peak áp dụng theo lịch `Asia/Ho_Chi_Minh`. Tổng các phần tính bằng Wh và milli-VND, sau đó làm tròn half-up một lần theo BR-P45.

### Số đo tại biên khung giá: nội suy (quyết định 17/11)

Với `cp` và `cp_offset`, mỗi biên khung giá bên trong phiên cần số Wh tích luỹ tại đúng thời điểm đó. Thứ tự ưu tiên:

1. bằng chứng biên do operator ghi nhận qua `ChargeSettlementService.recordTariffBoundary` trên cùng trục giờ (`pricing_clock` = `cp` hoặc `cp_offset`);
2. mẫu công tơ đã xác minh có giờ (đã cộng độ lệch) đúng bằng biên;
3. **nội suy tuyến tính** giữa hai số đo kề biên trên trục giờ tính giá: mẫu ngay trước và ngay sau biên, trong đó mốc bắt đầu với `meterStart` và mốc dừng với `meterStop` cũng là số đo.

BR-P02 không cấm nội suy; T72 và T101 giữ phiên chờ số đo đúng biên, và review #154 chỉ ra rằng sau khi cộng độ lệch mẫu hiếm khi rơi đúng biên trong khi operator chưa có route hay UI nhập bằng chứng, nên phiên vắt biên sẽ kẹt. Sai số của nội suy bị chặn bởi điện năng của đúng một khoảng mẫu (hai số đo kề biên), nhân với chênh lệch giá hai khung.

Wh tại biên được làm tròn về số nguyên và kẹp trong khoảng [số đo của biên trước, `meterStop`], nên tổng điện năng các phần luôn đúng bằng điện năng của phiên; tiền vẫn cộng theo milli-VND rồi làm tròn half-up một lần (BR-P45). Khi có ít nhất một biên phải nội suy, quyết toán ghi **một** bản ghi `tariff_boundary_interpolated` cho phiên, resolution `tariff_boundary=interpolated boundaries=N max_gap_s=X` (N biên nội suy, X giây là khoảng cách lớn nhất giữa hai số đo dùng để nội suy). Mẫu đúng biên và bằng chứng của operator không sinh bản ghi.

Use case: tài xế sạc 11:55–12:05, trụ gửi mẫu mỗi 4 phút (11:58: 1300 Wh, 12:02: 1500 Wh). Không có mẫu lúc 12:00; CSMS lấy 1400 Wh tại 12:00, tính 400 Wh giá Normal và 400 Wh giá Peak, trừ tiền một lần và ghi `boundaries=1 max_gap_s=240` (UC-CHG-03).

Sau thay đổi này không còn đường nào để job chờ ở `tariff_coverage_or_boundary_meter_required` vì thiếu mẫu ở biên. Lý do đó chỉ còn cho lỗi cấu hình biểu giá: không có khung giá nào, hoặc có hai khung cùng phủ một thời điểm; job thử lại theo lịch chung và đi tiếp khi biểu giá được sửa. Với `csms` không có biên nào cần số đo; `recordTariffBoundary` trả `boundary_not_applicable`.

## Audit và quyết toán

- Quyết toán kiểm trạng thái `reconciled` và điều kiện meter trước khi đọc log gốc dưới khoá phiên. Phạm vi đủ điều kiện gồm app có intent và các ca được gán theo BE-24.
- Khi post, debit, statement, các phần giá và `sessions.priced_clock` / `priced_ended_at` được ghi trong cùng giao dịch, cùng với đúng một bản ghi `tariff_clock_offset` (resolution `tariff_clock=cp_offset offset_s=… epoch=… live_frames=…`) hoặc `tariff_clock_fallback` (`tariff_clock=csms_fallback reason=…`) nếu có chỉnh, và một bản ghi `tariff_boundary_interpolated` nếu có biên nội suy. Operator xem qua console. Audit tính giá vẫn được ghi khi tắt engine đối soát để chạy ablation. Retry giữ đúng một debit và cho phép số dư âm theo BR-P20.
- Bản tin lặp đúng timestamp và số đo tương đương giữ nguyên dữ liệu. Bản tin lặp có số đo mâu thuẫn giữ phiên chưa debit ở `review` và ghi bản ghi `conflict` có tiền tố `meter_evidence_conflict`. Bản ghi này không phải xung đột điện năng của đối soát: console (`reconciliation_conflicts`, `reconciliation_by_type.conflict`, `has_conflict`) và harness RQ1 (`conflict_records`) không đếm nó, engine đối soát không lấy nó làm "kết luận gần nhất" khi so mẫu muộn; console hiển thị loại `meter_evidence_conflict`. `OPERATOR_RESOLVED` cho phép quyết toán theo bằng chứng được xác nhận. Nếu đã có debit, bằng chứng muộn được ghi lại và statement đã phát hành được giữ nguyên.
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

WF-01 dùng gateway, log và epoch thật trong database test. Các ca T101 bao phủ biên giá, nửa đêm ICT, mẫu đến muộn sau kết nối lại, nhiều mẫu cùng frame, fallback, xung đột công tơ, số dư âm, chứng cứ biên và retry đồng thời. Các ca T134: (a) đồng hồ lệch đúng 10 phút (chậm, nhanh, và số đo không tròn giây 600,4 s) với phiên vắt qua biên giá; (b) phiên hoàn toàn offline với đồng hồ sai; (c) mẫu phát bù tới trễ hơn 300 giây; H1–H3 ở bảng trên; độ lệch đổi giữa hai epoch; biên không có mẫu (nội suy, với `cp` và `cp_offset`); mẫu có timestamp thiếu múi giờ gửi thô qua gateway thật. Phép đo độ lệch là hàm thuần, test ở `src/reconciliation/tariff-clock.spec.ts`.
