# Kịch bản trình diễn Review 2 — 6 phút 30

> Người nói: Trí (WF-03). Hai tab cạnh nhau: **trái = HMI trụ D1** (`http://localhost:8100/`), **phải = console CSMS** (`http://localhost:3000/`). Terminal `npm run demo` để ở cửa sổ thứ ba, thu nhỏ.
> Số liệu trong kịch bản là của **lần chạy thật 23/10/2026** (xem [`../DEMO-REVIEW-2.md`](../DEMO-REVIEW-2.md), ảnh trong thư mục này). **Mỗi lần chạy sẽ ra số khác** (mét khởi đầu, Wh, giây); chỉ cấu trúc là cố định: `active → orphaned → active → review`, 9 bản ghi `replay`, 1 bản ghi `conflict` mỗi phiên.
> Thời gian là mốc **mm:ss tính từ lúc bắt đầu nói**; đồng hồ dư ±10 s là bình thường. Chỗ **[chờ]** là thời gian chết có thật (trụ đang sạc, trụ đang đứt mạng) — dùng để nói.

## Trước giờ demo (làm ở phòng chờ, 5 phút)

- [ ] `git status` sạch, nhánh `main` mới nhất, `npm install --ignore-scripts` đã chạy.
- [ ] `netstat -ano | findstr "9000 54330 8100 3000"` — trống. Nếu có thứ khác đang giữ cổng, xem ai giữ trước khi tắt (hoặc `--port-offset 10`).
- [ ] **`npm run demo:reset -w @powerme/csms`**, chờ `=== Demo PowerMe sẵn sàng sau N s ===` (lạnh ~23 s). Dùng `reset` để số phiên bắt đầu từ **#1** và kịch bản khớp lời thoại.
- [ ] Tab console: **1 online · 0 offline**, "Chưa có phiên sạc". Tab HMI: **Mạng: online**, hai súng **Available**.
- [ ] `STALE_METERSTOP` đang bật (mặc định). Kiểm: không đặt biến `STALE_METERSTOP=0` trong shell.
- [ ] **Chạy thử một lần** toàn bộ kịch bản này rồi `demo:reset` lại (mất ~6 phút; đáng làm, vì dòng "phát lại" chỉ có khi rớt mạng thật).
- [ ] Trên HMI: bấm "Chữ lớn" nếu chiếu máy chiếu. Bấm F11 cho cả hai tab. Phóng to console bằng Ctrl+`+` nếu phòng lớn.
- [ ] Pin đủ, tắt thông báo, tắt Wi-Fi cũng được (mọi thứ là localhost).
- [ ] Mở sẵn (tab thứ ba, chưa chiếu): `docs/WF-03-MAT-KET-NOI-VA-DOI-SOAT.md` (sequence diagram) và ảnh dự phòng trong `docs/demo/`.
- [ ] Biết sẵn lệnh xem DB: `node apps/csms/demo/show.mjs`.

---

## (a) 00:00–00:40 — Console trống, trụ lên online

| Giờ | Bấm | Nói | Thấy |
| --- | --- | --- | --- |
| 00:00 | Chiếu tab **console**. Không bấm gì. | "Đây là bảng điều khiển vận hành của CSMS PowerMe. Bên trái là trụ và hai súng, bên phải là phiên sạc, đối soát và nhật ký OCPP trực tiếp." | Thẻ **1 online · 0 offline**, "Chưa có phiên sạc", "Chưa có bản ghi đối soát". Nhật ký OCPP chạy: `BootNotification`, `StatusNotification`. |
| 00:15 | Chỉ vào nhật ký OCPP; vài dòng có huy hiệu **PHÁT LẠI** màu cam. | "Mấy dòng PHÁT LẠI lúc vừa bật là trụ gửi các trạng thái xếp hàng trước khi nối; chưa có phiên nên không ảnh hưởng gì. Lát nữa dòng này mới là chính." | 3–4 dòng `StatusNotification` có huy hiệu PHÁT LẠI. |
| 00:25 | Chuyển sang tab **HMI**. | "Đây là màn hình HMI của trụ D1 120 kW, hai súng A và B. **Đây là bản mô phỏng**, bám quan sát EXP-01, chưa phải firmware Ruihua." | **Mạng: online**, Súng A / B `Available`, nhật ký OCPP phía trụ có `BootNotification` → `Accepted`. |

