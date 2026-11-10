# Nhật ký migration 0016 — `0016_bo-the-wallet-station-wallet.sql`

**Ngày:** 10/11/2026 · **Task:** T110 / BE-23 (WP2) · **Người chịu trách nhiệm:** Ngô Văn Minh Trí
**File:** `apps/csms/drizzle/0016_bo-the-wallet-station-wallet.sql` (áp lên DB đã có 0000 → 0015; một transaction `BEGIN … COMMIT`)
**Nguồn:** quyết định T109 (Ân, 09/11/2026): bỏ thẻ RFID ví và payment_mode `station_wallet`. Tài liệu nộp 09/11 (BM04 mục 5: "RFID wallet cards… out of scope") đã ghi đúng; migration này đưa DB và code về cùng phạm vi.

**Vì sao là 0016:** migration mới nhất trên `main` lúc làm là `0015_billing-refunds-wf02.sql` (T32, #103).

## 1. Thay đổi

| # | Đối tượng | Thay đổi | Use case |
|---|---|---|---|
| 0 | `session_status_history` | Phiên `station_wallet` **đã dừng** (`received_stopped_at` khác null): thêm một dòng `UNATTRIBUTED_CLOSED`, from = to = trạng thái hiện tại, actor `system`, note `legacy_station_wallet: đã trả tại trụ bằng thẻ ví (T110, migration 0016), không được tính tiền lại` | **Chặn trừ tiền hai lần** (mục 1a) |
| 1 | `sessions.payment_mode` | Dòng `station_wallet` → `unattributed`, `updated_at = now()` | Phiên cũ của thẻ ví: trụ đã tự trừ tiền trên thẻ, CSMS không thu. `unattributed` cùng nghĩa "không thu qua CSMS" |
| 2 | `rfid_cards.card_kind` | Dòng `wallet` → `online`, `updated_at = now()`; giữ `driver_id`, `status` | Thẻ ví cũ chưa gắn tài xế (như `DEMO-WALLET-0001`): `Authorize` trả `Invalid` theo BE-19 (#93, BR-P23). Thẻ đã gắn tài xế thì qua đúng kiểm Charging Credit như mọi thẻ online |
| 3 | enum `payment_mode` | Tạo lại: `csms_billed`, `unattributed` | Ai thu tiền chỉ còn hai trường hợp (ADR-0012 sau T109) |
| 4 | enum `rfid_card_kind` | Tạo lại: `online`, `free_vend` | Thẻ chỉ còn hai loại |
| 5 | COMMENT | `sessions.payment_mode`, bảng `rfid_cards` | Nói đúng hai giá trị còn lại |

**Không đổi:** `session_origin` (`app_qr` · `rfid` · `hmi_password` · `free_vend`). `rfid_wallet` chỉ có ở ADR-0009 và BR-P08 bản cũ, chưa bao giờ có trong DB: từ 0000 mọi lần quẹt thẻ là `rfid` (T12/T13). Không có gì để bỏ ở `origin`.

**Không mất dữ liệu:** không xoá dòng nào. Phiên giữ `origin`, `id_tag`, `rfid_card_id`, `driver_id`, meter, trạng thái, `orphaned_at`, bản ghi đối soát và lịch sử trạng thái. Từ `id_tag` / `rfid_card_id` vẫn truy được thẻ cũ.

## 1a. Rủi ro trừ tiền hai lần và cách chặn

**Rủi ro.** BE-24 / T102 (#109, `unattributed-session.service.ts`) cho operator gán một phiên `unattributed` đã dừng cho tài xế: đổi thành `csms_billed` rồi trừ Charging Credit. Phiên của thẻ ví bị chặn bằng `wallet_card_not_billable`, nhưng chặn đó dựa trên `rfid_cards.card_kind <> 'online'`. Sau 0016, phiên `station_wallet` cũ (đã trả tiền tại trụ) là `unattributed` và thẻ của nó là `online`. Nếu không làm gì, phiên này hiện trong hàng đợi console và gán được, tức là tài xế bị **trừ tiền lần hai**.

**Cách chặn.** BE-24 coi phiên có dòng `session_status_history` event `UNATTRIBUTED_ASSIGNED` / `UNATTRIBUTED_CLOSED` là đã quyết. Vì vậy 0016 ghi sẵn quyết định "đã đóng" cho mọi phiên `station_wallet` đã dừng, đúng các cột mà `UnattributedSessionService.close()` ghi:

- from = to = trạng thái hiện tại (không phải chuyển STM-1);
- event `UNATTRIBUTED_CLOSED`;
- actor `system` thay cho users.id của operator (`varchar(50)`, mặc định của cột cũng là `system`);
- note `legacy_station_wallet: …`. Phần trước dấu `:` là mã lý do, giống `close()` đọc lại.

Hệ quả:
- `assign` trả 409 `already_resolved`, không giao dịch credit nào;
- `close` trả `already_resolved = true` với reason `legacy_station_wallet`;
- `listPending` không còn liệt kê phiên này.

Dòng được chèn **trước** khi đổi `payment_mode`, trong cùng transaction. Phiên đã có quyết định BE-24 thì bỏ qua (`NOT EXISTS`).

**Giới hạn: phiên `station_wallet` CHƯA dừng không được ghi dòng.** BE-24 chỉ quyết định phiên đã dừng. Ghi một dòng lên phiên `active` / `orphaned` sẽ chen vào lịch sử trước khi phiên kết thúc. Với phiên `orphaned`, mốc hard cap (`orphanedSinceSql`) chỉ đọc `to_status = 'orphaned'`, nên một dòng `orphaned → orphaned` có `occurred_at = now()` sẽ đẩy mốc đó lên. Khi phiên như vậy dừng, nó vào hàng đợi như phiên unattributed thường, và **operator phải đóng tay, không gán**. NOTICE thứ hai của 0016 in số phiên này. **DB demo: 0** (mục 3). Trên staging, kiểm NOTICE khi deploy; nếu khác 0 thì đóng tay qua console sau khi phiên dừng.

**Không ghi thêm gì khác:** từ `id_tag` / `rfid_card_id` vẫn lần ra thẻ cũ; `updated_at` của dòng bị đổi và NOTICE là dấu vết còn lại.

**Mã chết:** nhánh `wallet_card_not_billable` trong `unattributed-session.service.ts` (#109) không còn đường tới, vì `card_kind` chỉ còn `online` / `free_vend`. PR này để nguyên vì là code của BE-24; test BE-24 tương ứng đổi thành khẳng định DB từ chối thẻ `wallet`.

**Cách làm:** PostgreSQL không có `DROP VALUE` cho enum, nên làm như 0009: đổi tên kiểu cũ (`*_truoc_0016`), tạo kiểu mới, `ALTER COLUMN … TYPE … USING col::text::kiểu_mới`, bỏ kiểu cũ. UPDATE chạy trước khi đổi kiểu, nên cast không gặp giá trị lạ.

## 2. Phụ thuộc đã kiểm

Truy vấn `pg_depend` trên DB demo ở trạng thái 0015: mỗi kiểu chỉ có một cột dùng (`sessions.payment_mode`, `rfid_cards.card_kind`) và kiểu mảng tự sinh. Không có DEFAULT, CHECK, index, view hay hàm nào nhắc tới hai cột hoặc giá trị cũ (`pg_constraint`, `pg_indexes`, `pg_proc.prosrc`, `pg_views` đều rỗng). Test `migration-0016` kiểm lại điều này trên DB sạch.

## 3. Chạy thật

**DB demo ở trạng thái `main` (0015)** (chạy lại sau khi rebase lên `main` có #108, #109): dựng bằng `scripts/migrate.mjs` + `demo/seed.sql` của `main`, CSMS bản `main` chạy cổng riêng, `demo/scripted-station.mjs` sinh 4 phiên: `ds-01a --tag DEMO-WALLET-0001` (reconciled), `ds-01a` thẻ `DEMO-CARD-0001` (súng 2), `ds-03c` thẻ lạ, `ds-03a --tag DEMO-WALLET-0001` (review, có bản ghi replay / conflict).

| | Trước 0016 | Sau 0016 |
|---|---|---|
| `payment_mode` | csms_billed 1 · station_wallet 2 · unattributed 1 | csms_billed 1 · unattributed 3 |
| `card_kind` | online 2 · wallet 1 | online 3 |
| Dòng bị đổi | — | **2 phiên, 1 thẻ** (`DEMO-WALLET-0001`) |
| Dòng `UNATTRIBUTED_CLOSED` chèn | — | **2** (phiên #1 `reconciled`, #4 `review`; cả hai đã dừng) |
| Phiên `station_wallet` chưa dừng | 0 | — (không phải đóng tay) |
| `session_status_history` | 12 | 14 |
| `reconciliation_records` / `meter_values` | 6 / 75 | 6 / 75 |

Sau đó: seed mới chạy hai lần trên DB đó (idempotent, thêm tài xế mẫu 2 và `DEMO-CARD-0002`); CSMS bản mới: `ds-01a --tag DEMO-CARD-0002` → phiên `rfid · csms_billed · reconciled`, tài xế 2; `ds-01a --tag DEMO-WALLET-0001` → `Authorize` = `Invalid`, không có phiên.

**DB sạch (0000 → 0016):** áp được; test `migration-0016` phần 2.

## 4. Số liệu (đếm bằng truy vấn, cùng cách đếm ở `THIET-KE-CSDL-VAT-LY.md`)

| | 0015 | 0016 |
|---|---|---|
| Bảng | 44 | 44 |
| Enum (giá trị) | 32 (126) | 32 (**124**) |
| Index (partial) | 163 (16) | 163 (16) |
| CHECK | 66 | 66 |
| FK | 84 | 84 |
| Cột | 442 | 442 |

Số 0015 tái hiện đúng số đã ghi ở `THIET-KE-CSDL-VAT-LY.md`.

**Đối chiếu SQL ↔ Drizzle:** `drizzle-kit export --sql` nạp vào DB nháp (tạo trước 5 sequence nghiệp vụ), so với DB sạch đã áp 0000 → 0016: `pg_enum` 32/32 enum khớp cả thứ tự giá trị; cột của `sessions` và `rfid_cards` 36/36; ràng buộc của hai bảng 15/15 (so theo định nghĩa).

## 5. Code và dữ liệu mẫu đi cùng

- `src/db/schema/enums.ts`: hai enum mới.
- `sessions.service.ts` `classifyIdTag`: bỏ nhánh `wallet → station_wallet`; thẻ active chỉ `csms_billed` khi `online` và thu được, còn lại `unattributed`. `authorize`: chú thích mới (logic không đổi — thẻ `online` luôn qua `evaluateOnlineCard`).
- `demo/seed.sql`: bỏ `DEMO-WALLET-0001`; thêm tài xế mẫu 2 (`driver2.demo@powerme.test`, Charging Credit 500.000 VND, top-up + dòng sổ cái) và thẻ `DEMO-CARD-0002` cho súng B.
- HMI (`simulator/d1-hmi`): thẻ `wallet` → `valid2` = `DEMO-CARD-0002`; `smoke.mjs` dùng thẻ đó.
- `docs/DEMO-REVIEW-2.md`: các bước dùng thẻ ví đổi sang `DEMO-CARD-0002`; kết quả và ảnh chụp ngày Review 2 giữ nguyên, có ghi chú "trước T110".

## 6. Không làm (có chủ ý)

- **App Flutter** (`apps/mobile`, `PaymentMode.stationWallet`, `ChargingScript.stationWallet`): của Sơn.
- **ADR-0009, ADR-0012, SRS BR-P08 bản local, các tài liệu WP2 cũ** còn nhắc `station_wallet` / `rfid_wallet`: việc tài liệu của T98.
- **Ảnh** `diagrams/report4/class/CD-3/CD-3.png`: `.puml` đã sửa, cần render lại (máy không có PlantUML). Ảnh ERD vật lý không hiện giá trị enum nên không cần render lại.
