# simulator — WP5

Trạm sạc mô phỏng. **Phần cứng của đồ án này hoàn toàn là simulator** — độ tin cậy của nó là câu hỏi hội đồng sẽ hỏi, nên phải trả lời được bằng cấu hình và log, không bằng lời.

| | |
|---|---|
| Chủ sở hữu | WP5 — Backend / QA Engineer |
| Thượng nguồn | [SAP/e-mobility-charging-stations-simulator](https://github.com/SAP/e-mobility-charging-stations-simulator) · Apache-2.0 |
| Phiên bản ghim | tag `web@v4.12.0` = commit `227ec233edbc115a879fb18fb0094b99694954fe` · pnpm 11.22.0 (`packageManager` của upstream) |
| Cột mốc | **M1 — 06/09/2026** (chạy được), **M2 — 04/10/2026** (patch xong) |

## Vì sao chọn SAP simulator

- Mặc định OCPP 1.6J.
- Có sẵn template DC hai súng 50 kW với `MeterValues` gồm SoC, điện áp, dòng, công suất, năng lượng.
- Scale nhiều trạm bằng worker pool.
- Có buffer message khi mất WebSocket — đúng thứ thí nghiệm ablation cần.

## QA-01 — Template trụ D1 / YJ-EU

Bắt đầu từ `abb.station-template.json` (đã có `numberOfConnectors: 2`, đúng cấu hình dual gun), chỉnh theo SRS phần cứng D1 / YJ-EU: dải công suất 60–160 kW, đánh địa chỉ module lẻ cho súng A và chẵn cho súng B.

## QA-02 — Bản patch bắt buộc (4 ngày công)

Nhánh 1.6 của SAP simulator **không hỗ trợ** các configuration key sau:

| Key | Spec |
|---|---|
| `LocalAuthorizeOffline` | OCPP 1.6 §9.1.12 |
| `LocalPreAuthorize` | OCPP 1.6 §9.1.13 |
| `TransactionMessageAttempts` | OCPP 1.6 §9.1 |
| `TransactionMessageRetryInterval` | OCPP 1.6 §9.1 |
| `StopTxnAlignedData` | OCPP 1.6 §9.1 |
| `ClockAlignedDataInterval` | OCPP 1.6 §9.1 |

Đây **chính xác** là những key mà thí nghiệm ablation (QA-08) cần điều khiển. Không patch thì không có thí nghiệm.

Patch một dự án Apache-2.0 rẻ hơn nhiều so với tự viết simulator từ đầu. Nếu đóng góp ngược lên upstream, đó là một điểm rất mạnh khi nói chuyện với doanh nghiệp.

## Cách quản lý mã thượng nguồn

Không copy toàn bộ mã nguồn SAP vào kho này. Cách làm:

1. Clone upstream ra ngoài kho, **ghim đúng một tag/commit** (hiện: `web@v4.12.0`).
2. Giữ trong `simulator/` phần thuộc về nhóm: template trạm, file `.patch`, script dựng, cấu hình chạy.
3. Tag và SHA đã ghim nằm ở bảng đầu file này; đây là nơi duy nhất ghim SAP (không có trong `package.json`). Đổi phiên bản thì ghi lý do vào ADR. Cấu hình bàn thí nghiệm đã dùng: [apps/csms/lab/simulator/README.md](../apps/csms/lab/simulator/README.md).

Giữ nguyên header giấy phép Apache-2.0 và ghi rõ phần nào là sửa đổi của nhóm — đây là nghĩa vụ của Apache-2.0, và cũng là thứ hội đồng có thể hỏi.

## Cấu trúc dự kiến

```
simulator/
├── templates/       Template trạm D1 / YJ-EU hai súng DC
├── patches/         File .patch cho nhánh 1.6 upstream (QA-02)
├── scenarios/       Kịch bản ablation (QA-08): mất mạng, replay, trùng giao dịch, lỗ hổng chuỗi meter
└── scripts/         Dựng, chạy, thu log
```
