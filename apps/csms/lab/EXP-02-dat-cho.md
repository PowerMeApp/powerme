# EXP-02 — Đặt chỗ connector qua OCPP 1.6 Reservation profile

**Ngày chạy:** 08/10/2026 · **Người chạy:** WP2 · **Trace:** `lab/ocpp-traces/ctl-2026-10-08T01-49-48-599Z.jsonl`

## Vì sao chạy thí nghiệm này

Phiếu đăng ký **v1.2** (06/10) nâng **FR-20 đặt chỗ** từ *Could* lên **Must**, sau khi hội đồng Review 1 kết luận phạm vi quá nhỏ. Bảng effort Report 2 §1.2 ghi phần việc này cho WP2 là **`+1 reservation messages (2.9)` — một ngày công**.

Thí nghiệm này đo xem con số đó đứng được không, bằng log thật thay vì ước đoán. Phiếu khoá **18/10**, sau đó Must không cắt được nữa.

## Bàn thí nghiệm

```
fake-station.mjs  ──WebSocket OCPP 1.6J──►  csms-ctl.mjs  ◄──HTTP──  exp-02-dat-cho.mjs
  (trụ giả 2 súng)                          (CSMS + điều khiển)        (kịch bản)
```

⚠️ **Chạy trên trụ giả, không phải SAP simulator, càng không phải firmware Ruihua.** Trụ giả mô hình hoá hành vi theo đúng spec OCPP 1.6 cho những chỗ manual im lặng — đúng tinh thần **BR-P09**. Kết quả nói về *một trạm OCPP 1.6J đúng chuẩn*, không nói về D1/YJ-EU thật.

## Kết quả — 9/9 đạt

| # | Hành vi kiểm | Kết quả |
|---|---|---|
| 1 | Trụ khai báo profile `Reservation` | ✓ `Core,FirmwareManagement,LocalAuthListManagement,SmartCharging,RemoteTrigger,Reservation` |
| 2 | `ReserveNow` trên connector `Available` | ✓ `Accepted`, connector chuyển sang `Reserved` |
| 3 | `ReserveNow` lần hai, tuần tự, cùng connector | ✓ `Occupied` |
| 4 | **Hai `ReserveNow` đồng thời, cùng connector** | ✓ đúng một `Accepted`, một `Occupied` |
| 5 | `RemoteStartTransaction` bằng `idTag` lạ trên chỗ đã đặt | ✓ `Rejected` |
| 6 | `RemoteStartTransaction` đúng `idTag` đã giữ chỗ | ✓ `Accepted`, phiên mở, giữ chỗ bị tiêu thụ |
| 7 | `CancelReservation` chỗ có thật / không có thật | ✓ `Accepted` / `Rejected` |

Mục 4 chính là NFR đã cam kết trong phiếu v1.2: *"of two simultaneous reservations for one connector exactly one succeeds"*.

## Phát hiện quan trọng nhất

**Mục 4 đạt, nhưng không phải nhờ logic nào của CSMS.** Đọc trace:

```
01:50:41.607  out  ReserveNow {"connectorId":2,"idTag":"DRIVER-C","reservationId":2001}
01:50:41.608  out  ReserveNow {"connectorId":2,"idTag":"DRIVER-D","reservationId":2002}

reservationId=2001  CALL 41.607 → RESULT 41.608  {"status":"Accepted"}
reservationId=2002  CALL 41.608 → RESULT 41.609  {"status":"Occupied"}
```

Hai lệnh gửi bằng `Promise.all` nhưng **đi trên dây cách nhau 1 ms, tuần tự**. Nguyên nhân: `ocpp-rpc` đặt `callConcurrency = 1` mặc định, kèm chú thích trong mã nguồn *"OCPP requires this to be set to 1"*. Thư viện xếp hàng mọi CALL trên **một kết nối**.

Nghĩa là tính duy nhất ở đây do **hai thứ ngoài CSMS** bảo đảm:
1. Tầng vận chuyển xếp hàng theo từng kết nối WebSocket.
2. Trụ tự kiểm trạng thái connector trước khi nhận.

### Vì sao điều đó chưa đủ

