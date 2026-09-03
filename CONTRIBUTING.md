# Quy ước làm việc — PowerMe

Tài liệu này là kết quả của task **PM-01** (Quy ước nhóm, công cụ, quy trình git, định nghĩa hoàn thành).
Mọi thành viên đọc hết một lần trước khi mở nhánh đầu tiên.

---

## 1. Mã công việc

Mỗi task trong [kế hoạch](docs/KE-HOACH-POWERME.md) có một mã cố định. Mã này đi theo task suốt vòng đời: issue → nhánh → commit → PR.

| Tiền tố | Work package | Vai trò |
|---|---|---|
| `PM-` | WP1 | Project Manager / BA |
| `BE-` | WP2 | Backend / IoT Engineer — CSMS OCPP |
| `MB-` | WP3 | Mobile Developer |
| `FE-` | WP4 | Full-stack Developer — Dashboard |
| `QA-` | WP5 | Backend / QA Engineer — Simulator, tính tiền, nghiên cứu |

---

## 2. Nhánh

`main` là nhánh duy nhất tồn tại lâu dài, luôn ở trạng thái deploy được lên staging.
**Không ai push thẳng vào `main`.** Mọi thay đổi đi qua Pull Request.

```
main
 └── wp2/be-04-lenh-xuong-tru
 └── wp4/fe-08-trinh-xem-ban-tin-ocpp
 └── wp1/pm-05-erd-openapi
```

**Cú pháp:** `wp<số>/<mã-task-viết-thường>-<mô-tả-ngắn-không-dấu>`

Một nhánh giải quyết đúng một task. Nhánh sống quá 5 ngày là dấu hiệu task chia chưa đủ nhỏ — báo trong standup.

Đồng bộ với `main` bằng **rebase**, không merge ngược:

```bash
git fetch origin
git rebase origin/main
```

---

## 3. Commit

Theo [Conventional Commits](https://www.conventionalcommits.org/), có kèm mã task trong phần mô tả.

```
<loại>(<phạm vi>): <mô tả>  [MÃ-TASK]
```

| Loại | Dùng khi |
|---|---|
| `feat` | Thêm tính năng |
| `fix` | Sửa lỗi |
| `refactor` | Đổi cấu trúc, không đổi hành vi |
| `test` | Thêm hoặc sửa test |
| `docs` | Tài liệu |
| `chore` | Cấu hình, phụ thuộc, hạ tầng |
| `perf` | Cải thiện hiệu năng |

Phạm vi thường dùng: `csms`, `dashboard`, `mobile`, `shared`, `simulator`, `infra`, `docs`.

```
feat(csms): state machine doc lap cho tung sung cua tru dual gun  [BE-05]
fix(csms): khong ghi de transactionId khi StartTransaction den lai  [BE-03]
docs(shared): bo sung enum ChargePointErrorCode theo OCPP 1.6 muc 7.4  [PM-02]
```

---

## 4. Pull Request

**Điều kiện gộp:**

1. CI xanh — lint, typecheck, test, build đều qua.
2. **Ít nhất một approve** từ thành viên khác. Người review không phải người viết.
3. Mọi comment đã được xử lý hoặc trả lời.
4. Mô tả PR điền đủ theo mẫu, có ghi mã task.

**Cách gộp:** `Squash and merge`. Lịch sử `main` giữ một commit cho một task, tiêu đề commit gộp chính là tiêu đề PR.

PR quá 400 dòng thay đổi (không tính file sinh tự động) thì tách nhỏ. Review một PR nghìn dòng là review giả.

**Thời hạn review:** trong vòng 24 giờ làm việc. Nếu quá hạn, nhắc trực tiếp trong nhóm.

---

## 5. Định nghĩa hoàn thành (Definition of Done)

Một task chỉ được kéo sang cột *Done* khi **toàn bộ** các điều sau đúng:

- [ ] Code đã gộp vào `main` qua PR có approve.
- [ ] Có test tự động cho phần logic mới. Với CSMS: test bao phủ cả nhánh lỗi, không chỉ nhánh thành công.
- [ ] Chạy được trên môi trường staging, không phải chỉ trên máy cá nhân.
- [ ] Tài liệu liên quan đã cập nhật trong cùng sprint — OpenAPI, ERD, ADR, README của app.
- [ ] Không để lại `TODO` không có issue kèm theo.
- [ ] Với task chạm giao thức OCPP: có log bản tin thật chứng minh hành vi, đính kèm trong PR.

---

## 6. Quyết định kiến trúc

Mọi quyết định làm thay đổi kiến trúc, đổi thư viện lõi, hoặc lệch khỏi spec OCPP đều phải ghi lại thành một **ADR** trong `docs/adr/`, đánh số tăng dần: `docs/adr/0001-ten-quyet-dinh.md`.

Mỗi ADR trả lời bốn câu: bối cảnh, quyết định, hệ quả, các phương án đã cân nhắc và loại bỏ.

Lý do: hội đồng bảo vệ sẽ hỏi "vì sao chọn cách này". Ghi lúc quyết định mất 15 phút, dựng lại sau ba tháng mất cả buổi.

---

## 7. Bí mật và cấu hình

- **Không commit `.env`, khoá riêng, chứng chỉ, credential VNPay.** `.gitignore` đã chặn, nhưng chặn được không có nghĩa là được phép thử.
- Thêm biến môi trường mới thì cập nhật `infra/.env.example` trong cùng PR, để giá trị giả.
- Lỡ commit secret: **coi như đã lộ**. Thu hồi và cấp lại khoá trước, dọn lịch sử git sau.

---

## 8. Ghim phiên bản

SteVe và SAP simulator là hai dự án biến động nhanh. **Không dùng tag `latest`** ở bất kỳ đâu — Docker image, submodule, dependency đều ghim phiên bản cụ thể.

Phiên bản đang dùng ghi trong [infra/docker-compose.yml](infra/docker-compose.yml) và [simulator/README.md](simulator/README.md).

---

## 9. Nhịp làm việc

| | |
|---|---|
| Sprint | 2 tuần, 6 sprint |
| Standup | Ghi ngắn trong kênh nhóm, không họp dài |
| Sprint review | Cuối mỗi sprint, demo chạy thật |
| Retro | Cuối mỗi sprint, ba câu: giữ gì, bỏ gì, thử gì |

Việc cả năm người cùng chịu: review code lẫn nhau, tự viết test cho phần mình, cập nhật tài liệu trong sprint, có mặt đủ ở M3 và M6.
