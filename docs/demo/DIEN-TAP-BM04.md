# Diễn tập 10 kịch bản demo BM04 (DS-01 … DS-10)

Cách chạy từng kịch bản đã cam kết trong BM04 bằng công cụ có trong repo, và trạng thái đã kiểm tới ngày 14/11/2026. Dùng để tập trước T83 (demo end-to-end, 22/11) và làm kế hoạch B khi app hoặc dashboard hỏng ở phòng demo. Tên kịch bản ở đây theo **BM04**; các tên `ds-01a`, `ds-03a`… trong `scripted-station.mjs` là tên cũ của Review 2 (`docs/DEMO-REVIEW-2.md`).

## Trạng thái

| Kịch bản | Người trình bày | Công cụ diễn tập | Đã kiểm ở đâu |
|---|---|---|---|
| **DS-01** sạc từ app tới hạn mức 10 kWh | Sơn | `scripted-station.mjs app` + `rehearse-app.mjs ds-01` | Local 14/11: 11/11 kiểm tra đạt. **Chưa chạy trên staging**; app Flutter chưa nối màn sạc |
| **DS-02** số dư 30.000 → từ chối, gợi ý nạp | Sơn | `rehearse-app.mjs ds-02` | Local 14/11: 4/4 đạt. Chưa chạy trên staging |
| **DS-03** nạp 200.000, đổi 500 điểm, trả VNPay | Khang | `rehearse-topup.mjs ds-03` | Local 17/11 với VNPay giả (`--simulate-vnpay`): 9/9 kiểm tra đạt (giảm 5.000 ₫, trả 195.000 ₫, số dư 100.000 → 300.000, điểm 600 → 100). **Chưa chạy với sandbox thật trên staging** (chưa đặt mã VNPay); hoá đơn điện tử (Phần 7) chưa có nên chưa kiểm |
| **DS-04** huỷ ở VNPay, gửi lại IPN | Khang | `rehearse-topup.mjs ds-04` | Local 17/11 với VNPay giả: 8/8 đạt (`failed`, IPN lặp → RspCode 02, số dư không đổi, tạo được top-up mới). Chưa chạy với sandbox thật |
| **DS-05** đứt 2 phút, nối lại, phát bù | Trí | `scripted-station.mjs ds-03d --offline-s 150` | Staging 09/11: đạt |
| **DS-06** phát lại `meterStop` cũ → `review` | Trí | `scripted-station.mjs ds-03a` | Staging 09/11: đạt; RQ1 13/11: 30/30 trên staging |
| **DS-07** súng lỗi → xác nhận → reset từ xa → hết lỗi | Nghĩa | `scripted-station.mjs fault --reset accept` + console / dashboard | Local 14/11: đạt (`raised → acknowledged → resetting → resolved`). Chưa chạy trên staging |
| **DS-08** reset bị từ chối → cảnh báo vẫn mở | Nghĩa | `scripted-station.mjs fault --reset reject` | Local 14/11: đạt (sự cố giữ `acknowledged`, lệnh `rejected`). Chưa chạy trên staging |
| **DS-09** onboard một serial đã đăng ký | Ân | `onboard-sim.mjs --serial <serial mới> --register` | Staging 16/11 (`review-20`): đạt với `SIM-0006` (Admin đăng ký → 201, onboard → 201 `awaiting_connection`, Boot → `in_service`, 2 súng Available). `SIM-0005` và `SIM-0006` đã `in_service`: mỗi lần tập lại dùng một serial mới, hoặc `./seed.sh --reset` |
| **DS-10** sai mật khẩu trụ → 401; serial chưa đăng ký → 409 | Ân | cùng lệnh `onboard-sim.mjs` | Staging 16/11: đạt (`SIM-9999` → 409 `serial_not_registered`; `SIM-0006` sai mật khẩu → 401) |

## Chuẩn bị (local)

