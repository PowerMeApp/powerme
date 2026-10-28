# Review 2 (thứ 5, 29/10/2026) — kịch bản trình bày và bộ câu hỏi

**Soạn:** Trí, 28/10/2026, sau khi kiểm 8 tài liệu nộp trên Drive và diễn tập demo trên `main`. **Dùng cho:** cả nhóm. Mọi số liệu lấy từ repo tại `main` = `48fcf00`, tag `review-2` = `1cead5d`.
**Giả định về hình thức** (hướng dẫn không ghi thời lượng): 45–60 phút một nhóm; nhóm trình bày 15–20 phút, phần còn lại hội đồng hỏi, mở code, yêu cầu sửa tại chỗ. Nếu hội đồng cắt ngắn, bỏ phần 4 trước, giữ demo WF-03 và WF-04.

---

## 1. Chuẩn bị trước giờ (phòng chờ, 10 phút)

| Ai | Việc |
|---|---|
| Trí | `git checkout main && git pull`; `npm run demo:reset -w @powerme/csms` chạy một lần cho `dist/` mới (~100 s), chạy lại lần hai (~20 s); hai tab: HMI `:8100`, console `:3000`; F11; **không chiếu terminal** |
| Nghĩa | Cùng máy Trí hoặc máy riêng cũng chạy `npm run demo`; đã bấm thử "Gây lỗi" → panel "Cảnh báo sự cố" hiện → Xác nhận → Reset → Đóng |
| Khang | Terminal thứ hai sẵn lệnh `DATABASE_URL=postgresql://powerme:powerme@127.0.0.1:54330/powerme_test npm test -w @powerme/csms -- migration-0003` (31 test, ~6 s) |
| Sơn | Sẵn `npm test -w @powerme/csms -- charge-start-policy` (unit, không cần DB, 10 test) và file `apps/csms/test/wf01-driver-charging.integration.test.ts` mở ở test `DS01 full app service journey` |
| Ân | Design Brief PDF mở sẵn ở §3 và Phụ lục A; BM03; phiếu v1.3; Report 4 bản đã sửa (xem mục 5) |
| Tất cả | Điện thoại có ảnh dự phòng `docs/demo/` và link repo; biết số của mình trong A3 |

---

## 2. Kịch bản trình bày (18 phút)

| Phút | Ai | Nói gì (ý chính) | Chiếu gì |
|---|---|---|---|
| 0:00–1:30 | **Ân** | Đề tài một câu: nền tảng dùng chung cho nhà vận hành trụ độc lập, CSMS OCPP 1.6J tự xây, giá trị cốt lõi là **dữ liệu tính tiền vẫn đúng sau khi trụ mất mạng**. Phiếu v1.3: 4 thay đổi (BM03), không thêm FR, man-day +1,5 nằm trong buffer. Tag `review-2 = 1cead5d`, hội đồng xem code trên `main` | Design Brief §0–§1 |
| 1:30–3:00 | **Ân** | Phạm vi và giới hạn nói trước: **không có trụ thật** (GVHD xác nhận 27/10), toàn bộ trên simulator (SAP bên thứ ba + HMI tự viết); staging mới có cấu hình, chưa deploy; chỉ OCPP 1.6J | §1.2, R2 |
| 3:00–5:00 | **Trí** | Kiến trúc: một tiến trình NestJS, module theo nghiệp vụ, Postgres; vì sao không microservice (phiên + bút toán trong một transaction). 5 quyết định, mỗi người 20 giây nói quyết định của mình: D1 Trí, D2 Khang, D3 Nghĩa, D4 Sơn, D5 Ân | ARCH-1, §3 |
| 5:00–11:30 | **Trí** | **Demo WF-03** theo `docs/demo/KICH-BAN-TRINH-DIEN.md` (6 phút 30): 2 phiên → rớt mạng 60 s → ân hạn 20 s rồi `orphaned` → nối lại epoch 2, 8–9 bản ghi `replay` → dừng → `conflict`, phiên vào `review`. Câu chốt: "CSMS không tự quyết số điện khi hai nguồn mâu thuẫn; nó giữ bằng chứng và đưa người xem" | HMI + console |
| 11:30–13:30 | **Nghĩa** | **Demo WF-04** nối tiếp trên cùng console: HMI "Gây lỗi" súng B (GroundFailure) → panel cảnh báo đỏ → Xác nhận → Reset: hệ thống **từ chối 409 vì súng A còn phiên** → xác nhận lần hai (`force`) → trụ Reset → súng về Available → sự cố `resolved`. Câu chốt: "Reset là lệnh cho cả trụ, nên phải hỏi lại khi còn người đang sạc" | console panel WF-04 |
| 13:30–15:00 | **Sơn** | WF-01 chưa có app, chỉ có dịch vụ phía CSMS: start từ app bằng intent có idempotency key, RemoteStart, cắt khi credit chạm 10.000 (BR-P19), quyết toán một lần (UNIQUE `session_debit`), làm tròn một lần (BR-P45). Chạy `charge-start-policy` (10 test, 1 s) | terminal + test |
| 15:00–16:00 | **Khang** | Billing: migration 0003 khớp LERD-1 v0.4; 4 ràng buộc tiền: top-up hết hạn 15 phút, thanh toán muộn chỉ khi đã expired, `points_redeemed = 0 ⇔ discount = 0`, UNIQUE mã giao dịch VNPay. Chạy `migration-0003` (31 test, 6 s). Report 5: 559 test tự động, 113 test case cam kết | terminal + Report 5 |
| 16:00–18:00 | **Ân** | Known gaps (K1–K9) và cam kết Defense 1.1: 5 workflow, 10 kịch bản demo, 113 test case (≥ 57 tự động; hiện 559). Kết: "Em xin nhận câu hỏi" | Phụ lục A |

