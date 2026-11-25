# T148 — chứng cứ UI hiện tại, 25/11/2026

Hai ảnh widget fixture/offscreen 390×844, text 100%, tiếng Việt, dùng assets hiện
có và Roboto/MaterialIcons từ Flutter SDK cache. Không phải native device,
reader/hardware hoặc staging. Không thêm font/dependency vào sản phẩm.

- [Pending](390-1x-vi-pending.png): tạm tính chưa hỗ trợ, chờ quyết toán, Refresh.
- [Posted](390-1x-vi-posted.png): API fixture trả statement 6.000 đ và 6 điểm;
  không có app Start/Stop RFID hay client tính tiền/điểm. Dữ liệu hoàn toàn synthetic.

Một capture test tạo cả hai ảnh, **1/1 pass**, exit 0. Đã mở và kiểm hai PNG thực
sau khi tải SDK fonts. Các bộ regression trên base 81b7433f: 644 backend và 93 Flutter
pass; không cộng capture thành một bộ regression mới. Rebase lên main 2272b13 giữ
nguyên mobile source/evidence; kiểm tra targeted mới được ghi riêng trong
[T148](../../../../../docs/tasks/t148-rfid-settlement.md).

320px/200% đã kiểm qua focused widget cases. Bottom navigation chồng chữ là giới
hạn T146 đã biết, ngoài phạm vi; hai PNG này chỉ chứng minh profile 390px/100%.

Tái hiện từ `apps/mobile`, sau khi dùng Flutter SDK/dependency cache của repo:

```powershell
$sdkRoot = Split-Path -Parent (Split-Path -Parent (Get-Command flutter).Source)
$fonts = Join-Path $sdkRoot 'bin/cache/artifacts/material_fonts'
$captureDir = (Resolve-Path 'docs/evidence/t148-20261125').Path
flutter test --no-pub "--dart-define=POWERME_PREVIEW_FONTS=$fonts" "--dart-define=T148_CAPTURE_DIR=$captureDir" test/t148_rfid_settlement_test.dart --plain-name 'RFID pending polls read-only then loads its posted statement once narrow=false' --reporter expanded
```

Chỉ hai PNG đã tải font là chứng cứ publication. [OCPP observed extract](../../../../../docs/tasks/evidence/t148-20261125-ocpp.md)
được tạo riêng từ PostgreSQL test mới trước khi dừng, không lấy dữ liệu người dùng.
