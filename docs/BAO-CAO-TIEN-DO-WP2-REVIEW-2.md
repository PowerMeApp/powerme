# Báo cáo tiến độ WP2 — trước Review 2

**Kỳ báo cáo:** 16/09 → 23/10/2026 (Tuần 2 → Tuần 7 lộ trình SWP490) · **Người lập:** Ngô Văn Minh Trí (WP2, Team Leader) · **Ngày:** 23/10/2026
**Dùng cho:** hồ sơ Review 2 (26/10–08/11), Report 4, T50/T55 trên board.
**Quy ước trạng thái:** *PR mở* = đã làm, chờ review · *merged* = xong theo Definition of Done · chưa có PR = chưa làm.

---

## 1. Tóm tắt điều hành

1. WP2 có **13 PR mở** với CI xanh (trừ #9 đỏ vì định dạng, đã sửa trong #11): bàn thí nghiệm OCPP, lớp điều khiển tương tác, hai thí nghiệm có log thật, tài liệu kiến trúc với 12 ADR tách file, thiết kế CSDL vật lý 32 bảng có migration, state machine đã xác nhận, package diagram, WF-03 nháp, bảng công nghệ, báo cáo hiện trạng repo.
2. **Chưa PR nào được merge.** Nguyên nhân gốc phát hiện ngày 23/10: bốn thành viên còn lại chỉ có quyền *đọc* repo, team CODEOWNERS không có ai ngoài Trí — **đã sửa cùng ngày**, cả nhóm giờ có quyền write.
3. **Kết quả nghiên cứu sơ bộ đã có bằng chứng thật** (EXP-01): sau 81 s mất kết nối, trụ phát lại 6/8 mẫu *sau* lệnh dừng, `meterStop` báo 242 Wh trong khi chuỗi đo live đã 1042 Wh; tín hiệu phân biệt duy nhất là chênh lệch hai đồng hồ. Đúng khoảng trống của OCPP 1.6 mà đề tài nhắm tới.
4. **Iteration 1 đã có code sản phẩm đầu tiên** (#19, CI xanh): gateway OCPP trên NestJS, state machine phiên 22 chuyển, engine đối soát, 96 unit test + 19 test tích hợp phát lại trace thật EXP-01. Nhưng **chưa nằm trên `main`** — phải merge chuỗi #18 → #19 trước; chưa có API, realtime, billing.
5. Trước Review 2 cần: merge chuỗi PR theo thứ tự ở mục 3, chốt 6 quyết định ở mục 8.

---

## 2. Dòng thời gian

| Ngày | Việc | Bằng chứng |
|---|---|---|
| 12/09 | Chốt backend Node + `ocpp-rpc` (số liệu npm/GitHub thật: 26.355 DL/tháng, thư viện Node OCPP được tải nhiều nhất); app Flutter | Tài liệu kiến trúc, #7 |
| 16/09 | Dựng bàn thí nghiệm không cần Docker: SAP simulator v4.12.0 (DC 120 kW, 2 súng) + mini-CSMS 80 dòng trên `ocpp-rpc@2.2.1` ghi mọi frame thô. **EXP-01**: ngắt 81 s giữa phiên | #9, `lab/EXP-01-ngat-ket-noi-81s.md`, trace 150 frame |
| 16/09 | Tài liệu kiến trúc WP2 (11 ADR đề xuất), phân tích tài liệu WP1, tổng quan dự án cho người mới (PDF 16 trang) | #8 |
| 17/09 | Gặp GVHD lần đầu — thầy định hướng: trụ giả lập tương tác được, demo nói lên chất lượng, hoàn thiện docs trước | — |
| 08/10 | Lớp điều khiển `csms-ctl`: 12 lệnh chiều xuống qua HTTP, cắt kết nối theo lệnh, `epoch` trong trace, đóng socket cũ khi trụ nối lại. **EXP-02** đặt chỗ: 9/9 hành vi đạt, phát hiện tính duy nhất đang nhờ thư viện chứ không nhờ CSMS | #11, `lab/EXP-02-dat-cho.md` |
| 23/10 | Báo cáo hiện trạng repo (T63), phát hiện và sửa sự cố quyền truy cập, bảng công nghệ (T18), package diagram (T19), xác nhận state machine (T13), tách 12 ADR, thiết kế CSDL vật lý + migration (T11), WF-03 class + sequence (T24) | #12–#18 |
| 23/10 | **Iteration 1 có code**: gateway + state machine + đối soát; test tích hợp phát lại trace thật EXP-01 qua đúng đường xử lý của gateway, chạy trên Postgres của CI | #19, CI xanh |

---

## 3. Sản phẩm — danh sách PR và thứ tự merge

| Thứ tự | PR | Nội dung | Dòng | CI |
|---|---|---|---|---|
| 1 | #7 | Nhãn Flutter, mô tả BE-02/BE-08 theo ADR, ignore `HANDOFF.md` | 9 | ✅ |
| 2 | #8 | Tài liệu kiến trúc WP2, phân tích WP1, tổng quan dự án (HTML + PDF) | 1.242 | ✅ |
| 3 | #12 → #8 | 12 ADR tách file trong `docs/adr/`: 0001–0004, 0008 *Chấp nhận*; 0005–0007, 0009–0012 *Đề xuất* | 576 | ✅ |
| 4 | #9 | Mini-CSMS, EXP-01, cấu hình SAP simulator, `ocpp-rpc@2.2.1` | 800 | ❌ format → sửa ở #11 |
| 5 | #11 → #9 | Lớp điều khiển, trụ giả để test, `trace.mjs` với epoch, EXP-02, CI cho PR xếp tầng | 994 | ✅ |
| 6 | #13 | Báo cáo hiện trạng repo T63 + 14 mâu thuẫn trong repo (danh sách thiếu sót cho T55) | ~190 | ✅ |
| 7 | #15 | Bảng khai báo công nghệ T18 — mọi dòng có nguồn trong repo, 26 mục chưa ghim | 151 | ✅ |
| 8 | #14 | Package diagram CSMS T19 — 17 node, 8 module, 10 luật phụ thuộc | ~200 | ✅ |
| 9 | #16 | Xác nhận state machine T13 — STM-1 9 trạng thái / 22 chuyển, STM-2 phản chiếu OCPP, STM-3 sửa theo EXP-01 | ~180 | ✅ |
| 10 | #18 | Thiết kế CSDL vật lý T11 — 32 bảng, 28 enum, 94 index, 24 CHECK (đếm trên văn bản migration; con số 36 trước đây không tái hiện được), migration SQL 774 dòng, mô tả bảng | 2.661 | ✅ |
| 11 | #17 | WF-03 class + sequence diagram T24 (nháp, chờ T62) | 460 | ✅ |
| 12 | #19 → #18 | **Iteration 1** — gateway OCPP (`ocpp-rpc`, tuần tự hoá theo trụ, epoch từ DB), state machine phiên 22 chuyển, đối soát, **96 unit test + 19 test tích hợp phát lại 75 frame EXP-01** (T33) | ~9.800 | ✅ |

Độc lập với nhau: #13, #14, #15, #16, #17 (đều từ `main`). Xếp tầng: #8 → #12; #9 → #11; #18 → #19.

---

## 4. Kết quả nghiên cứu sơ bộ

### EXP-01 — ngắt kết nối 81 s giữa phiên (16/09, một lần chạy)

| Quan sát | Số liệu | Ý nghĩa |
|---|---|---|
| Trụ buffer rồi phát lại | 8 mẫu vào buffer, **6 phát lại, 2 mất** không có log | Mất mẫu một phần, im lặng |
| Phát lại đến **sau** StopTransaction, rải 55 s lẫn dữ liệu live | 6 mẫu, skew 104–127 s | Sai thứ tự |
| `meterStop` mâu thuẫn chuỗi đo | 242 Wh vs 1042 Wh — **chênh 4,3×** | Tính tiền theo số nào? |
| Tín hiệu phân biệt duy nhất | `received_at − cp_timestamp`: 0,0 s (live) vs > 100 s (phát lại) | Không có cờ ở tầng giao thức — đúng khoảng trống 1.6 (2.0.1 vá bằng `offline` + `seqNo`) |
| Trụ nối lại **không gửi BootNotification** | 14:20:22 nối lại → gửi thẳng MeterValues | CSMS phải bắt sự kiện mở socket, không trông vào Boot |
| Thử lại kết nối | 30 s cố định | Khớp backoff tuyến tính của spec |

**Giới hạn ghi rõ:** một lần chạy, simulator SAP (không phải firmware Ruihua), ngắt bằng cách tắt server (socket đóng sạch, chưa phải half-open 4G). Là *minh hoạ hiện tượng*, chưa phải *đo lường*.

### EXP-02 — đặt chỗ connector (08/10)

9/9 hành vi đạt. **Phát hiện:** "hai đặt chỗ đồng thời → đúng một thành công" đạt nhờ `callConcurrency = 1` của `ocpp-rpc` xếp hàng CALL, không nhờ logic CSMS — không đứng được khi nhiều instance hoặc `platform hold` không có trụ để xếp hàng. Tính duy nhất phải ở `UNIQUE` trong DB → đã đưa vào thiết kế CSDL (#18: partial unique index một reservation active mỗi connector/driver). Ước lượng FR-20 đề nghị từ 1 lên 4–5 ngày công.

### Hệ quả thiết kế rút ra từ thí nghiệm

| Phát hiện | Quyết định |
|---|---|
| Phiên closed nhưng đối soát conflict không có chỗ đứng | STM-1 thêm trạng thái `review` (T13) |
| Phiên orphaned mà trụ nối lại vẫn đang sạc | STM-1 thêm `orphaned → active` (T24 phát hiện, T13 cập nhật) |
| CSMS chết thì registry trong RAM mất sạch | Epoch khởi tạo từ DB (`charge_point_connections`) |
| Trụ không gửi lại StatusNotification khi nối lại | CSMS gửi `TriggerMessage` cho c0/c1/c2 ở epoch mới |
| Simulator gửi Wh **thập phân** (`48.46`) | ADR-0009 lưu integer → cần chính sách làm tròn; câu hỏi thứ 5 cho Ruihua |
| SAP thiếu 4 config key retry/offline | Phải patch trước thí nghiệm chính thức (WP5) |

---

## 5. Thiết kế đã chốt

- **12 ADR** (#12): modular monolith · Node 24 + TS strict · `ocpp-rpc@2.2.1` ghim cứng, vendor dự phòng (1 maintainer) · log frame trước khi xử lý · không Redis pub/sub trên đường giao dịch · Postgres 16.4 partition tháng · Drizzle + migration viết tay · hai mốc thời gian, integer Wh/VND · UNIQUE chống trùng StartTransaction · Security Profile 2 · thẻ ví tách `origin` / `payment_mode`. Phụ lục ADR-0001: Flutter ngoài npm workspaces, hợp đồng qua `openapi.json`.
- **State machine** (#16): STM-1 phiên 9 trạng thái / 22 chuyển, timeout: start 120 s, hard cap 24 h, skew 5 s; STM-2 connector giữ đủ 9 giá trị OCPP nguyên văn, CSMS *phản chiếu* không từ chối, chuyển bất thường gắn cờ; STM-3 trụ `offline` khi socket đóng hoặc 900 s, nối lại = epoch mới.
- **CSDL vật lý** (#18): 32 bảng, 28 enum, enum = giá trị STM; `meter_values` và `ocpp_message_log` partition tháng; trigger append-only cho log; khoá tự nhiên ADR-0010; FK tổng hợp tới `connectors(id, charge_point_id, connector_no)`. Đối chiếu SQL ↔ schema bằng PGlite: 270 cột / 138 ràng buộc / 94 index / 28 enum khớp 100%; 11 ca vi phạm bị từ chối đúng.
- **Package diagram** (#14): một tiến trình NestJS, 8 module theo nghiệp vụ (`ocpp-gateway`, `stations`, `sessions`, `reconciliation`, `billing`, `tariffs`, `users`, `realtime`), admin API nằm trong module với RolesGuard, mỗi bảng một module chủ.
- **WF-03** (#17): 2 sequence + 1 class diagram, số liệu thật EXP-01, nháp chờ T62.

---

## 6. Quy trình và hạ tầng

- CI 3 workflow (lint/typecheck/test/build với Postgres + Redis service; gitleaks toàn lịch sử; kiểm tiêu đề PR) + cảnh gác `main`. Xanh trên 11/12 PR.
- Sự cố quyền truy cập: phát hiện 23/10, 4/5 thành viên chỉ đọc, 5 team CODEOWNERS chỉ có Trí → đã thêm cả bốn vào team đúng WP cùng ngày. Hệ quả cho Report: "review trong 24 giờ" của CONTRIBUTING chưa bao giờ khả thi trước 23/10 — ghi đúng như vậy.
- 14 mâu thuẫn nội bộ repo (Node 22/24, Postgres 16.4/16, React Native còn sót, SteVe chưa có Dockerfile, CI chưa chạy PR xếp tầng trên `main`…) liệt kê ở #13 mục 10, chưa sửa.

---

## 7. Chưa làm — nói thẳng

| Thiếu | Hệ quả | Kế hoạch |
|---|---|---|
| **Backend NestJS trên `main`** | Code đã có ở #19 nhưng `main` vẫn trống | Merge #8 → #12 → #18 → #19 |
| Job nền (hard cap 24 h, start timeout, 900 s im lặng), RemoteStart/Stop kích hoạt thật, operator giải quyết `review` | 5/22 chuyển STM-1 chưa có đường kích hoạt (xem `ITERATION-1-WF03.md` §4) | Iteration 2 |
| **0 PR merged, 0 review** | T50 "tài liệu đã có trong repo" chưa đúng | Quyền đã sửa; Ân → #7/#8, Khang → #9/#11 |
| API tìm trạm cho WP3 | Sơn bị chặn từ 16/09 | Sau T33, 2 ngày |
| TLS/Caddy, Security Profile 2 | Chưa có | BE-01 còn lại |
| Thí nghiệm có kiểm soát (3 kịch bản × N lần, SteVe đối chứng) | EXP-01 mới là một lần chạy | Cần Docker (SteVe) + patch SAP (WP5) |
| 5 câu hỏi cho Ruihua | Thẻ ví, free vend, config key, measurand, Wh nguyên/thập phân — chưa gửi | Qua thầy, tuần này |
| Spec WF-03 chính thức (T62) | T24, T33 đang làm theo EXP-01 + STM-1 | WP1 |

---

## 8. Quyết định đang chờ Trí / nhóm

| # | Quyết định | Ảnh hưởng |
|---|---|---|
| 1 | Thêm `unattributed` vào `payment_mode` (phiên mở bằng thẻ lạ) | #18, T13, ADR-0012 |
| 2 | Duyệt 11 enum tự đặt giá trị trong #18 (`staff_role`, `tariff_band`, `credit_transaction_type`…) | Trí + Khang + Nghĩa |
| 3 | Tên cột đồng hồ trụ: `cp_timestamp` thống nhất (thay `pillar_timestamp`) | #18 |
| 4 | Cập nhật ADR-0009/0012 theo enum T12/T13 và tên `rfid_cards` | #12 |
| 5 | Bốn điểm T19: tên module gộp · gateway dùng `DiscoveryService` · `billing` nhận qua BullMQ job · hai đường VNPay return/IPN | #14, WP5 |
| 6 | Luật tạm tới Hội đồng: PR tài liệu/lab không review sau 48 h → tác giả tự merge, ghi biên bản | Cả nhóm |

---

## 9. Kế hoạch 48 giờ tới (→ 25/10)

1. Review và merge theo thứ tự mục 3 — mục tiêu `main` có tài liệu, ADR, lab, schema trước thứ Hai.
2. T33 đã lên PR (#19) với CI xanh; sau khi #18 merge, đổi base của #19 sang `main`.
3. Chốt 6 quyết định mục 8 trong họp nhóm.
4. Gửi 5 câu Ruihua qua thầy.
5. Xuất PDF các tài liệu cho T55 theo tên quy định.