**Nguyên tắc chung khi nói:** số nào không chắc thì nói "em mở file ra xem", không đoán. Không nói "chạy được trên trụ Ruihua". Không nói "CSMS tính tiền" cho thẻ ví.

---

## 3. Bộ câu hỏi từ chính hồ sơ đã nộp (hội đồng đọc hồ sơ trước, dễ hỏi nhất)

| # | Câu hỏi | Ai trả lời | Ý trả lời |
|---|---|---|---|
| H1 | "Tag `review-2` ghi 1cead5d ngày 28/10, nhưng BM02 nói chạy trên tag — các em chạy self-review lúc nào, trên commit nào?" | Ân | Chạy hai lần: lần 2 ngày 26/10 trên 16c8d06 (34 finding), lần 3 ngày 28/10 trên 1cead5d sau khi đổi tag (40 finding, phiếu v1.3). Bản nộp là lần 3; cả hai nằm trong `docs/self-review/` |
| H2 | "BM02 có 11 finding High, tất cả Planned, 0 Fixed. Hai ngày các em không sửa được cái nào?" | Trí | Lần chạy 3 làm **sau** khi đã sửa theo lần 2 (16 Fixed, trong đó thẻ theo status #56, ân hạn 120 s #59, migration 0003 #60). 11 High còn lại là việc Iteration 2 có chủ và hạn trong K1–K9; cái gần nhất là công tắc tắt đối soát (14/11) |
| H3 | "Report 5 ghi Trí 52 test case, Design Brief ghi Trí 26. Số nào đúng?" | Khang + Ân | Đã thống nhất lấy bộ của Report 5 (từng ca có chủ): Trí 52 · Khang 17 · Nghĩa 17 · Sơn 16 · Ân 11 = 113. *(Chốt trước giờ review và sửa A3.)* |
| H4 | "559 test tự động nhưng cam kết chỉ 113 test case?" | Khang | 113 là **test case** theo công thức §9.3 (tính năng×3 + workflow + chuyển trạng thái + NFR); 559 là số `it` của Jest, nhiều `it` cùng phủ một test case, và nhiều `it` là ca kỹ thuật (migration, ràng buộc) không nằm trong 113 |
| H5 | "SRS BR-P02 nói đồng hồ CSMS là chuẩn, không bao giờ dùng đồng hồ trụ. Code tính giá theo đồng hồ trụ. Vì sao?" | Trí | Phiên sạc lúc trụ offline: `received_at` là giờ **nối lại**, không phải giờ điện chảy, nên tính theo giờ CSMS sẽ rơi sang khung giá khác. Với phiên live hai đồng hồ lệch < 5 s (ngưỡng replay), không khác gì. Đề xuất sửa BR-P02: giờ CSMS cho bản tin live, timestamp trụ cho bản tin phát lại, có kiểm bằng replay detection (K1, 07/11) |
| H6 | "Report 4 bản 25/10 ghi ADR-0016 'code change pending'. Đã làm chưa?" | Ân/Trí | Đã: PR #44 (26/10) thêm `OfflineGraceService`, #59 đặt mặc định 120 s. Report 4 bản 28/10 đã sửa dòng này *(Ân phải sửa thật, xem mục 5)* |
| H7 | "Class diagram WF-04 có `RemoteCommandService`, `OcppDispatchService`, `RealtimeGateway`. Chỉ cho tôi trong code." | Nghĩa | Nói thẳng: bản thiết kế ban đầu; code thật gọn hơn: `FaultService`, `FaultStateMachine`, `error-code-guide`, Reset gửi từ `console.commands.ts`. Realtime chưa có. Report 4 đã cập nhật *(Ân)* |
| H8 | "Report 4 nói staging 'Planned', repo có `deploy.sh`, `rollback.sh`. Đã deploy chưa? Rollback thế nào nếu đã áp migration 0003?" | Trí | Chưa deploy (chưa có VPS, đang xin Azure for Students). Cấu hình đã build ảnh thật trên CI. `rollback.sh` **từ chối** lùi ảnh nếu lần deploy đã áp migration; qua 0003 (NOT NULL, ALTER TYPE) chỉ khôi phục bằng `--restore-db` từ bản backup mà `deploy.sh` làm trước khi migrate |
| H9 | "Hướng dẫn nói demo chạy trên staging. Hôm nay chạy máy cá nhân?" | Ân | Yêu cầu staging là cho Defense 1.1 (§9.2); Review 2 chốt kịch bản. Dữ liệu demo nạp bằng script trong repo (`demo/seed.sql`), lặp lại được; hội đồng đổi được tham số (ân hạn, thời gian cắt, `STALE_METERSTOP`) |
| H10 | "Không có trụ thật thì kết quả nghiên cứu có giá trị gì?" | Trí | Hai client độc lập (SAP của bên thứ ba cấu hình theo manual D1; HMI tự viết); kịch bản ánh xạ sang ca kiểm thử **bắt buộc** của OCA cho Central System (TC_037_1, TC_037_3, TC_039); kết luận ghi rõ "đúng theo spec 1.6J và manual D1, chưa kiểm trên firmware Ruihua". Phần đóng góp là logic phía CSMS, chỉ phụ thuộc bản tin OCPP |
| H11 | "Phiếu v1.3 chuyển trạng thái/ETA từ WP4 sang WP2 mà không chuyển man-day. Trí gánh nổi không?" | Trí | Trạng thái connector đã có sẵn trong CSMS (`connector_status_events`), ETA là hàm trên dữ liệu phiên; phần WP2 làm là **API** (hợp đồng T77, 30/10). Thuật toán gợi ý và RQ2 vẫn ở WP4. Rủi ro ghi ở K4 |
| H12 | "Design Brief DS-05 cắt mạng 2 phút, ân hạn 120 s — sao biết nó orphaned?" | Trí | Ân hạn cấu hình được; demo đặt 20 s. Sẽ sửa DS-05 thành 3 phút để rõ |

---

## 4. Câu hỏi nghiệp vụ, nghiên cứu, kỹ thuật, scale

| # | Câu hỏi | Ai | Ý trả lời |
|---|---|---|---|
| N1 | "Khách hàng là ai, vì sao họ không dùng cloud của hãng?" | Ân | Nhà vận hành độc lập nhập trụ Ruihua; cloud hãng không có VNPay, hoá đơn VAT, biểu giá giờ Việt Nam; không muốn phụ thuộc hạ tầng Trung Quốc; mỗi operator chỉ thấy trụ của mình (BR-P11, P16) |
| N2 | "Tiền của tài xế nằm ở đâu, có phải ví điện tử không?" | Khang | Charging Credit trả trước là **số dư dịch vụ**, không rút/chuyển được (BR-P21), nên không cần giấy phép trung gian thanh toán (Nghị định 52/2024). Nạp qua VNPay, mỗi lần nạp một hoá đơn VAT |
| N3 | "Trụ mất mạng mà vẫn sạc, ai chịu tiền điện đó?" | Trí/Sơn | Phiên vẫn ghi nhận khi trụ phát lại; quyết toán một lần theo giờ trụ; nếu thiếu credit thì số dư âm và chặn phiên mới (BR-P20). Không bao giờ bỏ phiên đã diễn ra |
| N4 | "Hai nguồn số điện mâu thuẫn thì tin bên nào?" | Trí | Không tự chọn. `meterStop` thấp hơn chuỗi đo quá 1 Wh → `conflict`, phiên `review`, operator quyết. Chính sách cuối phải chốt với hãng (G14 trong Design Brief WP2) |
| N5 | "Câu hỏi nghiên cứu là gì, đo bằng gì?" | Trí | RQ1: đối soát có giảm sai số tính tiền sau mất mạng không. 3 kịch bản × 30 lần × 3 điều kiện (bật / tắt đối soát / SteVe), chỉ số: tỷ lệ phiên đúng số điện hoặc được đẩy lên review có bằng chứng (NFR-REC-01 ≥ 95 %). Thiếu hiện tại: công tắc tắt (K8), 4 key cấu hình SAP (G4) |
| N6 | "Vì sao so với SteVe mà không so với cloud hãng?" | Ân | Không có trụ thật thì không vào được cloud hãng. SteVe là CSMS mã nguồn mở phổ biến nhất, cùng OCPP 1.6J, dựng được bằng Docker. Ablation bật/tắt cô lập đúng một biến là engine đối soát |
| N7 | "OCPP 1.6 không có cờ phát lại, các em phát hiện bằng gì?" | Trí | Hai mốc giờ (trụ `cp_timestamp`, CSMS `received_at`) + **epoch** mỗi lần nối (lưu DB). Bản tin có giờ trụ sớm hơn lúc mở epoch quá 5 s → `before_epoch`; lệch giờ nhận quá 5 s → `skew`. OCA vá lỗ này ở 2.0.1 bằng `offline`/`seqNo` |
| N8 | "Đồng hồ trụ lệch thì sao?" | Trí | Lệch > 5 s gây cờ phát lại giả; Heartbeat trả `currentTime` để trụ chỉnh; ngưỡng là biến môi trường. Giới hạn, nói thẳng |
| K1 | "Scale: 1.000 trụ thì một tiến trình chịu nổi không?" | Trí | Mỗi trụ một WebSocket, 1 MeterValues/10 s → 100 msg/s, Postgres và Node dư sức. Khoá tuần tự **theo từng trụ** (`InboundSerializer`), hai trụ không chặn nhau. Chưa đo (K13 NFR-OCPP-01: 50 trụ, p95 ≤ 1 s). Scale ngang sau này: load balancer giữ kết nối dính, epoch nằm trong DB nên không phụ thuộc RAM |
| K2 | "Hai instance CSMS cùng chạy thì sao?" | Trí | Chưa hỗ trợ: hẹn giờ ân hạn trong RAM (G9), quét DB lúc khởi động chỉ đúng cho cùng một instance. Sẽ chuyển BullMQ khi có Redis |
| K3 | "Sao chọn NestJS/Node mà không Python/Java?" | Trí | Thư viện OCPP có schema validation tốt nhất là `ocpp-rpc` (26.355 lượt tải/tháng, MIT, đã đọc source); WebSocket là thế mạnh của Node; một ngôn ngữ cho CSMS + dashboard. Rủi ro R2: một maintainer, đã ghim bản |
| K4 | "Vì sao Postgres, không MongoDB/time-series?" | Trí/Khang | Tiền và phiên cần transaction + ràng buộc (24 CHECK, UNIQUE 5 cột, trigger chỉ-thêm). `meter_values` partition theo tháng (ADR-0007) là time-series đủ dùng |
| K5 | "Bảo mật trụ giả?" | Ân/Trí | Security Profile 2: Basic Auth mỗi trụ, mật khẩu scrypt, `timingSafeEqual`; sai 5 lần/60 s theo (serial, IP) khoá 15 phút, 20 lần theo IP; `OCPP_TRUST_PROXY` lấy IP thật sau Caddy. **Chưa có TLS** ngoài cấu hình staging |
| K6 | "Console vận hành ai cũng vào được?" | Trí | Chưa có xác thực; chỉ bind loopback, staging publish `127.0.0.1`, Caddy không proxy, vào bằng SSH tunnel. Users module + RolesGuard là K9 (21/11) |
| K7 | "Nếu Postgres chết giữa StartTransaction?" | Trí | Transaction rollback nên không có CALLRESULT; trụ gửi lại; khoá idempotency 5 cột trả đúng `transactionId` cũ, không tạo phiên thứ hai |
| K8 | "Migration viết SQL tay, sao không dùng ORM sinh?" | Trí | Partition, trigger, ALTER TYPE, backfill có điều kiện: ORM không sinh được. Mỗi file có khối kiểm dữ liệu trước (`RAISE` nếu vi phạm), test migration riêng, số chỉ dùng một lần (test #62) |

---

## 5. Câu hỏi code theo từng người và bài sửa tại chỗ

Lệnh chung: unit test `npm test -w @powerme/csms -- <tên>` (không cần DB); test tích hợp cần `npm run demo:db -w @powerme/csms` ở cửa sổ khác rồi `DATABASE_URL=postgresql://powerme:powerme@127.0.0.1:54330/powerme_test npm test -w @powerme/csms -- <tên>`.

### Trí (WP2)
| Câu | File | Ý trả lời |
|---|---|---|
| "Sao `before_epoch` kiểm trước `skew`?" | `reconciliation/replay-detector.ts:45` | Ca nào before_epoch cũng thoả skew; thứ tự chỉ để ghi lý do mạnh hơn (bản tin sinh ra trước khi kết nối tồn tại) |
| "`.then(() => undefined, () => undefined)` để làm gì?" | `ocpp-gateway/inbound-serializer.ts:18` | Tác vụ trước lỗi thì chuỗi không đứt; `delete` cuối dọn key khi hàng đợi rỗng |
| "Sao khoá trùng 5 cột mà không dùng transactionId?" | `sessions/sessions.service.ts:165` | Trụ chưa có transactionId lúc gửi Start; gặp trùng trả lại số cũ, không trả lỗi (nếu lỗi, trụ gửi lại mãi) |
| "Epoch lấy từ `max()` trong DB, sao không đếm RAM?" | `ocpp-gateway/connection-registry.ts:81` | Restart thì RAM về 0, luật before_epoch sai; UNIQUE (charge_point_id, epoch) chặn trùng |
| "`setTimeout` trong RAM, restart thì mất?" | `ocpp-gateway/offline-grace.service.ts:155` | `recoverAfterRestart` quét DB: quá hạn → orphan ngay, chưa → hẹn lại phần còn lại |
| "Thẻ bị khoá mà sao vẫn ghi phiên?" | `sessions/sessions.service.ts:691` | Authorize từ chối, nhưng StartTransaction tới nghĩa là điện đã giao (trụ cho sạc lúc offline); ghi `unattributed` + bản ghi `unknown_id_tag` cho operator |

**Sửa tại chỗ:** (a) đổi `REPLAY_SKEW_THRESHOLD_S` mặc định 5 → 10 ở `config.ts:103`, chạy `-- replay-detector` thấy đỏ, sửa test, xanh; (b) thêm chuyển `review --OPERATOR_RESOLVED--> reconciled` đã có; thử thêm `orphaned --HARD_CAP_EXCEEDED--> failed` vào `TRANSITIONS` (`session-state-machine.ts:73`) và test ở `session-state-machine.spec.ts`; (c) đổi `RECONCILE_GAP_FACTOR` 3 → 2 và chỉ ra test nào đổi kết quả (`-- reconciliation`).

### Sơn (WP3)
| Câu | File | Ý trả lời |
|---|---|---|
| "Quyết toán hai lần có xảy ra không?" | `sessions/charge-settlement.service.ts:155` | `FOR UPDATE` phiên, kiểm statement trước, UNIQUE `session_debit`, cả bút toán trong một transaction |
| "Làm tròn ở đâu, mấy lần?" | `:216` | Một lần trên tổng milli-VND, half-up (BR-P45); đoạn theo luỹ kế nên tổng đoạn = tổng phiên |
| "Vì sao phiên thẻ RFID không được tính tiền?" | `:170` (`origin='app_qr'`) | Quyết toán cần intent của app; phiên thẻ là K1 (14/11). Nói thẳng, đừng vòng |
| "RemoteStop timeout thì sao?" | `driver-charging.service.ts` | Hiện kẹt `stopping`, không gửi lại — gap đã ghi, sửa sau Review 2 |
| "Vì sao `onMeter` chỉ xét phiên có intent?" | `driver-charging.service.ts:914` | Sửa 28/10: phiên thẻ không có intent làm `stopCommand` ném `not_found` mỗi 10 s |

**Sửa tại chỗ:** đổi `CHARGE_MINIMUM_START_VND` 50.000 → 30.000 (`charge-policy.config.ts`), chạy `-- charge-start-policy` (unit); hoặc đổi dung sai làm tròn trong test "two 0.4 VND portions" rồi giải thích vì sao tổng vẫn 1 VND.

### Nghĩa (WP4)
| Câu | File | Ý trả lời |
|---|---|---|
| "Reset khi trụ còn phiên đang sạc thì sao?" | `console/console.commands.ts:136` | 409 `sessions_active` (tính cả pending/orphaned), cần `force=true` sau xác nhận lần hai, lưu `payload.force` |
| "Súng hết lỗi đi thẳng sang Preparing, không qua Available?" | `stations/faults/fault.service.ts:100` | `RECOVERED_STATUSES` gồm Available, Preparing, Charging, Suspended*, Finishing, Reserved; `Unavailable` vẫn chờ |
| "Bản tin Faulted phát lại từ 30 phút trước?" | `fault.service.ts:162` | Dùng giờ trụ cho bản phát lại, chặn giờ tương lai hoặc quá 30 ngày; giới hạn: trụ lệch giờ có thể làm sự cố kẹt — đã ghi §10 |
| "Hai operator Reset cùng lúc?" | `console.commands.ts` | 409 `reset_in_progress`; kiểm tra nằm ngoài transaction là giới hạn đã ghi |
| "Ghi `fault_events` lỗi thì sao?" | `ocpp-handlers.ts:63` | Chỉ log, chưa quét bù — việc sau Review 2 |

**Sửa tại chỗ:** thêm `Unavailable` vào `RECOVERED_STATUSES`, chạy `-- fault-state-machine` rồi `wf04-fault` (IT-4 đỏ, giải thích vì sao thiết kế để nó chờ); đổi `FAULT_RESET_TIMEOUT_S`.

### Khang (WP5)
| Câu | File | Ý trả lời |
|---|---|---|
| "VNPay gửi IPN hai lần thì cộng tiền hai lần không?" | `drizzle/0003_billing-wf02.sql` | UNIQUE `(top_up_id, transaction_type)` và UNIQUE `gateway_transaction_no`; test `migration-0003` ca `dup.constraint` |
| "Khách thanh toán sau khi top-up hết hạn 15 phút?" | `0003` cột `late_*` | `late_gateway_ref` UNIQUE, CHECK chỉ cho late khi `status = expired`; Admin hoàn qua UC-ADM-08 |
| "Điểm thưởng đổi mà discount = 0?" | `top_ups_points_check` | `(points_redeemed = 0) = (points_discount_vnd = 0)` |
| "Số dư tài khoản có thể sai so với sổ cái không?" | `credit_accounts.balance_vnd` | Số dư dẫn xuất từ SUM sổ cái; test "balance = ledger sum" (R3) |

**Sửa tại chỗ:** viết migration `0009_` thêm một CHECK (ví dụ `amount_vnd BETWEEN 50000 AND 2000000` cho `top_ups`, BR-P22) kèm khối kiểm dữ liệu trước; chạy `-- migration-0001` để thấy test "mỗi số migration chỉ dùng một lần" và thứ tự.

### Ân (WP1)
| Câu | File | Ý trả lời |
|---|---|---|
| "Kẻ xấu biết serial trụ, thử mật khẩu sai 5 lần — trụ thật có bị khoá không?" | `stations/pillar-login-limiter.ts:33` | Khoá theo (serial, IP) nên chỉ kẻ xấu bị khoá; trụ thật ở IP khác vẫn vào. Cần `OCPP_TRUST_PROXY=true` sau Caddy (#63) |
| "Trụ chưa onboard mà nối vào?" | `pillar-auth.service.ts` | Không có credential → 401 (trừ `ALLOW_LEGACY_NO_CREDENTIAL`, chỉ demo local); serial chưa đăng ký → 404 |
| "STM-3 có 6 chuyển, `disabled` ai đặt?" | `pillar-lifecycle-policy.ts:46` | Chưa có endpoint gọi DISABLE/ENABLE/DECOMMISSION (G11, 14/11) |

**Sửa tại chỗ:** đổi `perSerial.maxFailures` 5 → 3, chạy `-- pillar-login-limiter`; thêm chuyển `in_service --DECOMMISSION--> decommissioned` và test `-- pillar-lifecycle-policy`.

---

## 6. Câu "bẫy" và cách trả lời

| Câu | Trả lời |
|---|---|
| "AI viết bao nhiêu phần trăm?" | Có dùng AI, khai ở `docs/BANG-KHAI-BAO-CONG-NGHE.md`. Quyết định nằm trong 16 ADR, test do người duyệt, và mỗi người giải thích được code của mình (mục 5). Mời hội đồng chỉ bất kỳ dòng nào |
| "Vì sao đổi tag hai ngày trước review?" | Để hội đồng xem đúng code có #56–#64; self-review chạy lại trên tag mới (run 3). Cả hai bản trong repo |
| "Test chập chờn?" | Có: 2–3 test WF-01 chờ cố định bằng `setTimeout`, đỏ ~1/3 lần chạy cả bộ, xanh khi chạy riêng; một test T61 cùng lỗi đã sửa (#65). Đã báo Sơn, sửa sau Review 2 |
| "Demo có dàn dựng không?" | Có một công tắc: `STALE_METERSTOP` làm HMI phát lại `meterStop` cũ, mô phỏng điều quan sát được trên SAP (EXP-01). Nói trước, không giấu; tắt đi thì phiên tự `reconciled` |
| "Nếu Ruihua không trả lời câu hỏi về thẻ ví thì sao?" | Thiết kế không phụ thuộc: phân loại thẻ bằng sổ đăng ký của operator, phiên thẻ ví chỉ ghi nhận, không thu tiền (ADR-0012) |
| "Cái gì sẽ KHÔNG kịp Defense 1.1?" | Nói thẳng theo K1–K9: realtime, app Flutter đầy đủ, hoá đơn VAT thật (sandbox), TLS trên VPS. Cam kết là 5 workflow, 10 kịch bản, 113 test case |

---

## 7. Việc còn lại trước 29/10 (từ kiểm hồ sơ 28/10)

- [ ] Ân: commit BM02 run 3 (1cead5d) vào `docs/self-review/`; Report 4 sửa ADR-0016, WF-04 class, ARCH-2/staging, "32 bảng"; D5 bỏ ADR-0016; DS-05 "3 phút"; BR-P02 thêm vế bản tin phát lại.
- [ ] Khang + Ân: chốt một bộ số theo người (đề xuất của Report 5), sửa A3 hoặc Report 5; 7 ca STM-1 trỏ đúng tên test; Round 2/3 để trống.
- [ ] Trí: diễn tập lần hai theo mục 2; tập mục 5 (a)(b)(c) một lượt.
- [ ] Nghĩa: thử "Gây lỗi" → Reset 409 → force trên `main` một lần.
- [ ] Sơn: mở sẵn test, chạy thử `charge-start-policy`.
