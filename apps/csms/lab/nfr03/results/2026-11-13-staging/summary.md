# Kết quả đo NFR-03 / NFR-OCPP-01: staging, 50 trụ × 600 s

> Sinh tự động bởi `lab/nfr03` từ `client-rows.jsonl` và `server-rows.jsonl`. Tính lại: `node lab/nfr03/analyze.mjs <thư mục này>`.

## Kết luận

Ngưỡng: p95 thời gian CSMS trả lời một CALL của trụ ≤ 1000 ms, với 50 trụ giả trong 600 s.

| Số đo | p95 gộp mọi bản tin (ms) | So ngưỡng |
|---|---:|---|
| Phía server (`ocpp_message_log`) | 34 | ĐẠT |
| Phía client (trụ giả, gồm cả mạng) | 134,9 | ĐẠT |

**Lần chạy này: ĐẠT.**

## Tải đã chạy

| | |
|---|---|
| Đích | `wss://powerme-staging.japaneast.cloudapp.azure.com/ocpp` (staging) |
| Trụ | 50/50 nối được; 0 lần bắt tay bị từ chối; 0 lần rớt kết nối giữa chừng |
| Thời gian | nối dần 25 s + tải 600 s; cả lần chạy 625.5 s (2026-11-13T08:31:24.924Z → 2026-11-13T08:41:50.464Z) |
| Hồ sơ | MeterValues mỗi 10 s; Heartbeat mỗi 300 s; phiên 6–18 nhịp, nghỉ 5–20 s; seed 20261112 |
| Phiên sạc | 257 bắt đầu, 257 dừng xong; 0 lần Authorize không Accepted |
| Bản tin trụ gửi | 4919 CALL (7,9 CALL/s trung bình): ok 4919 |
| Độ trễ vòng lặp của bộ sinh tải | p50 15,4 ms, p99 20,8 ms, max 38,6 ms (chỉ báo bộ sinh tải có nghẽn không; trên Windows mức nền khoảng 15 ms là độ mịn timer của hệ điều hành) |

## Phía server: thời gian CSMS giữ bản tin

Từ `ocpp_message_log`: `received_at` của CALLRESULT/CALLERROR chiều ra trừ `received_at` của CALL chiều vào, ghép theo (trụ, epoch, unique_id). Độ phân giải 1 ms. Không gồm mạng, TLS, proxy.

| Bản tin | n | Không được trả lời | CALLERROR | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | p95 ≤ 1 s |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| **Tất cả** | 4919 | 0 | 0 | 18 | **34** | 51 | 152 | ĐẠT |
| Authorize | 257 | 0 | 0 | 11 | 25 | 33 | 39 | ĐẠT |
| BootNotification | 50 | 0 | 0 | 10 | 17 | 33 | 33 | ĐẠT |
| Heartbeat | 98 | 0 | 0 | 9 | 17 | 43 | 43 | ĐẠT |
| MeterValues | 2722 | 0 | 0 | 17 | 31 | 44 | 104 | ĐẠT |
| StartTransaction | 257 | 0 | 0 | 19 | 37 | 54 | 67 | ĐẠT |
| StatusNotification | 1278 | 0 | 0 | 18 | 34 | 55 | 152 | ĐẠT |
| StopTransaction | 257 | 0 | 0 | 31 | 55 | 114 | 119 | ĐẠT |

## Phía client: từ lúc trụ gửi CALL tới lúc nhận trả lời

Đo trong tiến trình bộ sinh tải, từ ngay sau `ws.send()` tới khi frame trả lời về. Gồm mạng hai chiều, TLS/proxy (nếu có) và độ trễ của chính bộ sinh tải.

| Bản tin | n | Không được trả lời | CALLERROR | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | p95 ≤ 1 s |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| **Tất cả** | 4919 | 0 | 0 | 117,1 | **134,9** | 150,6 | 253,5 | ĐẠT |
| Authorize | 257 | 0 | 0 | 110,0 | 125,3 | 136,2 | 138,8 | ĐẠT |
| BootNotification | 50 | 0 | 0 | 109,1 | 123,0 | 135,5 | 135,5 | ĐẠT |
| Heartbeat | 98 | 0 | 0 | 108,7 | 117,5 | 132,9 | 132,9 | ĐẠT |
| MeterValues | 2722 | 0 | 0 | 117,3 | 132,4 | 143,7 | 196,3 | ĐẠT |
| StartTransaction | 257 | 0 | 0 | 118,0 | 135,3 | 154,3 | 167,0 | ĐẠT |
| StatusNotification | 1278 | 0 | 0 | 117,0 | 133,8 | 151,5 | 253,5 | ĐẠT |
| StopTransaction | 257 | 0 | 0 | 129,6 | 155,3 | 206,9 | 220,2 | ĐẠT |

## Chênh lệch client − server của cùng một bản tin

Phần số đo server không thấy: mạng, TLS/proxy, bộ đệm socket, độ trễ của bộ sinh tải.

| Bản tin | n | p50 (ms) | p95 (ms) | max (ms) |
|---|---:|---:|---:|---:|
| **Tất cả** | 4919 | 100,3 | 106,3 | 127,5 |
| Authorize | 257 | 99,9 | 105,6 | 111,9 |
| BootNotification | 50 | 98,9 | 109,0 | 117,8 |
| Heartbeat | 98 | 99,8 | 105,6 | 107,2 |
| MeterValues | 2722 | 100,8 | 106,8 | 127,5 |
| StartTransaction | 257 | 100,0 | 105,3 | 113,5 |
| StatusNotification | 1278 | 99,9 | 105,8 | 119,3 |
| StopTransaction | 257 | 99,8 | 105,7 | 111,9 |

## Dữ liệu trụ tải để lại trong DB (cộng dồn mọi lần chạy)

| Bảng | Số dòng |
|---|---:|
| `ocpp_message_log` | 10246 |
| `meter_values` | 5464 |
| `sessions` | 259 |
| `session_status_history` | 777 |
| `reconciliation_records` | 0 |
| `connector_status_events` | 1302 |
| `charge_point_connections` | 54 |
| `remote_commands` | 0 |
| `fault_events` | 0 |
| `session_debits` | 0 |

Phiên theo trạng thái: reconciled 259.

## Môi trường

| | |
|---|---|
| Commit | `f6336a4ab78aa4800d83e5ba3152ad94719955e2` (main) |
| Máy bắn tải | Intel(R) Core(TM) i5-10400F CPU @ 2.90GHz, 12 luồng, 15.9 GB RAM, Windows_NT 10.0.26200, Node v24.18.1 |
