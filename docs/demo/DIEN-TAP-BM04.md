# Diễn tập 10 kịch bản demo BM04 (DS-01 … DS-10)

Cách chạy từng kịch bản đã cam kết trong BM04 bằng công cụ có trong repo, và trạng thái đã kiểm tới ngày 14/11/2026. Dùng để tập trước T83 (demo end-to-end, 22/11) và làm kế hoạch B khi app hoặc dashboard hỏng ở phòng demo. Tên kịch bản ở đây theo **BM04**; các tên `ds-01a`, `ds-03a`… trong `scripted-station.mjs` là tên cũ của Review 2 (`docs/DEMO-REVIEW-2.md`).

## Trạng thái

| Kịch bản | Người trình bày | Công cụ diễn tập | Đã kiểm ở đâu |
|---|---|---|---|
| **DS-01** sạc từ app tới hạn mức 10 kWh | Sơn | `scripted-station.mjs app` + `rehearse-app.mjs ds-01` | Local 14/11: 11/11 kiểm tra đạt. **Chưa chạy trên staging**; app Flutter chưa nối màn sạc |
| **DS-02** số dư 30.000 → từ chối, gợi ý nạp | Sơn | `rehearse-app.mjs ds-02` | Local 14/11: 4/4 đạt. Chưa chạy trên staging |
| **DS-03** nạp 200.000, đổi 500 điểm, trả VNPay | Khang | — | **Chưa diễn tập được**: staging chưa có khoá VNPay (chờ T32 Phần 8) |
| **DS-04** huỷ ở VNPay, gửi lại IPN | Khang | — | Như DS-03 |
| **DS-05** đứt 2 phút, nối lại, phát bù | Trí | `scripted-station.mjs ds-03d --offline-s 150` | Staging 09/11: đạt |
| **DS-06** phát lại `meterStop` cũ → `review` | Trí | `scripted-station.mjs ds-03a` | Staging 09/11: đạt; RQ1 13/11: 30/30 trên staging |
| **DS-07** súng lỗi → xác nhận → reset từ xa → hết lỗi | Nghĩa | `scripted-station.mjs fault --reset accept` + console / dashboard | Local 14/11: đạt (`raised → acknowledged → resetting → resolved`). Chưa chạy trên staging |
| **DS-08** reset bị từ chối → cảnh báo vẫn mở | Nghĩa | `scripted-station.mjs fault --reset reject` | Local 14/11: đạt (sự cố giữ `acknowledged`, lệnh `rejected`). Chưa chạy trên staging |
| **DS-09** onboard `SIM-0005` | Ân | `onboard-sim.mjs` | Staging: đạt. `SIM-0005` đã `in_service`; cần serial mới hoặc `./seed.sh --reset` trước demo |
| **DS-10** sai mật khẩu trụ → 401 | Ân | `scripted-station.mjs ds-10` | Staging: đạt |

## Chuẩn bị (local)

```bash
cd apps/csms
# Driver API cần JWT; mật khẩu chỉ để trong biến môi trường của phiên shell.
export DRIVER_API_JWT_SECRET_BASE64="$(openssl rand -base64 48)" \
       DRIVER_API_JWT_ISSUER=powerme-local DRIVER_API_JWT_AUDIENCE=powerme-driver-local
npm run demo:reset -- --no-hmi          # Postgres nhúng + CSMS (:9000) + console (:3000)

# Cửa sổ khác: nạp 3 tài xế mẫu, 9 trạm, đặt mật khẩu trụ và mật khẩu tài xế
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