**Nếu sự cố:** console hiện **0 online** → HMI chưa nối: xem dòng `[hmi]` trong terminal; HMI tự thử lại mỗi 30 s. Quá 90 s vẫn không nối → kế hoạch B (cuối tài liệu).

## (b) 00:40–01:50 — Quẹt thẻ hợp lệ ở súng A, sạc

| Giờ | Bấm | Nói | Thấy |
| --- | --- | --- | --- |
| 00:40 | HMI, Súng A: **Cắm súng**. | "Tài xế cắm súng A vào xe." | Súng A `Preparing`; thanh SoC xuất hiện (ngẫu nhiên 20–60 %). |
| 00:50 | Ô "Thẻ RFID" của súng A = *Thẻ hợp lệ (đã đăng ký)* → **Quẹt thẻ**. | "Quẹt thẻ đã đăng ký. Trụ hỏi CSMS: thẻ này hợp lệ không?" | HMI: "Thẻ được chấp nhận — bắt đầu sạc". Nhật ký OCPP: `Authorize` → `Accepted`, `StartTransaction`. Súng A `Charging`, 60 kW. |
| 01:00 | Chuyển sang tab **console**. | "Phía CSMS, phiên số 1 vừa xuất hiện." | Hàng **#1** `RH24D1-00001 / 1`, `DEMO-CARD-0001`, `rfid · csms_billed`, **active**, meter `123000 → —`. Ô "đang sạc" = **1**. |
| 01:10 | Chỉ cột "Điện năng" và "Mẫu". **[chờ ~30 s]** | "Cứ 10 giây trụ gửi một MeterValues. Số Wh có dấu sao nghiêng nghĩa là phiên chưa dừng, CSMS suy từ chuỗi đo mới nhất. Nguồn thanh toán là **csms_billed**: thẻ online, CSMS sẽ tính tiền." | Wh tăng (ví dụ **817 Wh\*** sau ~40 s), cột Mẫu tăng, dòng `MeterValues` mới mỗi 10 s. |

**Nếu sự cố:** HMI báo "CSMS từ chối thẻ: Invalid" → seed sai hoặc DB không phải bản reset: chạy `demo:reset`. Báo "Hãy cắm súng trước khi quẹt thẻ" → bấm **Cắm súng** trước.

## (c) 01:50–02:30 — Súng B quẹt thẻ ví: trụ tự thu tiền

| Giờ | Bấm | Nói | Thấy |
| --- | --- | --- | --- |
| 01:50 | HMI, Súng B: **Cắm súng** → ô thẻ = *Thẻ ví* → **Quẹt thẻ**. | "Súng B quẹt **thẻ ví** — tiền nằm trong thẻ, **trụ tự thu**." | Súng B `Charging`. |
| 02:05 | Console. | "Phiên số 2 ghi nguồn thanh toán là **station_wallet**. CSMS **chỉ ghi nhận** phiên và điện năng; **không** thu tiền cái thẻ này." | Hàng **#2** `DEMO-WALLET-0001`, `rfid · station_wallet`, **active**; ô "đang sạc" = **2**. Ảnh tham chiếu: `console-2-hai-sung-dang-sac.png`. |
| 02:20 | **[chờ ~10 s]** Cho thêm vài mẫu. | "Hai súng sạc song song, mỗi súng 60 kW." | Hai hàng cùng tăng Wh. |

> Lời cần tránh: "CSMS tính tiền" cho thẻ ví — sai. CSMS Iteration 1 **chưa tính tiền** cho cả hai loại thẻ (chưa có billing); chỉ khác nhau ở `payment_mode`.