| Tình huống | Trụ còn bảo vệ được không |
|---|---|
| Một tiến trình CSMS, một kết nối tới trụ | Có |
| CSMS chạy nhiều instance | **Không** — mỗi instance một kết nối, xếp hàng độc lập |
| Hai tài xế bấm đặt chỗ gần như cùng lúc | **Không** — cả hai có thể qua được bước kiểm "còn trống?" phía CSMS trước khi lệnh nào chạm tới trụ |
| **Trụ không hỗ trợ Reservation** (platform hold theo FR-16) | **Không có trụ nào để xếp hàng** — CSMS là lớp bảo vệ duy nhất |

Dòng cuối là tình huống FR-16 đã cam kết: *"connector reservation **with a platform hold when a pillar does not support it**"*. Trong đường đi đó, toàn bộ tính duy nhất nằm ở CSMS.

**Hệ quả thiết kế:** tính duy nhất của đặt chỗ phải nằm ở **ràng buộc UNIQUE trong CSDL**, cùng hình dạng với khoá chống trùng `StartTransaction` của **ADR-0010**. Không được phó mặc cho trụ. Cần một ADR riêng.

## Đối chiếu với ước lượng 1 ngày công

Những gì FR-20 thật sự đòi ở phía WP2:

| Việc | Có trong EXP-02 |
|---|---|
| Gửi `ReserveNow` / `CancelReservation` đúng schema | ✓ đã chạy |
| Ánh xạ `Accepted` / `Occupied` / `Faulted` / `Unavailable` / `Rejected` sang nghiệp vụ | một phần |
| Trạng thái `Reserved` trong state machine connector | ✓ quan sát được |
| Chỉ mở phiên cho đúng `idTag` đã giữ chỗ | ✓ đã chạy |
| Giữ chỗ hết hạn → tự nhả | chưa |
| **Ràng buộc UNIQUE chống đặt trùng ở CSDL** | **chưa — và đây là phần nặng nhất** |
| **Platform hold khi firmware không hỗ trợ** | **chưa** |
| Phí no-show trừ **đúng một lần** (NFR v1.2) | chưa — lại là bài toán idempotency |
| Cấu hình cửa sổ giữ chỗ và phí theo từng site (FR-12) | chưa |

Phần đã chạy được trong EXP-02 — gửi lệnh và đọc phản hồi — đúng là khoảng **một ngày công**. Nhưng ba dòng in đậm chưa đụng tới, và cả ba đều là bài toán **đồng thời và idempotency**, cùng họ với thứ đã phải viết hẳn ADR-0010 để giải.

**Đề nghị:** đưa `2.9` lên **4–5 ngày công**, hoặc tách thành hai hạng mục — *bản tin đặt chỗ* (1 md) và *tính toàn vẹn của đặt chỗ: UNIQUE, platform hold, phí no-show* (3–4 md).

## Câu hỏi cho hãng Ruihua — bổ sung vào danh sách hiện có

> Does the D1 / YJ-EU firmware support the OCPP 1.6 Reservation profile (`ReserveNow`, `CancelReservation`)? If yes, is `ReserveConnectorZeroSupported` true or false, and what happens if a walk-up user plugs in at a connector that currently holds a reservation?

Câu trả lời quyết định `platform hold` là **đường dự phòng** hay **đường chính**. Hai khả năng này khác nhau rất xa về khối lượng.

## Cách lặp lại

```bash
cd apps/csms
node lab/csms-ctl.mjs &          # CSMS + mặt điều khiển
node lab/fake-station.mjs &      # trụ giả
node lab/exp-02-dat-cho.mjs      # kịch bản, in 9 kết quả
```

## Việc tiếp theo

1. Chạy lại EXP-02 trên **SAP simulator** thay vì trụ giả — SAP là simulator chính thức của đồ án (QA-01). Hiện SAP chưa có trên máy, cần clone và build lại.
2. Thí nghiệm giữ chỗ hết hạn: đặt `expiryDate` ngắn rồi xem trụ có tự nhả không.
3. Thí nghiệm đặt chỗ **giữa lúc mất kết nối** — ghép EXP-01 với EXP-02.
