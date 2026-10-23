# Xác nhận state machine — T13 (trả lời T12 v0.2 của WP1)

**Ngày:** 23/10/2026 · **Người xác nhận:** Ngô Văn Minh Trí (WP2) · **Phạm vi:** STM-1 ChargingSession, STM-2 Connector, STM-3 ChargingPillar, STM-8 RfidCard, và 5 câu hỏi Ân gửi Trí.
**Nguyên tắc dùng để xác nhận:** giá trị trạng thái trong DB = giá trị trong STM = (với Connector) giá trị trên dây OCPP, **không có tầng ánh xạ**. Mọi chỗ sửa đều có bằng chứng từ EXP-01 (`apps/csms/lab/EXP-01-ngat-ket-noi-81s.md`, nhánh #9) hoặc từ spec OCPP 1.6.

---

## 0. Tóm tắt cho Ân (dán lên board)

| STM | Kết luận | Thay đổi so với v0.2 |
|---|---|---|
| STM-1 Session | **Xác nhận, có bổ sung** | +1 trạng thái `review`; +5 chuyển (`stopping → active` khi RemoteStop bị Rejected; `closed → review`; `review → reconciled`; **`orphaned → active`** khi bản tin live tới sau nối lại; `reconciled → review` khi mẫu muộn đổi kết luận và chưa trừ tiền); `orphaned → reconciled` tách thành [nhất quán] / `orphaned → review` [conflict]. Tổng 9 trạng thái, 22 chuyển |
| STM-2 Connector | **Xác nhận, sửa cách diễn đạt trigger** | Giữ đủ **9** giá trị OCPP trong enum DB (thêm `Reserved`) — CSMS *phản chiếu* StatusNotification, không bao giờ từ chối. Sửa #1, #2; thêm `Unavailable → Available` qua ChangeAvailability |
| STM-3 Pillar | **Xác nhận giá trị, sửa 2 trigger** | #5 `offline → in_service` kích hoạt bởi **socket nối lại (epoch mới)**, không phải BootNotification — EXP-01 chứng minh trụ nối lại không gửi Boot. #4 `offline` khi **socket đóng HOẶC 900 s im lặng**, không chỉ 900 s |
| STM-8 RfidCard | **Xác nhận** | Must: Operator/Admin gắn thẻ cho driver; driver tự gắn = Should. Bổ sung ghi chú về `card_kind` ↔ `payment_mode` |
| Mục tiêu test | **Đồng ý 5 thực thể chính** (STM-1, 2, 3, 4, 6) | STM-1 test ở mức lớp state machine + integration trên **trace thật EXP-01** làm fixture; STM-2 test qua simulator |

---

## 1. STM-1 ChargingSession — `sessions.status`

### 1.1 Trạng thái

`pending, active, paused, stopping, closed, review, reconciled, orphaned, failed` — **9**, thêm `review`.

**Vì sao cần `review`:** bản v0.2 chỉ cho operator can thiệp khi phiên `orphaned`. Nhưng EXP-01 tạo ra đúng ca ngược lại: phiên **đã closed bình thường** bằng StopTransaction phát lại (`meterStop = 242 Wh`), trong khi chuỗi MeterValues live đã lên 1042 Wh. Đối soát phát hiện *conflict* — phiên không orphaned, nhưng không thể `reconciled` vì không biết tính tiền theo số nào. Không có `review` thì ca này không có chỗ đứng. `review` là trạng thái "chờ operator quyết" (UC-OPS-05), dùng chung cho cả hai đường.

### 1.2 Bảng chuyển đã sửa (thay cho §2 STM-1 của v0.2)

| # | Từ → Đến | Trigger [guard] / effect | Trace | Ghi chú |
|---|---|---|---|---|
| 1 | ● → pending | RemoteStart Accepted [connector rảnh, credit ≥ start minimum] | UC-CHG-02, BR-P18 | `Accepted` chỉ là trụ nhận lệnh, chưa phải phiên bắt đầu |
| 2 | ● → active | StartTransaction tới mà không có pending khớp [tag đã phân loại] / stamp origin, payment_mode | UC-INT-02, AD-6 | RFID, HMI, free vend |
| 3 | pending → active | StartTransaction tới [cùng connector, cùng idTag] / mở phiên, bắt đầu tính giá | UC-CHG-02 | Khác idTag → coi là #2, pending tự hết hạn qua #4 |
| 4 | pending → failed | start timeout [không có StartTransaction] / báo driver, không thu tiền | AD-1 E2 | Giá trị: mục 1.3 |
| 5 | active → paused | StatusNotification SuspendedEV / SuspendedEVSE / ghi pause_cause | UC-CHG-04 | |
| 6 | paused → active | StatusNotification Charging | UC-CHG-04 | |
| 7 | active → stopping | điều kiện dừng [hạn mức, credit tới ngưỡng, driver bấm Stop] / gửi RemoteStop | UC-CHG-03, BR-P19 | |
| 8 | paused → stopping | driver bấm Stop / gửi RemoteStop | UC-CHG-03 | |
| **9a** | **stopping → active** | **RemoteStopTransaction trả `Rejected`** / báo driver | **OCPP 1.6 §6.44** | **Mới.** Spec cho phép trụ từ chối; không có chuyển này thì phiên kẹt ở stopping |
| 9 | stopping → closed | StopTransaction tới | UC-CHG-03 | |
| 10 | active → closed | StopTransaction tới [đầy pin hoặc dừng tại trụ] | AD-1 A1 | |
| 11 | paused → closed | StopTransaction tới | AD-1 | |
| 12 | closed → reconciled | đối soát xong [cross-check **nhất quán**] / tính giá theo band, trừ credit, cộng điểm, gửi statement | UC-PAY-02, UC-INT-03 | |
| **12a** | **closed → review** | **đối soát phát hiện conflict** [meterStop ≠ chuỗi MeterValues, hoặc lỗ hổng chuỗi không giải thích được] / tạo ReconciliationRecord `conflict`, đưa vào danh sách review | **UC-OPS-05, EXP-01** | **Mới** |
| 13–15 | active / paused / stopping → orphaned | trụ chuyển `offline` (STM-3) khi chưa có StopTransaction | UC-INT-03, AD-2 E4 | Không phải timer riêng — là hệ quả của STM-3 #4 |
| 16 | orphaned → reconciled | trụ nối lại, StopTransaction phát lại tới, đối soát **nhất quán** | UC-INT-03 | |
| **16a** | **orphaned → review** | trụ nối lại, StopTransaction phát lại tới, đối soát **conflict**; hoặc không có StopTransaction sau hard cap | UC-INT-03, UC-OPS-05 | **Mới** — thay cho #17 cũ |
| **17** | **review → reconciled** | operator giải quyết [chọn số Wh cuối, ghi lý do] / record decision | UC-OPS-05 | Sửa: từ `review`, không từ `orphaned` |
| **18** | **orphaned → active** | bản tin **live** (epoch mới, không phải phát lại) của chính phiên đó tới — MeterValues hoặc StatusNotification Charging | **EXP-01 giai đoạn D** | **Mới (T24 phát hiện).** Trụ nối lại lúc 14:20:22 và gửi MeterValues live cho tx 3 suốt 36 s trước khi StopTransaction phát lại tới. Không có chuyển này, phiên đang sạc thật bị ghi là orphaned |
| **19** | **reconciled → review** | mẫu phát lại đến muộn làm đổi kết luận đối soát [**chưa có** CreditTransaction trừ tiền] | EXP-01 giai đoạn F | **Mới.** Đã trừ tiền rồi thì **không** đổi trạng thái — chỉ ghi ReconciliationRecord `late_sample` và báo operator; sửa tiền đi đường compensation (AC-B06) |

**Tổng: 22 chuyển.** Trạng thái cuối: `failed`, `reconciled` (reconciled có thể quay lại `review` theo #19 khi chưa trừ tiền).

### 1.3 Giá trị timeout (câu hỏi của Ân)

| Timeout | Giá trị đề xuất | Lý do | Cấu hình |
|---|---|---|---|
| Start timeout (#4) | **120 s** | OCPP key `ConnectionTimeOut` của trụ là thời gian chờ cắm súng sau khi xác thực; giá trị hay gặp 60–120 s. CSMS chờ = giá trị đó + biên 30 s. Đọc `ConnectionTimeOut` thật bằng GetConfiguration khi boot và tính động nếu có | `SESSION_START_TIMEOUT_S` |
| Orphaned (#13–15) | **không có timer riêng** — theo `offline` của STM-3 (socket đóng hoặc 900 s) | Một nguồn sự thật cho "trụ mất", tránh hai timer lệch nhau | kế thừa STM-3 |
| Hard cap (#16a) | **24 h** kể từ `started_at` mà không có StopTransaction | Phiên DC thực tế < 2 h; 24 h là trần an toàn để orphaned không treo vô hạn | `SESSION_HARD_CAP_H` |
| Ngưỡng skew phát lại | **5 s** | EXP-01: live 0,0 s · phát lại 104–127 s · nhiễu mạng bình thường < 1 s. 5 s cách xa cả hai | `REPLAY_SKEW_THRESHOLD_S` |

Tất cả là biến cấu hình, không hard-code; ghi vào `infra/.env.example`.

---

## 2. STM-2 Connector — `connectors.status`

### 2.1 Nguyên tắc quan trọng nhất

**CSMS phản chiếu `StatusNotification`, không quyết định trạng thái connector.** Trụ là nguồn sự thật vật lý. Nếu trụ báo một chuyển "không hợp lệ" theo bảng, CSMS **vẫn ghi** giá trị mới và **gắn cờ** `unexpected_transition` trong `connector_status_events` — không từ chối. Từ chối nghĩa là DB nói một đằng, súng sạc một nẻo.

Hệ quả cho mục tiêu test (Design Brief A3 "một test cho chuyển không hợp lệ bị từ chối"): với Connector, test đó phải là **"chuyển bất thường được ghi nhận và gắn cờ"**, không phải "bị từ chối". Đề nghị Ân ghi ngoại lệ này vào Report 4.

### 2.2 Enum

Giữ **đủ 9 giá trị OCPP 1.6, đúng chữ hoa/thường trên dây**: `Available, Preparing, Charging, SuspendedEVSE, SuspendedEV, Finishing, Reserved, Unavailable, Faulted`. Thêm `Reserved` dù Reservation là Should — nếu trụ (hoặc simulator) báo `Reserved` mà enum không có, insert thất bại và mất bản tin. Giá trị DB = giá trị dây → không có tầng map, không có bug map.

Trạng thái khởi tạo trong DB: `Unavailable` cho tới `StatusNotification` đầu tiên.

### 2.3 Sửa bảng chuyển

| # | Bản v0.2 | Sửa | Lý do |
|---|---|---|---|
| 1 | Unavailable → Available: *BootNotification accepted* | …: **StatusNotification(Available) đầu tiên sau boot** | BootNotification không mang trạng thái connector; trụ gửi StatusNotification riêng ngay sau (EXP-01: Boot lúc 14:13:19.895, hai StatusNotification lúc .910 và .914) |
| 2 | Available → Unavailable: *Reset or reboot command* | …: **ChangeAvailability(Inoperative), hoặc trụ reboot** | Reset là lệnh; trạng thái đổi khi trụ báo lại. ChangeAvailability mới là lệnh đổi Unavailable có chủ đích |
| **2a** | — | **Unavailable → Available: ChangeAvailability(Operative)** | Thiếu chiều ngược; UC-OPS-02 cần |
| 14 | Operational → Faulted | Giữ; thêm **Faulted → Unavailable** cũng hợp lệ | Trụ sau lỗi có thể về Unavailable rồi mới Available |

Mọi trigger khác giữ nguyên nhưng hiểu là "trụ gửi StatusNotification với status X vì lý do Y".

### 2.4 Phát hiện từ EXP-01 ảnh hưởng STM-2

Khi trụ **nối lại sau mất mạng, nó không gửi lại StatusNotification** cho các connector (chỉ gửi tiếp MeterValues đang chạy). CSMS không biết súng nào đang ở trạng thái gì trong suốt thời gian mất mạng. **Thiết kế:** khi mở epoch mới, CSMS gửi `TriggerMessage(StatusNotification)` cho connector 0, 1, 2 để đồng bộ. Ghi vào WF-03 (T24).

### 2.5 Trả lời "STM-2 matches the code enum?"

Lab chưa có enum (mini-CSMS chỉ ghi log). Enum sẽ được định nghĩa **lần đầu** trong T11 (`pgEnum` Drizzle) với đúng 9 giá trị ở mục 2.2 — tức là code sẽ khớp STM theo xây dựng, không phải theo đối chiếu.

---

## 3. STM-3 ChargingPillar — `charge_points.lifecycle`

### 3.1 Giá trị

`registered, awaiting_connection, in_service, offline, disabled, decommissioned` — **xác nhận**. `offline` là trạng thái dẫn xuất nhưng lưu được: dashboard cần đọc nhanh, và nó chuyển bằng sự kiện rõ ràng (mục 3.2).

### 3.2 Hai chuyển phải sửa

| # | Bản v0.2 | Sửa | Bằng chứng |
|---|---|---|---|
| 4 | in_service → offline: *no message for 900 s* | **…: socket WebSocket đóng, HOẶC 900 s không bản tin** / raise offline alert | Socket đóng là sự kiện quan sát được ngay (EXP-01: CSMS thấy `close`, trụ thấy `ECONNREFUSED`). 900 s chỉ cần cho ca *half-open* (rớt 4G không có close frame); với `WebSocketPingInterval = 30 s` thực tế phát hiện ≤ ~60 s. 900 s là trần, không phải nhịp thường |
| 5 | offline → in_service: *BootNotification accepted* | **…: socket mở lại thành công (epoch + 1)** / mở epoch mới, gửi TriggerMessage(StatusNotification) c0/c1/c2, đóng alert | **EXP-01:** trụ nối lại lúc 14:20:22 và gửi thẳng MeterValues — **không có BootNotification**. Nếu chờ Boot, trụ ở `offline` vĩnh viễn trong khi đang sạc |

BootNotification vẫn là trigger của #3 (`awaiting_connection → in_service`, lần đầu, [credential hợp lệ]). Boot tới khi đang `in_service` (trụ reboot) → giữ `in_service`, đọc lại capabilities.

### 3.3 `disabled` / `decommissioned` có trong Must không? (hỏi Nghĩa, Trí)

Phía WP2, chi phí nhỏ: `disabled` = gửi `ChangeAvailability(connectorId 0, Inoperative)` + ẩn khỏi tìm kiếm — một lệnh đã có trong lớp điều khiển (#11). `decommissioned` = soft delete, không có lệnh OCPP. **Đề xuất:** `disabled` theo UC-OPS-02 nếu UC đó Must; `decommissioned` để Should. Nghĩa quyết theo phiếu v1.2.

### 3.4 Cột đi kèm (T11)

`last_message_at` (cập nhật mỗi frame vào), `current_epoch`, bảng `charge_point_connections` (epoch, opened_at, closed_at, close_reason) — nền của phát hiện phát lại.

---

## 4. STM-8 RfidCard — `rfid_cards.status`

`unlinked, active, blocked` — **xác nhận**.

**Ai gắn thẻ (câu hỏi của Ân):** Must — **Operator/Admin** gắn thẻ cho driver (thẻ phát vật lý tại site, UC-ADM-04). Driver tự gắn trong app (#5 `active → unlinked` và ngược lại) = **Should**. Lý do: tự gắn cần cơ chế chứng minh sở hữu thẻ (quẹt tại trụ + xác nhận trong app) — thêm một luồng OCPP, không có trong demo.

**Ghi chú WP2 cho ADR-0012:** `card_kind` ∈ {online, wallet, free_vend} quyết `payment_mode` của phiên: `online → csms_billed`, `wallet → station_wallet` (trụ đã trừ tiền, CSMS không thu), `free_vend → free`. Thẻ `wallet` có thể mở phiên **khi trụ offline, không qua Authorize** — CSMS chỉ biết khi StartTransaction phát lại. Authorize cho idTag không có trong `rfid_cards` → `Invalid`.

---

## 5. Trả lời gọn 5 câu của Ân

| Câu | Trả lời |
|---|---|
| STM-1 timeouts | Start 120 s (động theo `ConnectionTimeOut`); orphaned theo `offline` của STM-3; hard cap 24 h; skew phát lại 5 s. Mục 1.3 |
| `failed` OK? | OK. Thêm `review`. Mục 1.1 |
| STM-2 khớp enum code? | Enum sinh từ T11 với 9 giá trị OCPP nguyên văn; khớp theo xây dựng. Mục 2.2, 2.5 |
| STM-3 giá trị `lifecycle` | Xác nhận 6 giá trị; sửa trigger #4, #5. Mục 3 |
| STM-8 ai gắn thẻ | Operator/Admin (Must); driver tự gắn (Should). Mục 4 |

---

## 6. Hệ quả cho các task khác

- **T11** (CSDL vật lý): enum `sessions.status` 9 giá trị gồm `review`; `connectors.status` 9 giá trị OCPP; bảng `charge_point_connections`; cột `unexpected_transition` trong `connector_status_events`.
- **T24** (WF-03): thêm bước TriggerMessage(StatusNotification) khi epoch mới; đường `closed → review`.
- **Epoch phải khởi tạo từ DB** (`MAX(epoch)+1` trong `charge_point_connections`), không đếm trong RAM — EXP-01 chính là ca CSMS chết và registry mất sạch (T24 #9).
- **Tên bảng phiên là `sessions`** (theo ERD T10 và T11); ADR-0010 và package diagram đang viết `transactions` → sửa chữ khi merge, không đổi nghĩa.
- **T33** (Iteration 1 + test): 22 chuyển STM-1 → 22 test chuyển hợp lệ + test chuyển không hợp lệ bị từ chối (ví dụ `reconciled → active`); STM-2: test "chuyển bất thường được ghi và gắn cờ". Fixture: trace JSONL thật của EXP-01.
- **Report 4:** ghi ngoại lệ "Connector không từ chối chuyển" (mục 2.1) và lý do thêm `review` (mục 1.1).