## (d) 02:30–03:30 — Rớt mạng 60 giây giữa phiên

| Giờ | Bấm | Nói | Thấy |
| --- | --- | --- | --- |
| 02:30 | HMI: ô "Rớt mạng (s)" = **60** → **Rớt mạng**. Chuyển nhanh sang console. | "Bây giờ tôi cắt mạng của trụ 60 giây — giống trụ mất sóng giữa chừng. **Trụ vẫn sạc**, nhưng CSMS không còn nghe được gì." | Console: chấm đỏ **mất kết nối**, **0 online · 1 offline**, **2 phiên `orphaned` (mồ côi)** màu vàng. Chip súng vẫn ghi `Charging` (trạng thái cuối nhận được). Ảnh: `console-3-tru-mat-ket-noi.png`. |
| 02:40 | Quay lại HMI. | "Trụ không bỏ cuộc: nó **xếp hàng** các MeterValues không gửi được, giữ nguyên thời gian gốc, thử nối lại mỗi 30 giây." | HMI: **Mạng: OFFLINE**, "Hàng đợi buffer **4–5 (MeterValues ×n)**", "thử nối lại sau Ns", SoC vẫn tăng. Ảnh: `hmi-3-rot-mang-60s.png`. |
| 02:50 | **[chờ ~50 s]** Nói trong khi chờ (xem khung dưới). | Xem khung "Lời nói khi chờ". | Hàng đợi buffer tăng mỗi 10 s. Sau 30 s: dòng "thử nối lại thất bại (mạng còn đứt)". |
| 03:20 | — | "Sắp hết 60 giây." | Đếm ngược ở thẻ "Mạng và hàng đợi" về 0. |

**Lời nói khi chờ (khoảng 50 s):** "Đây là hiện tượng chúng tôi đo được ở EXP-01 trên simulator SAP: đứt 81 giây, trụ nối lại **không gửi Boot**, gửi bù các bản tin xếp hàng, và có **mẫu bị mất im lặng** — 8 mẫu buffer, chỉ 6 phát lại. CSMS phải chấp nhận cả hai trường hợp: dữ liệu đến muộn, và dữ liệu đến thiếu. Phần này của hệ thống em phụ trách: gateway giữ **epoch** cho mỗi lần nối, và máy trạng thái phiên có trạng thái `orphaned`."

**Nếu sự cố:** bấm nhầm 6 giây thay vì 60 → trụ nối lại sau 30 s, kịch bản vẫn chạy (rút ngắn). Trụ không nối lại sau 90 s → xem terminal `[csms]`; thử `curl localhost:8100/api/state` (net.state) — nếu `connecting` mãi, bấm **Khởi động lại**.

## (e) 03:30–05:30 — Nối lại: `review`, cờ phát lại, 969 so với 2505 Wh

