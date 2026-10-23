# lab — bàn thí nghiệm OCPP của WP2

Dụng cụ đo, **không phải sản phẩm**. BE-02 thật dựng trên NestJS sau; những file ở đây tồn tại để trả lời câu hỏi bằng log thật thay vì bằng phỏng đoán.

## Các file

| File | Việc |
|---|---|
| `mini-csms.mjs` | CSMS chỉ-nghe đầu tiên. **Đừng đổi hành vi** — EXP-01 phải tái lập được đúng như lúc chạy. Format lại thì không sao |
| `csms-ctl.mjs` | mini-CSMS + mặt điều khiển HTTP: gửi được lệnh xuống trụ, cắt kết nối theo lệnh |
| `fake-station.mjs` | Trụ giả hai súng theo spec OCPP 1.6. **Không phải simulator chính thức** — xem bên dưới |
| `trace.mjs` | Ghi frame thô ra JSONL, dùng chung |
| `trace-to-mermaid.mjs` | Dựng sequence diagram từ trace |
| `exp-02-dat-cho.mjs` | Kịch bản EXP-02 |
| `simulator/` | Cấu hình cho SAP simulator — template trụ D1, idtags, config |

## Simulator nào là thật

| | Dùng khi nào |
|---|---|
| **SAP e-mobility-charging-stations-simulator** | **Simulator chính thức (QA-01, WP5).** Mọi số liệu đưa vào báo cáo phải chạy trên nó |
| `fake-station.mjs` | Chỉ để thử lớp điều khiển mà không phải build SAP. Tiện cho CI và cho máy chưa dựng SAP |

Trụ giả mô hình hoá hành vi theo **đúng spec OCPP 1.6** ở những chỗ manual Ruihua im lặng — đúng tinh thần **BR-P09**. Nó không nói gì về firmware thật.

## Chạy

```bash
cd apps/csms

node lab/csms-ctl.mjs            # OCPP ws://localhost:9000/ocpp/{identity}
                                 # điều khiển http://localhost:9100
node lab/fake-station.mjs        # hoặc trỏ SAP simulator vào cổng 9000
```

### Mặt điều khiển

```bash
# Trụ nào đang nối, epoch bao nhiêu, phiên nào đang mở
curl localhost:9100/stations

# Gửi lệnh — body rỗng thì dùng tham số mặc định hợp lý
curl -X POST localhost:9100/call/RH24D1-001/ReserveNow \
     -H 'content-type: application/json' \
     -d '{"connectorId":1,"idTag":"DRIVER-A","reservationId":1001}'

curl -X POST localhost:9100/call/RH24D1-001/RemoteStartTransaction \
     -d '{"connectorId":1,"idTag":"DRIVER-A"}'

# Dò mọi configuration key trụ hỗ trợ — không cần hỏi hãng
curl -X POST localhost:9100/call/RH24D1-001/GetConfiguration -d '{}'

# Cắt kết nối để chạy kịch bản ngắt
curl -X POST localhost:9100/disconnect/RH24D1-001
```

Lệnh cho phép: `RemoteStartTransaction`, `RemoteStopTransaction`, `ReserveNow`, `CancelReservation`, `Reset`, `UnlockConnector`, `ChangeAvailability`, `GetConfiguration`, `ChangeConfiguration`, `TriggerMessage`, `GetLocalListVersion`, `DataTransfer`.

`strictMode` bật cả hai chiều, nên lệnh sai schema bị chặn tại chỗ thay vì để trụ trả `CALLERROR`.

## Thí nghiệm

| | Nội dung |
|---|---|
| [EXP-01](EXP-01-ngat-ket-noi-81s.md) | Ngắt kết nối 81 giây, 6 mẫu phát lại |
| [EXP-02](EXP-02-dat-cho.md) | Đặt chỗ connector — và vì sao ước lượng 1 ngày công cho FR-20 là thấp |

## Định dạng trace

Một dòng JSON cho một frame:

```json
{
  "received_at": "...",      // đồng hồ CSMS — tin được
  "cp": "RH24D1-001",
  "dir": "in" | "out",
  "type": 2 | 3 | 4,          // CALL / CALLRESULT / CALLERROR
  "id": "...",
  "action": "MeterValues",
  "cp_timestamp": "...",      // đồng hồ trụ — KHÔNG tin được
  "epoch": 1,                 // lần kết nối thứ mấy của trụ này
  "epoch_opened_at": "...",   // bản tin có cp_timestamp sớm hơn mốc này
  "raw": "..."                //   là ứng viên phát lại từ hàng đợi offline
}
```

`cp_timestamp` cạnh `received_at` là **ADR-0009**. `epoch` là nền của phát hiện phát lại: OCPP 1.6 không có cờ nào phân biệt bản tin phát lại với bản tin thời gian thực (OCA vá ở 2.0.1 bằng `offline` + `seqNo`), nên phải suy ra từ mốc mở kết nối.