```bash
cd apps/csms
# Driver API cần JWT; mật khẩu chỉ để trong biến môi trường của phiên shell.
export DRIVER_API_JWT_SECRET_BASE64="$(openssl rand -base64 48)" \
       DRIVER_API_JWT_ISSUER=powerme-local DRIVER_API_JWT_AUDIENCE=powerme-driver-local
npm run demo:reset -- --no-hmi          # Postgres nhúng + CSMS (:9000) + console (:3000)

# Cửa sổ khác: nạp 3 tài xế mẫu, 11 trạm, đặt mật khẩu trụ và mật khẩu tài xế
export DATABASE_URL=<dòng "Postgres" mà lệnh trên in ra>
export DEMO_CHARGE_POINT_PASSWORD=<≥ 16 ký tự> DEMO_DRIVER_PASSWORD=<12–128 ký tự>
node scripts/seed-demo.mjs
```

Sau `seed-demo.mjs`, trụ `RH24D1-00001` có mật khẩu: mọi lệnh `scripted-station.mjs` bên dưới cần `CP_PASSWORD=$DEMO_CHARGE_POINT_PASSWORD`.

## DS-01 và DS-02 (không cần app)

```bash
# Trụ đứng chờ lệnh từ CSMS. 2500 Wh mỗi nhịp 3 s → chạm 10 kWh sau 4 nhịp.
CP_PASSWORD=$DEMO_CHARGE_POINT_PASSWORD node demo/scripted-station.mjs app \
  --interval-s 3 --tick-wh 2500 --hold-s 600

# Cửa sổ khác: đóng vai app
node demo/rehearse-app.mjs ds-01      # app.ds01, 200.000 VND, hạn mức 10 kWh
node demo/rehearse-app.mjs ds-02      # app.ds02, 30.000 VND
```

`rehearse-app.mjs ds-01` đăng nhập, lấy xe mặc định, quét mã `PM-D1-HCM-0001` súng 1, `POST /charges` với `energy_limit_wh = 10000`, chờ phiên, chờ quyết toán, rồi kiểm: phiên `reconciled`, dừng ở hạn mức, có bảng kê, điểm = 1 điểm / 1.000 VND, số dư giảm đúng bằng tiền trên bảng kê, không còn tiền bị giữ, đúng một dòng trừ tiền. Kết quả local 14/11: 10.000 Wh, 55.000 VND, +55 điểm, số dư 200.000 → 145.000.

`ds-02` kiểm: `outcome = topuprequired`, không có phiên, số dư không đổi và không giữ tiền. Script không kiểm phía trụ; ở lần chạy local, log của trụ không có `RemoteStartTransaction` nào cho lần bấm này.

Bước "get suggestion" của DS-01 (`GET /stations?sort=smart`) **không** nằm trong script: nó cần toạ độ và, cho gợi ý dọc đường, khoá Vietmap.

`ds-01` trừ tiền thật của tài xế mẫu trong DB đang trỏ tới. Chạy lại lần hai thì số dư bắt đầu từ 145.000.

## F-03 và RQ2 — gợi ý trạm với Vietmap thật

Nghĩa phụ trách F-03. Nhãn trong `driver-smart.integration.test.ts` là ánh xạ tạm chờ đối chiếu
các dòng TC trong BM04. `TC-F03-01` kiểm thứ tự theo tầm pin và tổng thời gian,
`TC-F03-02` kiểm fallback về brief, `TC-F03-03` kiểm giới hạn nhóm gọi Route và số lệnh song song.
Các regression này thay phản hồi Route bằng fixture. Bằng chứng F-03 cần chạy với Vietmap thật.

NFR-RES-01 yêu cầu p95 ≤ 2 giây trên staging với 50 trạm giả lập. Preflight đã thấy 10 trạm;
chưa có số đo hợp lệ cho cấu hình 50 trạm. Giữ `RANKING_DEADLINE_MS=4000` cho đến khi có
kết quả hợp lệ. Nếu vượt 2 giây, giảm deadline rồi đo lại cả p95 và tỷ lệ fallback.

Batch local ngày 16/11/2026 với 50 trạm online, tương thích CCS2, ở 50 tọa độ đường bộ:

| Mẫu | Số request | p50 | p95 | Fallback về brief |
| --- | ---: | ---: | ---: | ---: |
| Pilot cache lạnh | 1 | 132,23 ms | 132,23 ms | 0/1 |
| Batch local | 20 | 64,45 ms | 176,86 ms | 0/20 |