| Giờ | Bấm | Nói | Thấy |
| --- | --- | --- | --- |
| 03:30 | Console (không bấm). Trụ tự nối lại ở mốc **đúng 60 s** sau khi rớt. | "Trụ đã nối lại — **epoch 2**, và **không gửi BootNotification**: CSMS nhận ra đây là cùng trụ, cùng phiên đang chạy." | Thẻ trụ về **đang nối**, "epoch 2". HMI: "đã nối lại — epoch 2 (KHÔNG gửi Boot)", "phát bù **11** bản tin buffer", "mất **2/11** MeterValues". |
| 03:50 | Chỉ panel **Đối soát**. | "Phiên của chúng ta **trở lại active** ngay khi có MeterValues sống đầu tiên. Và đây — **9 bản ghi `replay`**: CSMS phát hiện từng mẫu là **phát lại từ hàng đợi** bằng cách so thời gian gốc của trụ với lúc mở epoch. Nó giữ lại tất cả, không bỏ mẫu nào." | Hai hàng về **active**. Panel Đối soát: 9 dòng `replay` ("Bản tin MeterValues bị phát hiện là PHÁT LẠI từ hàng đợi offline của trụ"); log OCPP có huy hiệu PHÁT LẠI. Ảnh: `console-4-sau-noi-lai-co-phat-lai.png`. |
| 04:05 | **[chờ ~15 s]** | "Cho trụ sạc thêm một chút để có chuỗi đo mới." | `Wh*` của phiên #1 ≈ **2505**, của #2 ≈ **2195**. |
| 04:20 | HMI: Súng A → **Dừng sạc**. Chuyển sang console. | "Dừng sạc súng A. Trụ gửi `StopTransaction`." | Phiên **#1** chuyển **review** (đỏ), `123000 → 123969`, **969 Wh**, nhãn **conflict**. |
| 04:30 | Chỉ dòng đỏ ở panel Đối soát. | "Đây là phần quan trọng. `StopTransaction` mang `meterStop` **cũ** — **969 Wh** từ lúc bắt đầu. Nhưng chuỗi đo live cho thấy phiên đã sạc tới **125505**, tức **2505 Wh**. Lệch **1536 Wh**. CSMS **không tự quyết**: nó mở bản ghi `conflict`, đưa phiên vào `review` cho người xem xét. Nó tin dữ liệu nào? Đó là chính sách phải chốt với Ruihua." | Dòng đỏ: "**meterStop 969 Wh mâu thuẫn chuỗi đo 125505 Wh — lệch 1536 Wh**". Hàng đỏ #1 `review`. Ô "cần xem xét" = **1**; ô "Đối soát: conflict" = **1 / 10 bản ghi**. Ảnh: `console-5-phien-review-co-doi-soat.png`. |
| 04:55 | Bấm vào hàng **#1** để mở chi tiết (tuỳ chọn). | "Mở phiên ra thấy toàn bộ chuỗi mẫu và bản ghi đối soát." | Panel chi tiết phiên. |
| 05:10 | HMI: Súng B → **Dừng sạc**. | "Súng B cùng chung số phận vì **rớt mạng là của cả trụ**." | Phiên **#2** cũng `review`: `126000 → 126684` (684 Wh) so với chuỗi đo 128779, lệch **2095 Wh**. 2 phiên `review`, tổng 11 bản ghi (9 `replay` + 2 `conflict`). |

> Điều **không** nên nói: "đây là lỗi của firmware Ruihua". `meterStop` cũ là hiện tượng của **EXP-01 trên SAP**; trên HMI này chúng tôi **chủ động bật** (`STALE_METERSTOP`) để dựng tình huống. Hãy nói thẳng nếu hỏi: "Phần trụ là mô phỏng, tôi cố ý bật lỗi này để chứng minh đường đối soát."

**Nếu sự cố:**
- Phiên về **reconciled** (xanh) thay vì **review** → `STALE_METERSTOP` bị tắt. Nói đúng thực tế ("khi dữ liệu của trụ nhất quán, CSMS tự đối soát xong, 0 conflict") rồi chuyển **kế hoạch B** để cho xem `review` bằng trụ kịch bản.
- Số Wh khác trong kịch bản: bình thường, đọc số trên màn hình.
- Quá chậm/mất thời gian: bỏ bước mở chi tiết phiên (04:55).

## (f) 05:30–06:30 — Kết thúc, nói thẳng giới hạn

| Giờ | Bấm | Nói | Thấy |
| --- | --- | --- | --- |
| 05:30 | Console, để nguyên. | "Tóm lại: một trụ mô phỏng, hai súng, hai phiên, một lần rớt mạng 60 giây. CSMS ghi được **epoch**, giữ **mọi mẫu phát lại**, và phát hiện **mâu thuẫn meterStop** — phiên vào review, không bị âm thầm sai." | — |
| 05:45 | Lên slide / lời nói. | "**Giới hạn, nói thẳng:** (1) Đây là **mô phỏng**: HMI và trụ kịch bản nói OCPP theo spec, **chưa xác nhận bằng firmware Ruihua**. (2) Hành vi rớt mạng bám **một lần quan sát** (EXP-01, SAP), chưa lặp lại. (3) **Chưa có staging** — chạy trên máy cá nhân; Postgres nhúng bản 17 beta, CI dùng 16. (4) Chưa có xác thực người dùng, chưa tính tiền/billing, chưa có đường QR từ app. (5) Console **chỉ đọc + ngắt kết nối + dừng từ xa**, chưa có nút xử lý phiên `review`." | — |
| 06:15 | — | "Em xin nhận câu hỏi." | — |

