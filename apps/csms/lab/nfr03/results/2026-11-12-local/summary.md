# Kết quả đo NFR-03 / NFR-OCPP-01: local, 50 trụ × 600 s

> Sinh tự động bởi `lab/nfr03` từ `client-rows.jsonl` và `server-rows.jsonl`. Tính lại: `node lab/nfr03/analyze.mjs <thư mục này>`.

> **Số đo LOCAL, chưa phải staging.** CSMS, Postgres nhúng và 50 trụ giả chạy trên cùng một máy dev qua loopback (không TLS, không Caddy, không trễ mạng). Cam kết BM04 là đo trên staging; lần chạy này chứng minh dụng cụ đo và cho một con số tham khảo.

## Kết luận

Ngưỡng: p95 thời gian CSMS trả lời một CALL của trụ ≤ 1000 ms, với 50 trụ giả trong 600 s.

| Số đo | p95 gộp mọi bản tin (ms) | So ngưỡng |
|---|---:|---|
| Phía server (`ocpp_message_log`) | 9 | ĐẠT |
| Phía client (trụ giả, gồm cả mạng) | 9,2 | ĐẠT |

**Lần chạy này: ĐẠT.**

Chưa dùng được làm số chính thức của NFR-03 vì: đo local, không phải staging.

## Tải đã chạy

| | |
|---|---|
| Đích | `ws://127.0.0.1:9200/ocpp` (local) |
| Trụ | 50/50 nối được; 0 lần bắt tay bị từ chối; 0 lần rớt kết nối giữa chừng |
| Thời gian | nối dần 25 s + tải 600 s; cả lần chạy 625 s (2026-11-12T11:31:26.020Z → 2026-11-12T11:41:51.044Z) |
| Hồ sơ | MeterValues mỗi 10 s; Heartbeat mỗi 300 s; phiên 6–18 nhịp, nghỉ 5–20 s; seed 20261112 |
| Phiên sạc | 260 bắt đầu, 260 dừng xong; 0 lần Authorize không Accepted |
| Bản tin trụ gửi | 4963 CALL (7,9 CALL/s trung bình): ok 4963 |
| Độ trễ vòng lặp của bộ sinh tải | p50 15,5 ms, p99 19,8 ms, max 40,4 ms (chỉ báo bộ sinh tải có nghẽn không; trên Windows mức nền khoảng 15 ms là độ mịn timer của hệ điều hành) |

## Phía server: thời gian CSMS giữ bản tin

Từ `ocpp_message_log`: `received_at` của CALLRESULT/CALLERROR chiều ra trừ `received_at` của CALL chiều vào, ghép theo (trụ, epoch, unique_id). Độ phân giải 1 ms. Không gồm mạng, TLS, proxy.

| Bản tin | n | Không được trả lời | CALLERROR | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | p95 ≤ 1 s |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| **Tất cả** | 4963 | 0 | 0 | 5 | **9** | 16 | 176 | ĐẠT |
| Authorize | 260 | 0 | 0 | 3 | 5 | 10 | 16 | ĐẠT |
| BootNotification | 50 | 0 | 0 | 6 | 13 | 64 | 64 | ĐẠT |
| Heartbeat | 100 | 0 | 0 | 2 | 3 | 4 | 6 | ĐẠT |
| MeterValues | 2743 | 0 | 0 | 5 | 8 | 14 | 51 | ĐẠT |
| StartTransaction | 260 | 0 | 0 | 5 | 11 | 21 | 52 | ĐẠT |
| StatusNotification | 1290 | 0 | 0 | 5 | 8 | 16 | 176 | ĐẠT |
| StopTransaction | 260 | 0 | 0 | 8 | 14 | 27 | 60 | ĐẠT |

## Phía client: từ lúc trụ gửi CALL tới lúc nhận trả lời

Đo trong tiến trình bộ sinh tải, từ ngay sau `ws.send()` tới khi frame trả lời về. Gồm mạng hai chiều, TLS/proxy (nếu có) và độ trễ của chính bộ sinh tải.

| Bản tin | n | Không được trả lời | CALLERROR | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | p95 ≤ 1 s |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| **Tất cả** | 4963 | 0 | 0 | 4,9 | **9,2** | 16,3 | 176,8 | ĐẠT |
| Authorize | 260 | 0 | 0 | 3,1 | 5,7 | 11,1 | 15,3 | ĐẠT |
| BootNotification | 50 | 0 | 0 | 6,0 | 13,1 | 69,4 | 69,4 | ĐẠT |
| Heartbeat | 100 | 0 | 0 | 1,8 | 3,6 | 5,3 | 6,2 | ĐẠT |
| MeterValues | 2743 | 0 | 0 | 4,9 | 8,7 | 14,5 | 51,1 | ĐẠT |
| StartTransaction | 260 | 0 | 0 | 5,3 | 10,6 | 20,8 | 51,3 | ĐẠT |
| StatusNotification | 1290 | 0 | 0 | 5,0 | 8,3 | 16,4 | 176,8 | ĐẠT |
| StopTransaction | 260 | 0 | 0 | 8,1 | 14,8 | 26,5 | 60,2 | ĐẠT |

## Chênh lệch client − server của cùng một bản tin

Phần số đo server không thấy: mạng, TLS/proxy, bộ đệm socket, độ trễ của bộ sinh tải.

| Bản tin | n | p50 (ms) | p95 (ms) | max (ms) |
|---|---:|---:|---:|---:|
| **Tất cả** | 4963 | 0,2 | 0,9 | 11,5 |
| Authorize | 260 | 0,1 | 0,9 | 1,7 |
| BootNotification | 50 | 0,2 | 1,0 | 5,4 |
| Heartbeat | 100 | 0,1 | 1,0 | 1,3 |
| MeterValues | 2743 | 0,2 | 0,9 | 11,5 |
| StartTransaction | 260 | 0,1 | 0,9 | 2,6 |
| StatusNotification | 1290 | 0,2 | 0,8 | 2,8 |
| StopTransaction | 260 | 0,1 | 0,9 | 7,4 |

## Dữ liệu trụ tải để lại trong DB (cộng dồn mọi lần chạy)

| Bảng | Số dòng |
|---|---:|
| `ocpp_message_log` | 10226 |
| `meter_values` | 5486 |
| `sessions` | 260 |
| `session_status_history` | 780 |
| `reconciliation_records` | 0 |
| `connector_status_events` | 1290 |
| `charge_point_connections` | 50 |
| `remote_commands` | 0 |
| `fault_events` | 0 |
| `session_debits` | 0 |

Phiên theo trạng thái: reconciled 260.

## Môi trường

| | |
|---|---|
| Commit | `1227be71f0872041e3979f9cb2a967957c81c939` (feat/be-37-nfr03-do-tai) |
| Máy bắn tải | Intel(R) Core(TM) i5-10400F CPU @ 2.90GHz, 12 luồng, 15.9 GB RAM, Windows_NT 10.0.26200, Node v24.18.1 |
| CSMS (local) | `OCPP_PORT=9200` `CONSOLE_ENABLED=false` `ALLOW_LEGACY_NO_CREDENTIAL=false` `RECONCILIATION_ENABLED=true` `OFFLINE_GRACE_S=120` `METER_VALUE_SAMPLE_INTERVAL_S=10` `RECONCILE_GAP_FACTOR=3` `RECONCILE_ENERGY_TOLERANCE_WH=1` `REPLAY_SKEW_THRESHOLD_S=5` `SESSION_START_TIMEOUT_S=120` `SESSION_HARD_CAP_H=24` `OCPP_HEARTBEAT_INTERVAL_SECONDS=300` |