Mỗi mẫu có 6 tuyến Vietmap. Batch có 19 mẫu dùng cache và một mẫu làm mới cache mất 189 ms.
Pilot và batch gọi Vietmap Route thật 12 lượt, đều trả HTTP 200. Kết quả local dùng để kiểm tra
fixture và runner. Nghiệm thu p95 vẫn cần batch staging với 50 trạm.

Smoke staging trên emulator Pixel 6: tile tải được, tuyến đến Bến Thành hiển thị các đoạn vàng
và đỏ, xem trước từng chặng hiện mũi tên và nút mở bản đồ mở được Google Maps. Camera QR lên
hình. Chưa kiểm giải mã mã QR của trụ. Một lần chọn địa chỉ báo lỗi, nên lượt smoke tuyến đường
dùng vị trí GPS mô phỏng. Chưa chạy build iOS.

Chẩn đoán staging ngày 16/11/2026, ngoài bộ mẫu NFR-RES-01:

- Một lượt `GET /stations?sort=smart` với 10 trạm mất 1037 ms, `ranking_source=vietmap_route`
  và có 1/10 trạm nhận `road_estimate`. Trạm 78 trả 19621.3 m, 1819 s, lúc
  `2026-11-16T13:23:43.05Z`. Chín trạm còn lại không có ước tính đường bộ.
- Lượt riêng `GET /stations/78/route` trả 2622.8 m, 367 s, 7 chỉ dẫn và 9 đoạn giao thông
  có các mức `low`, `moderate`, `heavy`, lúc `2026-11-16T13:25:32.87Z`.
  Trường `traffic_quality` trả `unknown`.

1. Chuẩn bị bộ 50 trạm ở vị trí thực, duy nhất, trong cùng bán kính thử và tương thích với xe
   tài xế. Kiểm các điểm đặt truy cập được bằng đường bộ và có ít nhất 6 trạm đủ điều kiện gọi
   Route. Mở tunnel staging theo [DEV-ACCESS](../../infra/staging/DEV-ACCESS.md).
2. Đặt biến cho phiên shell. Nạp access token của tài xế test vào `NFR_DRIVER_ACCESS_TOKEN` từ
   phiên đăng nhập hợp lệ, giữ ngoài repo và đầu ra. Ghi lại quota Route v4 **còn lại** của key
   staging từ Console trước từng batch.

   | Biến | Giá trị |
   | --- | --- |
   | `NFR_DRIVER_API_URL` | `http://127.0.0.1:3000/api/driver/v1` qua tunnel |
   | `NFR_VEHICLE_ID` | ID xe tài xế sở hữu |
   | `NFR_LATITUDE`, `NFR_LONGITUDE` | Điểm đi công khai dùng cho thí nghiệm |
   | `NFR_RADIUS_KM`, `NFR_SOC_PERCENT` | Bán kính cố định cho cả preflight và mẫu đo, SoC từ 0 đến dưới 80 |
   | `NFR_REQUESTS`, `NFR_ROUTE_REMAINING` | Số mẫu batch và số lượt Route còn lại, ít nhất 6 × số mẫu |
   | `NFR_INTERVAL_MS` | Từ 12500 ms, để tối đa 5 request smart mỗi phút từ runner; trên 120 giây nếu đo cold với cùng điểm đi |