**Câu dễ bị hỏi lúc này:** "Phiên review thì xử lý thế nào?" → "Chưa có giao diện xử lý; hiện chỉ đọc. Chính sách chọn số nào là việc phải chốt với Ruihua (xem `docs/WF-03-MAT-KET-NOI-VA-DOI-SOAT.md`)." Chỉ vào bảng "Câu hỏi Hội đồng" trong `docs/DEMO-REVIEW-2.md` mục 4.

---

## Kế hoạch B

| Sự cố | Làm gì (theo thứ tự) |
| --- | --- |
| HMI không nối / treo / bấm không ăn | 1. Terminal: Ctrl+C. 2. `npm run demo -w @powerme/csms -- --no-hmi`. 3. Cửa sổ khác: `node apps/csms/demo/scripted-station.mjs ds-03a --fast` (~26 s, hoặc không `--fast` ~95 s). **Đừng chạy HMI và trụ kịch bản cùng lúc** — cùng identity `RH24D1-00001`. Console vẫn lên `review`, `meterStop 510` vs chuỗi đo 1360, lệch 850 Wh (ds-03a `--fast`) |
| Console không lên (`http://localhost:3000/` lỗi) | `node apps/csms/demo/show.mjs` — bảng phiên và bản ghi đối soát trong DB. Kể lại bằng log `[csms]`: `tx 1: active --STATION_OFFLINE--> orphaned` … `→ review` |
| Postgres / demo không khởi động | `npm run demo:reset`; cổng bận → `--port-offset 10`. Chưa được → chiếu **ảnh dự phòng** trong `docs/demo/` theo thứ tự `console-1` … `console-5`, `hmi-2`, `hmi-3` và đọc kịch bản ở trên như thuyết minh ảnh |
| Máy hỏng hoàn toàn | Ảnh trong `docs/demo/` (xem từ GitHub trên điện thoại) + trace `apps/csms/test/fixtures/exp1-disconnect-81s.jsonl` + sequence diagram `docs/WF-03-MAT-KET-NOI-VA-DOI-SOAT.md` |
| Rớt mạng trụ không cần HMI | Nút **Ngắt kết nối trụ** trên console: đứt 30 s (HMI nối lại ở lần thử thứ nhất), vẫn ra `orphaned → active`; mọi bước (e) sau đó giống nhau |
| Trụ kịch bản "không giống thật" | Nói đúng: "đây là kịch bản cố định bám EXP-01, không phải firmware" |

## Ảnh dự phòng (trong `docs/demo/`)

| Ảnh | Chụp lúc | Dùng ở bước |
| --- | --- | --- |
| `console-1-trong-tru-online.png` | Vừa bật, chưa có phiên | (a) |
| `console-2-hai-sung-dang-sac.png` | Hai súng đang sạc | (b)–(c) |
| `hmi-2-hai-sung-dang-sac.png` | Hai súng đang sạc (HMI) | (b)–(c) |
| `hmi-3-rot-mang-60s.png` | Rớt mạng, hàng đợi 5 MeterValues | (d) |
| `console-3-tru-mat-ket-noi.png` | Trụ mất kết nối, 2 phiên `orphaned` | (d) |
| `console-4-sau-noi-lai-co-phat-lai.png` | Nối lại epoch 2, 9 `replay` | (e) |
| `console-5-phien-review-co-doi-soat.png` | Phiên #1 `review`, `conflict` 969 vs 125505 | (e) |
