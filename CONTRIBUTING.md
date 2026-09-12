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

> GitHub hiện **không chặn** được việc này — org ở gói Free nên branch protection không có hiệu lực
> trên repo private. Nhóm dùng ba rào chắn thay thế; xem mục 10. Việc đầu tiên khi clone repo về máy:
>
> ```bash
> npm install          # tự bật hook pre-push
> npm run setup:hooks  # chạy nếu nghi ngờ hook chưa bật
> ```

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
- CI quét `gitleaks` trên mọi PR và mọi push vào `main`. Phát hiện bí mật là **fail PR**, không phải cảnh báo suông.
- Báo động nhầm thì thêm đường dẫn hoặc mẫu vào `[allowlist]` trong `.gitleaks.toml`, **kèm một dòng giải thích vì sao nó vô hại**. Không thêm im lặng.
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

---

## 10. Ba rào chắn thay cho branch protection

Org `PowerMeApp` ở gói Free. GitHub chỉ thực thi branch protection và ruleset trên repo public
hoặc gói trả phí, nên với repo private này **máy không chặn ai cả**. Ba thứ dưới đây lấp chỗ trống.

### 10.1. Hook `pre-push` — chặn ngay trên máy

`npm install` tự trỏ git sang `.githooks/`. Từ đó, `git push` vào `main` bị từ chối ngay tại máy,
trước khi chạm tới GitHub, kèm hướng dẫn chuyển commit sang nhánh mới.

Trường hợp thật sự cần push thẳng — hiếm, và phải báo nhóm trước:

```bash
POWERME_ALLOW_MAIN_PUSH=1 git push origin main
```

### 10.2. `gitleaks` — thay Secret scanning

GitHub không cho bật Secret scanning trên repo private của org Free (API trả `422`). CI chạy
`gitleaks` quét **toàn bộ lịch sử** trên mọi PR. Quét cả lịch sử chứ không chỉ commit mới, vì một
bí mật lỡ commit rồi xoá ở commit sau vẫn nằm nguyên trong lịch sử và vẫn phải coi là đã lộ.

Đây là rào chắn quan trọng nhất trong ba cái. Mất rào `main` thì cùng lắm phải revert; commit nhầm
khoá VNPay lên GitHub thì phải đi thu hồi khoá với nhà cung cấp.

### 10.3. Cảnh gác `main` — để lại dấu vết

Mỗi commit vào `main` không gắn với PR nào sẽ tự sinh một issue gán cho người push, gắn nhãn
`p1:quan-trong`, và job hiện dấu đỏ trên trang repo.

Nó **không chặn** được gì. Tác dụng của nó là làm việc đó không thể diễn ra lặng lẽ — và với một
nhóm năm người ngồi cùng lớp thì thế là đủ.

### Giới hạn cần hiểu đúng

Hook nằm trên máy từng người: ai xoá `core.hooksPath` là vượt được. Cảnh gác `main` chỉ ghi nhận
sau khi việc đã xảy ra. Ba rào này chặn **lỗi bất cẩn**, không chặn **ý định**.

Cách sửa tận gốc là nâng org lên GitHub Team — miễn phí qua
[GitHub Education](https://education.github.com/discount_requests/application) — rồi chạy:

```bash
bash scripts/setup-github.sh PowerMeApp/powerme
```