3. Từ thư mục gốc repo, chạy `node apps/csms/lab/nfr-res-01/run.mjs` và lưu JSONL ngoài repo.
   Script kiểm tra 50 trạm bằng `sort=name` trước khi gọi `sort=smart`, đo tuần tự và dừng
   khi mẫu lỗi. Mỗi dòng sample ghi HTTP status, latency, `ranking_source` và danh sách trạm
   theo thứ tự trả về. `road_estimate` gồm `distance_m`, `duration_s`, `computed_at` khi có
   tuyến; dùng `null` khi thiếu. Dùng reach, thời gian lái/chờ/sạc, tổng thời gian và dữ liệu
   ùn tắc khi có để đối chiếu [quy tắc xếp hạng API](../api/DRIVER-API-HOP-DONG.md#16-t96--xếp-hạng-gợi-ý-theo-đường-bộ-vietmap).
4. Ghi batch, cold/warm, `n`, p50, p95 (nearest rank) và tỷ lệ `ranking_source=brief` trong các
   phản hồi hợp lệ vào PR. Báo số mẫu có đủ 6 kết quả Route và dùng `computed_at` để kiểm độ tuổi
   cache. Runner yêu cầu đủ mẫu và ít nhất một phản hồi có 6 tuyến. HTTP lỗi hoặc thiếu dữ liệu
   đánh dấu batch không hợp lệ. Canh thời hạn access token khi chia batch.

RQ2 cần 200 lượt cho mỗi nhóm yên tĩnh, cao điểm và có trạm lỗi (600 lượt). So sánh với trạm
tương thích gần nhất ở cùng điểm đi và điều kiện, báo cả thời gian tới lúc bắt đầu sạc và tới
mức pin đích. Ghi nguồn xếp hạng và ước tính đường bộ mỗi trạm như F-03. Ngân sách dự kiến
khoảng 3600 lượt Route cho nhánh gợi ý, chưa tính lượt Route riêng cần cho đối chứng hoặc smoke.
Quota Trial đã xem trên Console là 200/phút và 1500/ngày. Đối chiếu quota còn lại trước khi chạy,
chia theo kỳ quota hoặc dùng gói đủ hạn mức. Runner chỉ thực hiện batch đo API; điều phối nhóm
kịch bản và thu kết quả đối chứng là phần của lần chạy RQ2.

## DS-07 và DS-08 (không cần dashboard)

```bash
# DS-07: súng 1 báo Faulted (InternalError), chờ Reset, chấp nhận, khởi động lại, Available
CP_PASSWORD=$DEMO_CHARGE_POINT_PASSWORD node demo/scripted-station.mjs fault --reset accept

# Cửa sổ khác: đóng vai Operator trên console (hoặc bấm nút trên http://127.0.0.1:3000)
curl -s 'http://127.0.0.1:3000/api/admin/faults?limit=5'                    # lấy id sự cố
curl -s -X POST http://127.0.0.1:3000/api/admin/faults/<id>/acknowledge
curl -s -X POST 'http://127.0.0.1:3000/api/admin/faults/<id>/reset?type=Soft'

# DS-08: như trên nhưng trụ từ chối Reset
CP_PASSWORD=$DEMO_CHARGE_POINT_PASSWORD node demo/scripted-station.mjs fault --reset reject --hold-s 120
```

Kết quả local 14/11: DS-07 `reset_status = Accepted`, sự cố `resolved` sau khi trụ Boot lại và báo `Available`; DS-08 `reset_status = Rejected`, sự cố giữ `acknowledged`, `resolved_at` trống.

Mã lỗi mặc định là `InternalError` vì bảng hướng dẫn của CSMS gợi ý "Reset từ xa" cho mã này. `--error-code GroundFailure` cho ra gợi ý ngược lại ("KHÔNG Reset từ xa nhiều lần"), dùng khi muốn trình bày lý do không reset.

Sau DS-08 súng 1 còn sự cố mở nên `GET /stations` ẩn súng đó: đóng sự cố (console) hoặc chạy DS-07 trước khi chạy DS-01.

## Chạy trên staging

Cùng lệnh, đổi địa chỉ: trụ dùng `--url wss://powerme-staging.japaneast.cloudapp.azure.com/ocpp`; `rehearse-app.mjs` và `curl` trỏ `--api http://127.0.0.1:3000` qua SSH tunnel (`infra/staging/DEV-ACCESS.md`). Mật khẩu trụ và mật khẩu tài xế lấy từ `.env` trên VM, không chép vào repo hay chat.

Chưa chạy trên staging vì ba việc làm đổi dữ liệu dùng chung: DS-01 trừ tiền `app.ds01`, DS-08 để lại sự cố mở làm ẩn súng 1 của `RH24D1-00001`, và trụ kịch bản chiếm identity `RH24D1-00001` (không chạy cùng lúc với trụ của người khác). Chạy khi không ai đang dùng staging, rồi `./seed.sh --reset` trước buổi demo.

## Giới hạn

- Trụ kịch bản không phải firmware Ruihua và không thay SAP simulator; nó chỉ trả lời đúng giao thức cho `RemoteStartTransaction`, `RemoteStopTransaction`, `Reset`, `TriggerMessage`.
- `rehearse-app.mjs` kiểm backend, không kiểm app Flutter. DS-01 và DS-02 chỉ được coi là sẵn cho demo khi app của Sơn chạy được cùng luồng.
- DS-07 và DS-08 đã kiểm qua console (`/api/admin/faults`, chưa có xác thực); chưa kiểm qua dashboard của Nghĩa (`/api/operator/v1`).

## DS-09 và DS-10 trên staging

Onboard chỉ làm được một lần cho mỗi trụ, nên trên staging mỗi lần tập dùng một serial mới. `--register` thêm serial đó vào sổ đăng ký thiết bị qua `POST /api/admin/charge-points` (bước của Admin, UC-ADM-03) rồi chạy đủ các bước.

```bash
# Tunnel tới console của staging (cửa sổ riêng)
ssh -N -L 3041:127.0.0.1:3000 deploy@<FQDN>

node apps/csms/demo/onboard-sim.mjs --console http://127.0.0.1:3041 \
  --url wss://<FQDN>/ocpp --site-id <id của HCM-DEMO-01> --serial SIM-0007 --register
```

Cần `CONSOLE_ACTOR_ADMIN_ID` và `CONSOLE_ACTOR_STAFF_ID` đã đặt trên VM (thiếu thì console trả 503). Trụ vừa onboard nằm ở trạm `HCM-DEMO-01` và mất kết nối khi script dừng. Bước sai mật khẩu ghi một lần 401 vào bộ đếm đăng nhập theo IP của máy chạy script (ngưỡng khoá: 20 lần / 60 s).

## DS-03 và DS-04 (không cần màn nạp tiền của app)

`rehearse-topup.mjs` đóng vai app: đăng nhập `app.ds03@powerme.test` (600 điểm), xin báo giá đổi điểm, tạo top-up, rồi chờ kết quả và kiểm số dư, điểm, số dòng sổ cái.

**Local, VNPay giả.** CSMS chạy với một mã merchant và secret GIẢ; script tự ký và gửi IPN như VNPay.

```bash
cd apps/csms
export VNPAY_TMN_CODE=LOCALTST VNPAY_HASH_SECRET=<chuỗi giả bất kỳ, chỉ dùng ở máy này>
# + ba biến DRIVER_API_JWT_* như mục "Chuẩn bị (local)", rồi npm run demo:reset -- --no-hmi và seed-demo.mjs
node demo/rehearse-topup.mjs ds-03 --simulate-vnpay     # nạp 200.000, đổi 500 điểm, VNPay báo thành công
node demo/rehearse-topup.mjs ds-04 --simulate-vnpay     # huỷ ở VNPay, gửi lại đúng IPN đó, rồi một IPN thành công tới muộn
```

`ds-04` kiểm thêm một ca ngoài đề: IPN thành công tới sau khi top-up đã `failed` không cộng tiền (ghi thành khoản trễ).

**Staging, sandbox thật** (sau khi mã VNPay đã đặt trên VM và hai đường `/billing/vnpay/*` đã mở): bỏ `--simulate-vnpay`. Script in `payment_url`; người trình bày mở trong trình duyệt, trả tiền bằng thẻ thử của sandbox (DS-03) hoặc bấm huỷ (DS-04); script chờ tới khi VNPay báo về (tối đa `--timeout-s`, mặc định 900 s). Bước "gửi lại IPN" của DS-04 không làm được ở chế độ này vì không có secret để ký; phải trình bày bằng bản local hoặc bằng test tự động (`test/billing-ipn.integration.test.ts`).

`--simulate-vnpay` từ chối chạy khi `--api` không phải `http://127.0.0.1`. Không bao giờ đưa secret sandbox thật vào biến môi trường của máy dev để "giả" IPN trên staging: làm vậy là tự tạo thanh toán giả trong dữ liệu dùng chung.

`ds-03` cộng tiền và trừ điểm thật trong DB đang trỏ tới; tài xế mẫu chỉ có 600 điểm nên chạy lại lần hai cần `seed --reset`.
