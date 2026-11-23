# @powerme/mobile — App tài xế PowerMe (WP3)

## Phone login — BE-30, 21/11

Phone + password is implemented in the existing login form alongside email. Registration keeps required email and adds an optional phone; blank phone is omitted. The app preserves raw nonblank phone/password values, checks BE-30's original 32-character phone limit and accepted local/international shapes, and leaves normalization to the backend. Duplicate phone, locked account and rate-limit errors have helpful messages. Existing session guards, shared refresh and profile bootstrap are retained. No Google/OTP, dependency/config/native/backend change or staging write.

Accounts without a stored phone still use email; this slice does not infer a phone association. See [API notes](docs/t96-driver-api.md#phone-login--be-30-2111), [trace](docs/screens.md#phone-login--be-30-2111) and [architecture/research](docs/architecture.md#phone-login--be-30-2111). Evidence directory: `E:/Project/PowerMe/.review/phone-auth`. The earlier 229-test/build claims below belong to T145, not this slice.

Verified on installed Flutter 3.44.2 / Dart 3.12.2, existing cache, no pub get/install:

- `dart format --output=none --set-exit-if-changed` over the auth directory, session and four touched test files: **12 files, 0 changed** (`format-final.log`). `flutter analyze --no-pub`: **No issues found**, 10.3s (`analyze-final.log`).
- Focused auth/profile/API/vehicle regression: **80/80 pass**, 33s (`focused-confirmed.log`), including **26 new transport/domain/controller tests + 8 new widget cases**. New coverage checks exclusive identifier payloads, optional-phone omission/raw values, 32-character boundary before trim, duplicate-phone 400/409, locked/429, no principal before valid `/me`, shared refresh, duplicate/keyboard submits, cancellation and A→logout→B. Existing email/profile/vehicle regressions remain.
- One full regression after focused checks: `flutter test --no-pub --concurrency=1 --reporter expanded`: **267/267 pass**, 03:09 (`full-tests.log`). No further suite/build repetition.
- Bounded visual check: first batch + one confirmation, **24 final PNGs** under `E:/Project/PowerMe/.review/phone-auth/captures-confirmed/{390-1x,320-2x}-{vietnamese,english}/`, six frames per combination. Final contact sheet `contact-sheet-confirmed.jpg`; final widget/capture assertions are part of the 80-test focused log. The first batch exposed a stale phone validation message; identifier/phone fields now revalidate on interaction, with a regression assertion. No third visual round.

Publication screenshots, copied byte-for-byte from the reviewed PNGs: [optional phone registration — Vietnamese, 390px/100%](docs/images/t96-phone-register.png) and [phone already in use — Vietnamese, 320px/200%](docs/images/t96-phone-error.png). Both are offscreen Flutter fixture renders with SDK fonts and a simulated 220px keyboard inset; they are not staging or native-device evidence.

Coordinator accepted the changed phone fields/errors and 320px/200% layouts. The 390px login-top master-lockup region was observed blank in a capture; decode/paint timing is suspected, not proven. This slice does not claim logo capture verification and did not alter branding or run a third visual round. These are offscreen Flutter renders with SDK fonts and a simulated 220px keyboard inset, not device screenshots or real keyboard/TalkBack/VoiceOver verification.

Earlier runs found test-harness accessor/merged-label/semantics-handle cleanup errors and analyzer lint/unused-import issues; corrected without removing accessibility coverage. Initial `focused-tests.log` (76 pass/4 harness-cleanup failures), `analyze.log` and first captures remain for audit. Final results above supersede those runs. Four original brand PNGs + BrandMark are byte-identical to HEAD (`brand-audit.json`); this is separate from image-paint verification.

Start from `E:/Project/PowerMe/powerme/apps/mobile` with the existing public API/Vietmap config files and the authorized backend/tunnel described in [the API guide](docs/t96-driver-api.md). Stop/Run the app to load this code; use a phone already associated with the account, or use email. No OAuth setup is required. Commands below are instructions, not live auth/staging checks performed by this slice:

```powershell
Set-Location E:/Project/PowerMe/powerme/apps/mobile
& E:/MobileDev/Flutter/bin/flutter.bat run --no-pub -t lib/main.dart
# After stopping the app, run the new auth tests:
& E:/MobileDev/Flutter/bin/flutter.bat test --no-pub --concurrency=1 --reporter expanded test/phone_auth_test.dart test/phone_auth_widget_test.dart
```

Successful API login/registration uses the existing **Discover** destination. Integration/live phone login/register, native autofill/IME/accessibility-service behavior and device/staging acceptance remain pending. Native builds were not run for this phone slice. Exact implementation-stage file hashes, log/capture paths and limitations: `E:/Project/PowerMe/.review/phone-auth/handoff.json`. Publication backup and PR description: `E:/Project/PowerMe/.review/phone-auth-publish`.



## T145 — bằng chứng giao diện cho PR, 20/11

Ảnh Flutter offscreen với fixture, sao chép nguyên PNG đã duyệt: [Tài khoản](docs/images/t145-profile.png), [nạp tín dụng có nút (?)](docs/images/t145-topup-points.png), [trợ giúp với minimum 500 điểm hiện tại](docs/images/t145-points-help.png). Không phải ảnh thiết bị hoặc staging. Hai ảnh nạp/trợ giúp lấy từ slice 500 mới nhất; mô tả ZIP6 bên dưới là lịch sử trước khi bổ sung hướng dẫn minimum. Một số frame state/cuộn cũ thiếu header; ba ảnh được chọn đã kiểm trực quan. Lịch sử/hết hạn chờ T149; chưa nghiệm thu đầy đủ FR-17 hoặc thanh toán thật.

## T145 — trợ giúp sử dụng điểm, 20/11

Thêm nút (?) teal cạnh **Sử dụng điểm PowerMe** ở Nạp tín dụng và Điểm, dùng chung hướng dẫn VI/EN có drag handle, cuộn, SafeArea và **Đã hiểu / Got it**. Đầu help nêu rõ BR-P35 hiện tại: cần ít nhất 500 điểm còn hạn và mỗi lần đổi tối thiểu 500 điểm; dưới 500 vẫn nạp không dùng điểm. Đây chỉ là thông tin; quote động/server vẫn quyết định validation. Không đổi controller/policy/route; đóng help giữ draft/quote, có thể refresh theo visibility guard hiện có. Trace/copy ở [screens](docs/screens.md#t145--trợ-giúp-sử-dụng-điểm-2011), native source pin ở [architecture](docs/architecture.md#t145--presentation-trợ-giúp-điểm-2011).

Correction copy 500 điểm: format 1 file/0 changed, analyze sạch, existing loyalty/top-up 35/35 và một batch capture 4/4 (11 PNG) tại `E:/Project/PowerMe/.review/t145-points-help-500`; đã xem sheet VI/EN 390px và toàn bộ scroll 320px/200%, không sửa UI sau capture. Chỉ offscreen fixtures/font SDK; chưa kiểm device/API/thanh toán thật, không full suite/APK hoặc thêm/sửa test.

Focused `flutter test --no-pub --concurrency=1 --reporter expanded test/driver_loyalty_test.dart test/driver_top_up_fault_test.dart`: **35/35 pass**; `flutter analyze --no-pub`: **No issues found**. Capture một batch `tool/capture_points_help_test.dart`: **4/4 pass, 10 PNG**, VI/EN tại 390px và 320px/200%, normal hai heading; contact sheets đã xem, không sửa UI sau capture. Widget tests giữ draft/quote, no financial POST/native launch, close/Back; capture kiểm barrier/swipe. Lần focused đầu 33 pass/2 lỗi finder do copy unexpired cùng có trên page và sheet; chỉ scope finder vào sheet, không sửa production để xử lý test. Analyzer đầu báo một lint braces trong capture helper, đã sửa.

Baseline affected files, lib/assets SHA-256, logs `format-final.log`, `analyze-final.log`, `focused-tests-final.log`, `capture.log`, PNG/contact sheets và `handoff.json` tại `E:/Project/PowerMe/.review/t145-points-help`. Chỉ Flutter offscreen fixture + font SDK, không device/emulator/iOS, staging hoặc thanh toán thật; English dùng localized profile fixture, không thêm runtime language switch. Parent/coordinator đã duyệt hai contact sheets, không cần correction/recapture. Không full suite/APK mới cho slice nhỏ; kết quả 229 test/build ZIP6 dưới đây là baseline lịch sử. Không dependency/install, backend/root docs/diagram/config/logo, commit/push/rebase/reset/stash. Giữ nguyên WIP T145/ZIP6 và unrelated T139.

## T145 — restyle Stitch ZIP (6), 20/11

Mục này cập nhật trạng thái giao diện/kiểm thử mới nhất cho ba màn `/profile`, `/loyalty`, `/credit/top-up`; phần T145 baseline bên dưới giữ làm lịch sử. Nguồn người dùng: `stitch_powerme_ev_app_ui_design (6).zip` (3 HTML/PNG và DESIGN), SHA-256 `992a01cda61d5cbf501dbf5f06e496bc505a5ae3373ae9af02cc7db3165f8355`; chỉ đọc nội dung, không chạy HTML/remote assets. Trace tại [screens](docs/screens.md#t145--stitch-zip-6-2011), ranh giới tại [architecture](docs/architecture.md#t145--stitch-zip-6-2011), sai khác tại [design-system](docs/design-system.md).

Tài khoản dùng identity thật, hai ô tín dụng/xe mặc định và nhóm menu; nhà xe có đơn vị `1 xe`/`1 vehicle` (số nhiều theo dữ liệu), badge trailing ở normal width, xếp cùng nội dung ở narrow/large text. Bỏ nhãn Xem dư ở dòng tín dụng. Đăng xuất dùng error color của theme, giữ xác nhận và guard scope. Điểm dùng hero vàng/CTA teal/info inset; 320px/200% tách refresh khỏi badge để giữ nguyên từ PowerMe và vùng chạm 48dp. Với điểm tùy chọn có payable chưa biết nhưng đủ điều kiện gửi, CTA là **Xem số tiền thanh toán / Review payment amount**; GET xác minh rồi mới hiển thị số tiền và nút tiếp tục VNPay như trước. Bốn sửa theo coordinator đã được xác nhận trong đúng một batch + một confirmation; không redesign thêm.

Khác nghiệp vụ ZIP: giữ 5 tab gồm QR giữa; màu/logo/font gốc; không VIP/NFC/Autocharge/tier/chứng nhận/lịch sử/hết hạn giả. Điểm khả dụng từ quote khác maximum đổi (fixture 6000/2500); CTA 0 điểm vẫn mở nạp. Top-up là tín dụng VND, giới hạn hiện có 50.000–2.000.000; không copy 20k, minimum 500 điểm, rate 10, cap 50% hoặc khóa 5 phút. Maximum dùng max discount server; arbitrary partial không suy tiền. 422 requote/clear, 409 resume, UUID/body qua timeout, route/auth/cancel, refresh credited/refunded và Return URL ≠ paid giữ nguyên. T149 chưa có trên main mới, không thêm API lịch sử/expiry/reserved.

Kiểm thực tế bằng Flutter 3.44.2 / Dart 3.12.2 / Python 3.10, cache hiện có, TMP/TEMP `E:/Project/PowerMe/.review/t145-stitch6/tmp`; không install/pub get/upgrade:

- `dart format --output=none --set-exit-if-changed lib test tool`: **180 file, 0 changed**; `flutter analyze --no-pub`: **No issues found**.
- Focused loyalty/top-up/vehicle/credit/navigation **50/50**; API widget suite sau sửa helper **5/5**. Full `flutter test --no-pub --concurrency=1 --reporter expanded`: **229/229 pass**. Lần full đầu **228 pass / 1 fail** vì `driver_api_widget_test` giả định add-vehicle ở viewport; helper nay cuộn lazy list + flush frame trước assertion/tap, giữ mọi auth/private-route/business assertion. Log đầu `full-tests-initial.log`, confirmation `full-tests-final.log`; không thêm production fix hoặc capture round cho lỗi test này.
- Capture confirmation **4/4 ca pass / 174 PNG**, 18 scenario mỗi tổ hợp 390×844/100% và 320×844/200%, Việt/Anh. Manifest ở `captures-confirmation/{390-1x,320-2x}-{vietnamese,english}/manifest.json` ghi offset/viewport/bounds và target; normal pages phủ toàn bộ outer AppPage ListView, biến thể có header + vùng thay đổi. Đây là Flutter offscreen render với font SDK và transport/localized-profile fixture; English chỉ kiểm copy/layout hiện có, ApiApp chưa hỗ trợ đổi ngôn ngữ runtime.
- Android: `android/gradlew.bat -p android --offline --no-daemon -Pkotlin.incremental=false :app:assembleDebug`: **BUILD SUCCESSFUL in 30s**; APK `build/app/outputs/apk/debug/app-debug.apk`, chưa cài. Cảnh báo Kotlin/KGP/Vietmap/Gradle hiện hữu giữ nguyên; không đổi dependencies/SDK.

**Giới hạn capture:** Một số ảnh state/cuộn vẫn thiếu chrome app bar: `390-1x-vietnamese/loyalty-zero-01.png` và `390-1x-vietnamese/top-up-partial-unknown-summary-02.png`; zero đã có body title, pending GET/normal frames có logo. Decoded asset và các assertion lấy mẫu pixel pass không chứng minh mọi header PNG đã paint. Coordinator xác nhận bốn sửa UI đã đạt; không thêm vòng UI/capture. Chưa kiểm device/emulator/iOS, API đăng nhập staging, thanh toán thật hoặc NFR.

Preview 3 màn normal 390px tiếng Việt: `E:/Project/PowerMe/.review/t145-stitch6/preview-3-screens-390-vi.png`, đã được coordinator duyệt, dùng đúng ba first-frame có logo gốc, không ghép header. Logs `format-final.log`, `analyze-final.log`, `focused-tests-final.log`, `focused-api-final.log`, `full-tests-final.log`, `capture-confirmation.log`, `android-debug-final.log`; audit `capture-confirmation-audit.json`, manifest/hashes/APK trong `finalhandoff.json`, cùng thư mục evidence. 9 lib controller/domain/adapter/composition files match baseline và 4 PNG match asset nguồn; không đổi backend/root docs/diagrams. `origin/main` đã được coordinator fresh-fetch và local xác minh `86285d0ce3cc5ec485b46c630bef501d8f45248d`: HEAD/main diff cho mobile và Driver API contract rỗng theo coordinator, mobile đã kiểm lại; không rebase/reset trên WIP, không commit/push/stage.

## T145 — Điểm PowerMe (20/11)

**Tài khoản → Điểm PowerMe** mở số điểm còn hiệu lực từ Driver API quote read-only. Không cần xe. Có số 0/loading/error/thử lại, refresh khi resume hoặc quay từ nạp tín dụng. CTA **Đổi điểm khi nạp** mở `/credit/top-up`; không có thao tác đổi điểm độc lập. Không giữ/trừ điểm trên app. Tỷ lệ/minimum/cap seeded không hardcode: live quote và 422 server quyết định. Với số điểm khác maximum, app hiển thị tiền phải trả từ GET trước khi cho tiếp tục VNPay; auto-open 0 điểm và maximum vẫn giữ đủ safety guards.

Lịch sử và điểm sắp hết hạn chờ API T149; đảo điểm khi sửa/hoàn phiên còn thiếu nghiệp vụ backend riêng. T149 chỉ bổ sung route riêng xem số dư, lịch sử và điểm sắp hết hạn; không hứa field lots/reserved. Quote chỉ đọc, không giữ điểm; mô hình reserved cũ chỉ dùng trong legacy test fixtures. Không hiển thị dữ liệu thay thế hoặc các trường thiếu thành 0. `earned_points` trên bảng kê giữ nguyên từ server. Full FR-17/UC-PAY-04 chưa được tuyên bố Done. Xem trace và pinned research/license ở [screens](docs/screens.md#t145--view-13-điểm-khả-dụng-2011) / [architecture](docs/architecture.md#t145--điểm-khả-dụng-qua-báo-giá-2011).

Đã kiểm với SDK/cache hiện có, không pub get/upgrade:

- `dart format --output=none --set-exit-if-changed` trên **21 file Dart thay đổi: 0 changed**; `flutter analyze --no-pub`: **No issues found** (4,3 s).
- Focused loyalty/top-up **30/30 pass** (10 s); vehicle regression **8/8 pass** (7 s); full `flutter test --no-pub --concurrency=1 --reporter expanded`: **228/228 pass** (1 phút 38 s), baseline 212 + 16 ca mới. Lần full đầu 227/228: menu thêm điểm đẩy nút thêm xe ngoài lazy viewport ở 320×640; helper test nay cuộn trước khi ensureVisible, không đổi nghiệp vụ xe hoặc bỏ assertions. Log đầu được giữ riêng.
- Capture: batch đầu + đúng một confirmation round; confirmation **4/4 pass, 32 PNG**, đủ available/zero/error/loading cho Việt/Anh ở 390×844 và 320px/200%. Sửa timing scroll/tap và thêm state assertions/fatal missed taps trong capture harness; không sửa UI sau review. Hai contact sheet hiện tại đã được review đạt: `E:/Project/PowerMe/.review/t145-loyalty/contact-states.jpg`, `contact-scroll.jpg`. Final manifests ở `captures-confirmed/{390-1x,320-2x}-{vietnamese,english}/manifest.json`; có offset của từng khung cuộn. Đây là Flutter render với font SDK và transport/localized-profile fixture, không là ảnh device/staging. ApiApp chưa hỗ trợ đổi ngôn ngữ; kiểm Anh chỉ kiểm copy/layout có sẵn.
- Android: `android/gradlew.bat --offline --no-daemon '-Pkotlin.incremental=false' :app:assembleDebug` **BUILD SUCCESSFUL in 1m 2s**, 125 task (23 executed/102 up-to-date). APK `build/app/outputs/apk/debug/app-debug.apk`; chưa cài. Cảnh báo Kotlin/KGP Vietmap và Gradle deprecation hiện hữu; không thay dependencies/SDK/cấu hình để xử lý.

Logs, changed-file list, APK SHA-256 và handoff ở `E:/Project/PowerMe/.review/t145-loyalty/handoff.json`. Không chạy thanh toán/ghi API thật, authenticated read trên staging, device/emulator/iOS hoặc nghiệm thu NFR. Chỉ có tunnel health 200, không là smoke T145. Guide T145 ngày 19/11 ghi VNPay staging chưa gọi được từ VM (T140); chưa xác minh lại hạn chế đó hoặc chạy thanh toán thật. Không commit/push/deploy.

## T96 — Stitch ZIP (5), bốn chế độ sạc, 19/11

Mobile nối `full`/`timed`/`energy_kwh`/`amount_vnd` theo Driver API 0.14 §17. Sau khi API xác nhận mã phiên và effect, M07 tự chuyển M08; accepted vẫn chờ. Cap dùng đúng phút/Wh/VND và cần đồng ý với key mới. Chỉnh sửa sau từ chối/cap giữ cổng, xe và draft; gửi lại kết quả chưa rõ giữ nguyên key/body. Back, background/resume, rời QR, đổi xe và logout giữ các guard của phiên. M08 hiển thị số đo/elapsed server và estimate T134, tách maximum tariff; không có timer tự dừng trên mobile. M09-A/4 pha/bảng kê giữ stop ACK, chỉ số chốt và quyết toán độc lập.

Staging hiện vẫn API 0.13 vì PR #193 chưa merge/deploy. Energy legacy thiếu các field mới vẫn đọc được; elapsed thiếu hiển thị “—”. Mode lạ/null không được suy thành kWh. Khi staging từ chối mode mới, UI báo chế độ chưa khả dụng và cho chỉnh sửa, không fallback fixture. Chưa xác minh bốn chế độ trên staging, camera/charger thật, iOS hoặc NFR latency.

Kiểm thực tế bằng Flutter 3.44.2 / Dart 3.12.2, dependency/cache hiện có, TMP/TEMP trong `apps/mobile/.cache/tmp`:

- `dart format lib test tool`: 172 file, kiểm cuối **0 changed** với `--output=none --set-exit-if-changed`; log `.cache/four-mode-format-verify.log`.
- `flutter analyze --no-pub`: **No issues found** (2,4 giây), `.cache/four-mode-analyze.log`.
- `flutter test --no-pub --reporter expanded`: **212/212 pass** (30 giây), gồm 189 baseline và 23 ca mới; `.cache/four-mode-full-tests.log`. Hai test start/session đã cập nhật bàn giao tự động và giữ các ca stable-key/lifecycle/settlement. Bộ mới kiểm bốn wire shape, full null, caps 0/sai kiểu/mode binding, đơn vị progress, money unknown/maximum, overshoot 10,23 kWh, draft/edit, mode defaults/presets, auto-nav/Back/background/late/logout và không tự POST stop.
- Capture batch đầu: **2/2 pass** (9 giây), **121 PNG / 17 scenario cho mỗi kích thước**, gồm M06 bốn mode, M07 pending/cap/zero, M08 bốn mode, M09-A, stopping/final-meter/posted. [390×844, 38 khung](build/previews/stitch-charging-zip5/390-1x/manifest.json) · [320px/200%, 83 khung](build/previews/stitch-charging-zip5/320-2x/manifest.json). Mỗi manifest có offset cuộn; `-01.png` là khung đầu, số cuối là đáy, các khung giữa có overlap. Đây là Flutter render với SDK fonts và transport/scanner fixture trong test, không phải screenshot emulator/device. Giao diện 390px và các form/xác nhận 320px/200% đã được review đạt, không cần chỉnh UI. Công cụ capture đã bổ sung unfocus trước khi chụp; bộ PNG đã review là batch đầu, chưa render lại chỉ để dọn caret. Log `.cache/four-mode-capture.log`.
- Android debug: `android/gradlew.bat --offline --no-daemon "-Pkotlin.incremental=false" :app:assembleDebug` **BUILD SUCCESSFUL in 47s**, 125 task (19 executed/106 up-to-date). APK `build/app/outputs/apk/debug/app-debug.apk`; log `.cache/four-mode-apk.log`. Gradle có cảnh báo deprecation hiện hữu. Chưa cài/chạy APK trên thiết bị.

Thay đổi chỉ ở `lib/features/charging`, adapter tối thiểu `lib/core/api/driver_api_session.dart`, test/support/tool và bốn tài liệu mobile. Logo, dependency, config, backend và diagrams giữ nguyên. Phạm vi phát hành: chỉ phần mobile; PR phụ thuộc API #193, chưa xác minh staging. Việc bàn giao source sang checkout Run dùng backup bytes, manifest SHA-256 và stash giữ lại. Branch `wp3/t96-mobile-bon-che-do-sac` từ `4ce6124`. Nguồn nghiên cứu, licenses và mapping kiến trúc ở [architecture](docs/architecture.md#t96--bốn-chế-độ-stitch-zip-5-1911); các sai khác nghiệp vụ với ZIP ở [design-system](docs/design-system.md#charging-theo-stitch-zip-5--1911).

| | |
|---|---|
| Chủ sở hữu | WP3 — Mobile Developer (Sơn) |
| Cột mốc | **M3 — 18/10/2026** (giao diện + mock local, PR #70) |
| Stack | Flutter 3.44.2 / Dart 3.12.2, flutter_riverpod 3.4.3, go_router 16.3.0, vietmap_flutter_gl 4.1.1, geolocator 14.0.2, mobile_scanner 7.4.2; ngoài npm workspaces (ADR-0001, phụ lục 10/2026) |
| Hợp đồng API | [Driver OpenAPI](../../docs/api/driver-api.openapi.yaml) · T96 hỗ trợ auth, hồ sơ và quản lý xe với Dio 5.9.2 |

**T96.** App lấy `API_BASE_URL` từ `config/api.local.json`. Để test trên Android Emulator với backend staging, mở [tunnel API](docs/api-tunnel.md) rồi bấm **Run** với `lib/main.dart` hoặc chạy `flutter run`. Các màn chưa nối API được kiểm tra bằng widget test và công cụ chụp ảnh ở mục bên dưới. Xem [cấu hình và kịch bản thêm, đặt mặc định, gỡ xe](docs/t96-driver-api.md#4-kiểm-thử-xe-qua-tunnel-api).

Người dùng đã xác nhận đăng nhập, đăng xuất và đăng ký trên staging. App dùng Driver API cho các luồng này. Fake đăng nhập và cấu hình ghép các màn chưa tích hợp nằm trong `test/support`. Sau khi dọn mock, 106 test Flutter và 2 test chụp ảnh pass. Analyzer sạch, format kiểm 104 file không cần sửa.

Slice xe đã kiểm local với Flutter 3.44.2. Toàn bộ 115 test pass, analyzer sạch, format kiểm 106 file. Android debug build offline thành công và APK dùng URL emulator từ cấu hình hiện có. Luồng xe qua API staging chờ người dùng kiểm thử.

Restyle đăng ký và thêm xe T96 đã kiểm local bằng Flutter 3.44.2. `dart format` kiểm 109 file, `flutter analyze --no-pub` sạch, `flutter test --no-pub` qua 118 test. Ảnh Flutter 390 × 844 dùng transport fixture. Chờ kiểm trên thiết bị và staging cho restyle này.

Review hồ sơ xe T96 đã kiểm local bằng Flutter 3.44.2. Format kiểm 7 file Dart đã sửa, analyzer sạch và toàn bộ 146 test pass, gồm 23 test API/widget hồ sơ xe. Lần này kiểm bằng transport fixture, chưa build APK hoặc smoke trên staging. [Kịch bản kiểm lại](docs/t96-driver-api.md#4-kiểm-thử-xe-qua-tunnel-api).

Slice tín dụng sạc và dừng thủ công T96 đã kiểm local bằng Flutter 3.44.2 / Dart 3.12.2. Format 147 file (0 thay đổi), `flutter analyze --no-pub` sạch, 23 ca kiểm tập trung và toàn bộ 155 ca fixture pass. App mở tín dụng từ **Tài khoản** và dừng từ **Theo dõi phiên** sau khi xác nhận. Smoke API trên thiết bị và staging còn chờ. [Hợp đồng và kịch bản kiểm](docs/t96-driver-api.md#9-tín-dụng-sạc-và-dừng-thủ-công).

Bản tích hợp T96 ghép lên mốc `3866840` kiểm local bằng Flutter 3.44.2 và Dart 3.12.2. Format kiểm 155 file, analyzer sạch, toàn bộ 175 ca fixture pass và công cụ chụp luồng sạc pass với font SDK. Chờ kiểm trên thiết bị và staging.

Driver API đã nối báo giá, tạo và kiểm tra giao dịch nạp VNPay (T32) cùng báo lỗi cổng từ chi tiết trạm và QR (FE-17). Trên Flutter 3.44.2, format 39 file Dart (0 thay đổi), `flutter analyze --no-pub` sạch, 22 ca tập trung và toàn bộ 182 ca fixture pass. Các fixture thanh toán và báo lỗi cũ nằm trong `test/support`. Smoke VNPay cần cấu hình merchant sandbox, URL IPN công khai và các phần T32 xử lý IPN/querydr trên staging. [Hợp đồng Driver API §14–15](../../docs/api/DRIVER-API-HOP-DONG.md#14-top-up-wf-02--nạp-charging-credit-qua-vnpay-t32-phần-5).

Sau cập nhật nút **Thanh toán qua VNPay**, format 6 file Dart đã sửa (0 thay đổi khi kiểm tra lại), analyzer sạch, 14 ca trong `driver_top_up_fault_test.dart` và toàn bộ 189 ca fixture đạt. Kiểm tra mở trình duyệt qua MethodChannel giả lập. Smoke VNPay trên thiết bị và staging vẫn đang chờ.

Android `:app:compileDebugKotlin` chạy offline thành công với Gradle 9.1.0, cache SDK sẵn có và incremental Kotlin tắt để tránh lỗi khác ổ đĩa. Kiểm thử thiết bị và build iOS còn chờ.

Bản đóng gói T96 ngày 19/11 kiểm lại: `dart format --output=none --set-exit-if-changed lib test tool` sạch (169 file), `flutter analyze --no-pub` sạch, `flutter test --no-pub test/driver_top_up_fault_test.dart` đạt 14 ca và `flutter test --no-pub` đạt toàn bộ 189 ca. Sáu ca chụp/review fixture đạt, gồm 390 × 844 và 320 px/200%; hai contact sheet đã kiểm font, logo và nhãn thanh toán hiện tại: [nạp VNPay và báo lỗi](docs/images/t96-topup-report-stitch.png), [năm màn tài xế](docs/images/t96-driver-screens-stitch.png). `gradlew.bat --offline --no-daemon "-Pkotlin.incremental=false" :app:compileDebugKotlin` thành công (47 giây). Chưa kiểm iOS, thiết bị hoặc thanh toán/staging thật.

Đọc [screen/function reference](docs/screens.md) và [architecture reference](docs/architecture.md) trước khi code. Đây là hai tài liệu chuẩn của mobile; [AGENTS.md](AGENTS.md) bắt buộc đọc chúng. SRS/registration và sơ đồ hiện hành dẫn từ đó thay thế các bản tóm tắt MB cũ.

## Phạm vi

- **MB-01** Khởi tạo app, hệ thống thiết kế, đa ngôn ngữ Việt và Anh
- **MB-02** Đăng ký và đăng nhập OTP, hồ sơ người dùng, quản lý xe
- **MB-03** Bản đồ tìm trụ, bộ lọc, trạng thái realtime tới từng súng
- **MB-04** Quét QR trên màn hình trụ để ghép phiên, remote start và stop
- **MB-05** Màn hình sạc realtime: SoC, kWh, điện áp, dòng, thời gian, chi phí
- **MB-06** Lịch sử phiên, xem hoá đơn, báo lỗi trụ

## Ràng buộc

- Driver API 0.14 định nghĩa bốn chế độ `full`, `timed`, `energy_kwh`, `amount_vnd` (§17). Mobile đã nối bốn shape trong slice ZIP (5). Staging hiện vẫn 0.13, chỉ hỗ trợ energy vì PR #193 chưa merge/deploy. Response energy cũ tiếp tục đọc được; chế độ chưa hỗ trợ báo lỗi nghiệp vụ và cho chỉnh sửa, không chuyển sang fixture.
- Có hai đường bắt đầu phiên **không đi qua app** (quẹt thẻ RFID, thao tác trên trụ). App phải xử lý được việc thấy một phiên mà nó không tạo ra; hợp đồng mô tả ở `DRIVER-API-HOP-DONG.md` §5.
- Ngưỡng M3: SoC và kWh cập nhật **trong vòng vài giây** kể từ khi simulator gửi `MeterValues`. Giai đoạn mock: polling 5 s theo hợp đồng; SSE dự kiến tuần 10.
- Các luồng chưa tích hợp dùng dữ liệu mock trong kiểm thử. Giao diện tài xế không hiển thị nhãn demo/mock.

## Chạy trên clone mới

```bash
cd apps/mobile
cp config/api.example.json config/api.local.json           # cấu hình API cho Android Emulator
cp config/vietmap.example.json config/vietmap.local.json   # có thể để trống tileApiKey
flutter pub get
dart format --output=none --set-exit-if-changed .
flutter analyze
flutter test
flutter run                  # chọn Android Emulator API 24+ khi được hỏi
```

Sửa `API_BASE_URL` theo môi trường, rồi Stop và Run lại khi đổi file. Chỉ `config/api.local.json` và `config/vietmap.local.json` được đóng gói. Hai file bắt buộc khi build và chỉ được chứa cấu hình công khai. Xem [cách cấp key chỉ dùng Tilemap](docs/vietmap-setup.md).

CI (`.github/workflows/ci.yml`, job `Flutter · Format · Analyze · Test`) chạy đúng bốn lệnh kiểm tra trên với Flutter 3.44.2 cho mọi PR chạm `apps/mobile`. Kết quả 01/11 trên mã PR #70: analyze sạch, **85/85 test**, format sạch sau commit `dart format`.

Ảnh render trong `build/previews/` được tạo bởi `tool/capture_preview_test.dart`; thư mục `build/` không commit, nên các link ảnh trong nhật ký dưới đây chỉ mở được trên máy đã chạy lệnh chụp.

---

## Nhật ký review UI và kiểm chứng local (28/10 → 30/10, mới nhất ở trên)

## Google Maps SDK removed — 30/10

Removed the recently added Google Maps dependency and unused transitive packages, native API-key metadata/channel, Gradle key loader and SDK-only minimum-Android override. Discover uses the existing local RoadMapCanvas again, including marker selection and route previews. Removed unused SDK-only geographic fixtures/providers; preserved the existing map UI, route controllers, logos and other WIP. No API key or Google SDK is required to run this version.

Validation: offline dependency resolution succeeded; format passed and analyzer reported no issues. The first full test run found an existing map-sheet interaction issue in a navigation test: the expanded sheet covered the filter control. The test now collapses the sheet before tapping filters; the affected three tests passed. Final full suite: **72/72 tests passed (11s)**. Android/device builds were not run. Historical GitHub research links in map-first-research.md remain source attribution, not an SDK integration or setup instruction. No backend changes, commit or push.

## Latest eight-point UI review — 30/10

Completed the interrupted review from the saved edits. Connector cards retain a single-line normal-width title without repeated charging logos, with the redundant gap removed; empty Charging stays in a centered card. Shared failures now have a gold information panel and live-region announcement; blank messages take no space. Report confirmation appears only after the repository's saved acknowledgment, with a teal check, title, receipt/time and safe back action.

Suggestions render supplied ranks/reasons only, omit null/blank optional metadata and mute supporting estimates/freshness. Profile email uses a labeled, full-width read-only `InputDecorator` with selectable text; it is not another editable field. Profile/vehicle back actions pop an existing page or fall back to `/profile`, including directly opened/missing-vehicle routes. Three-tab navigation has explicit graphite/teal/icon colors and a top divider. `ValueLine.showDivider` suppresses redundant final dividers in statement, checkout, ledger, loyalty and hold receipt cards. Business controllers, money/ranking logic, architecture signatures and mock-only composition are unchanged.

**Actual checks:** full local suite **66/66 passed (15s)**; after the final email layout/copy-selection adjustment, the affected UI/auth-profile suite **12/12 passed (6s)**. Final formatting **76 files / 0 changes** and analyzer **no issues (2.0s)**. Capture **1 test passed (6s)**; regenerated **40 PNGs and five contact sheets**, 390×844 at 2× pixels. All five sheets were inspected, followed by refreshed full-size profile, failure, saved-report and suggestion images. The email now fits one line at normal width; tests also cover 320px/200% text without overflow. All four brand PNG SHA-256 hashes still match their original source files.

Previews: [read-only email](build/previews/profile-edit-vi.png), [failure](build/previews/report-error-vi.png), [saved report](build/previews/report-saved-vi.png), [suggestions](build/previews/suggestions-vi.png), [station detail](build/previews/station-detail-vi.png), [empty Charging](build/previews/session-empty-vi.png), [statement](build/previews/statement-vi.png). Sheets: [1](build/previews/review-1.jpg), [2](build/previews/review-2.jpg), [3](build/previews/review-3.jpg), [4](build/previews/review-4.jpg), [5](build/previews/review-5.jpg); [40-image manifest](build/previews/manifest.json).

Changed areas: shared `flow_page.dart`/theme, shell router, station detail/suggestions/hold, charging statement, payment/history/loyalty final receipt rows, report and profile/vehicle presentation; `test/eight_point_ui_review_test.dart`, capture tooling and these mobile references. The last continuation additionally corrected the email wrapping found during visual inspection. No new dependencies, backend/shared docs, architecture getter/privacy refactor, commit or push. Fetch succeeded before continuation: HEAD/origin/main `50a2010dfb217c2f3f6b40e2879a1661dff48f85`, divergence 0/0; WIP and user diagrams preserved. This slice did not rerun web/device builds; earlier build results below belong to earlier slices. Real API/device/payment/accessibility-service behavior and NFR acceptance remain unverified.

## Earlier navigation/logo review — 30/10

Completed the interrupted bounded review after checking SRS Table 5, UC-CHG-01–04/06, BR-P18/24–31/39 and the mobile screen/architecture references. Discover `/`, Charging `/charging` and Account `/profile` share a guarded shell with persistent bottom navigation on those three screens. Selecting a tab only navigates: no start/stop, new unknown-command key, repeated restore or extra subscription. Tests cover active/unknown-start/unknown-stop tab round trips, one-time restoration and logout → another account without the old session/event stream.

Home places compact charging credit above search and offers connector code, suggestions, reservation and schematic. `/reserve` without a connector reads an existing owned hold or shows a choose-station empty state; it does not create a hold. Reservation remains Should with explicit fee/cutoff confirmation. Station name/address/operator/tariff/disclosure share one card.

Auth/header use the original master lockup or ribbon/wordmark; start, empty/pending charging and station/connector avatars use the original secondary icon. Runtime `BlendMode.screen` filters against an explicit solid rich-black/graphite surface, without a white tint or image-byte changes. All **four** SHA-256 hashes match the original source assets. Pixel tests verify both surfaces and retained gold/teal artwork. Already researched sources, tradeoffs and provenance: [architecture research](docs/architecture.md), [design system](docs/design-system.md), [brand provenance](assets/brand/README.md). No dependencies added.

**Actual final checks:** format **75 Dart files / 0 changes**; analyzer **no issues (2.7s)**; full local suite **58/58 passed (11s)**; capture **1 test passed (6s)**, producing **38 PNGs** (previous 36 plus empty charging and empty reservation) and **five regenerated contact sheets** at 390×844 / 2× pixels; **web build passed (45.7s), Wasm dry run succeeded**. All processes exited 0. Git whitespace check passed. These are render/unit/widget/build checks, not device/API/payment or measured NFR acceptance.

Review paths: [Home](build/previews/discovery-vi.png), [station detail](build/previews/station-detail-vi.png), [empty Charging](build/previews/session-empty-vi.png), [active Charging](build/previews/session-active-vi.png), [empty reservation](build/previews/reservation-empty-vi.png), [login](build/previews/login-vi.png). Full sheets: [1](build/previews/review-1.jpg), [2](build/previews/review-2.jpg), [3](build/previews/review-3.jpg), [4](build/previews/review-4.jpg), [5](build/previews/review-5.jpg); [38-image manifest](build/previews/manifest.json). Worker reviewed Home, station detail, login, active charging, both empty states and sheets 1/3; primary confirmed Home layout/logo.

Files in this slice: `lib/app/router.dart`, `lib/core/l10n/app_copy.dart`, `lib/core/widgets/brand_mark.dart`, `lib/core/widgets/flow_page.dart`; station discovery/detail/actions and charging presentation; unchanged-byte secondary asset; `test/three_tab_navigation_test.dart`, `test/brand_surface_test.dart`; capture tooling and mobile-only reference/provenance docs. Interrupted implementation preserved, final evidence completed. No domain/business-policy/backend changes, commit or push.

Git preflight on 30/10 fetched origin successfully: HEAD/origin/main `50a2010dfb217c2f3f6b40e2879a1661dff48f85`, 0/0 divergence, no unmerged files; local main remains `91d8ec0`. Existing WIP/user diagrams preserved. Data remain mock/in-memory. Real API/auth persistence/realtime/payment/camera/GPS, legal invoices, device tests and full English localization are pending. Home scroll/map toggle may reset between tabs; scoped query/filter/session state remains. Process restart persistence is not claimed.

## Earlier UI review fix — 30/10, verification superseded above

Preserved all WIP, 15 source views, mock adapters, WF01/PKG-3 boundaries and existing business guards. Only mobile presentation/shared UI, original brand crops, capture tooling and mobile documentation changed in this visual task. The old standalone app at `E:/Project/PowerMe/apps/mobile` was read as a visual reference (discovery/cards, charging and brand component); its obsolete payment/demo policies were not copied. This continuation completed the compact Home/profile refinements after the previous worker stopped.

The five-point review is reflected in hero surfaces versus quieter cards, a large SOC/progress header and adaptive metric grid, horizontal key-value rows, status pills, four uniform Home actions, profile menu/edit placement, map halos/interactive rows and left-aligned history actions. Home at 390×844 now shows the entire first station card. Credit amount stays left and top-up right at normal width; narrow/large-text layouts stack without shrinking tap targets. Reservations/history/points remain reachable from Account.

BrandMark uses the actual ribbon and wordmark raster crops on black backing, with original aspect ratios. All three brand asset hashes match the source copies; see [brand provenance](assets/brand/README.md). No logo redraw, new dependencies, domain/backend changes, commit or push. Launcher/splash remain platform scaffold; font is system/Roboto fallback.

**Actual checks on 30/10:** format **73 Dart files / 0 changes**; analyzer **no issues** (23.4s); full local suite **51/51 passed** (7s), including 320px/200% text layouts; capture **1 test passed** (4s), **36 PNGs** at 390×844 rendered at 2×, plus **5 regenerated contact sheets**; web build **passed in 36.5s**, Wasm dry run succeeded. Capture now waits for all three logo assets before taking the first onboarding frame. All processes exited 0; Git whitespace check passed. These are render/unit/widget/build checks, not device/API/payment integration or a measured accessibility/NFR certification.

Latest images: [Home](build/previews/discovery-vi.png), [Account](build/previews/account-vi.png), [Active session](build/previews/session-active-vi.png), [map](build/previews/home-map-vi.png). Current full-view sheets: [1](build/previews/review-1.jpg), [2](build/previews/review-2.jpg), [3](build/previews/review-3.jpg), [4](build/previews/review-4.jpg), [5](build/previews/review-5.jpg); inventory in [manifest](build/previews/manifest.json). All five sheets visually reviewed; the previously missing ribbon in the first onboarding capture is now present. Preserved pre-review sheets are under `build/previews-before-ui-review`: compare [Home/Account before](build/previews-before-ui-review/review-1.jpg) → [after](build/previews/review-1.jpg), and [charging before](build/previews-before-ui-review/review-3.jpg) → [after](build/previews/review-3.jpg). The archived sheets are earlier render evidence, not the old standalone app's screenshots.

Git preflight fetched origin successfully; HEAD/origin/main both `50a2010dfb217c2f3f6b40e2879a1661dff48f85`, divergence 0/0. Existing untracked mobile and user diagram work preserved. Real API/auth persistence/payment/camera/GPS/realtime, legal invoice provider, device tests and full English localization remain pending. No technical demo/mock banners were added to product screens.

## Functional baseline — 29/10, visual evidence superseded above

All 15 source views now have local implementations and connected routes: login, three-step onboarding, discovery/list/schematic, station detail, start, active session, statement, checkout, charging credit/top-up, profile/vehicles, history/invoices, fault report, loyalty, reservation and suggestions. Supporting screens include vehicle/profile edit, invoice detail and QR/manual connector resolution. This is screen coverage with mock adapters, **not completed backend integration or production acceptance**. The historical group-1/baseline sections below are superseded by this section.

The app uses the original supplied logo and gold/teal/black/graphite palette. Default vehicles are Hyundai IONIQ 5 and Nissan Leaf. VinFast-only stations remain hidden by default for non-VinFast vehicles, with an explicit override. The list icon beside the station heading scrolls to the list. Fault reporting displays the station name and connector number.

Charging supports four modes, credit checks/caps, accepted-before-start, stable-key unknown recovery, stop/limit/cutoff, stale/orphaned/review/failed states and once-only settlement. Pending/active sessions do not announce reconciliation; closed sessions can show settlement pending before a statement is posted. Repository reads do not advance simulation time. Composition runs separate local charging/payment engines with an injectable clock; these engines are fixtures, not Unity/OCPP or a real server.

Charging credit, top-up, points and history share an in-memory ledger. Querying/closing checkout does not credit it; a separate fixture engine delivers verified and posted outcomes. Late/duplicate results, point reservation/expiry/release/compensation, negative balance recovery and independent invoice failure have local tests. Invoice text/copy is a local artifact, not a legal e-invoice. Account closure only records an eligible request; no real closure/refund is executed.

**Final checks after the checkout-back fix:** formatting 72 Dart files, zero changes; analyzer no issues (1.5s); **51 tests pass** (7s); preview capture **1 test passes / 35 PNGs** (4s) at 390×844, rendered at 2×; **web build passes (31.7s), Wasm dry run succeeds**. All check processes exit 0. Git diff whitespace check also passes. Widget tests include the low-credit→top-up→start→stop→statement/history/points journey, a second start after settlement, safe back navigation from checkout opened directly, and remaining screens at 320px with 100%/200% text. These are local unit/widget checks, not backend/device E2E or NFR measurements.

Preview inventory: [manifest](build/previews/manifest.json); five current contact sheets `build/previews/review-1.jpg` through `review-5.jpg`. The obsolete `start-vi.png`, `profile-vi.png`, `profile-en.png` were removed only from this app's generated previews. Current names include `start-session-vi.png`, `account-vi.png`, `account-en.png`, `home-list-vi.png`, `report-vi.png`, `session-pending-vi.png`, `session-active-vi.png`, `statement-vi.png`, `credit-vi.png`, `history-vi.png`, `loyalty-vi.png`. All five contact sheets were visually inspected; pending/active captures have no premature reconciliation label.

To regenerate contact sheets after capture, run `python tool/create_preview_montages.py` using an existing Python/Pillow environment. This optional review tool adds no Flutter dependency. Raw captures come from Flutter render tests, not a physical device/browser screenshot.

Limits: no real API/auth persistence, GPS/routing/map tiles, camera QR scan, hosted VNPay/IPN, legal invoice provider, Socket.IO, physical charger or Unity integration. The map is a relative-position schematic; navigation copies the address. Suggestions use fixture vehicle/distance/power/tariff estimates, not a validated ranking service or 50-station research result. Reservation cutoffs/fees, credit thresholds and provider/tax policy remain fixture assumptions pending confirmation. Only discovery/account portions support custom English copy; newer flows are Vietnamese, with no complete framework localization. Font remains system/Roboto fallback. Android/iOS builds, hardware permissions, browser runtime, gateway sandbox, staging and latency/security NFRs have not been verified. No dependencies added, commit, push or deployment.

Git preflight: fetched origin; HEAD and origin/main both `50a2010dfb217c2f3f6b40e2879a1661dff48f85`, divergence 0/0, no unmerged files. Existing untracked mobile work and user diagrams were preserved.

Files touched in this final continuation (earlier Pascal feature work preserved):

- `lib/features/charging/presentation/charging_screens.dart`: show settlement only after close/reconciled/review; ongoing/failed statement copy.
- `lib/features/support/application/support_controller.dart`, `lib/features/support/presentation/report_screen.dart`: scoped human-readable station/connector label.
- `lib/features/stations/presentation/discovery_screen.dart`: jump directly to station list.
- `lib/features/payments/presentation/payment_screens.dart`: checkout-back fallback to credit when no navigation stack exists.
- `test/full_app_widget_test.dart`: assertions for lifecycle copy, report label, list reachability and direct checkout back navigation.
- `tool/capture_preview_test.dart`: current captures/manifest and explicit station-list capture; `tool/create_preview_montages.py`: reproducible contact sheets using existing Pillow.
- `docs/screens.md`, `docs/architecture.md`, `README.md`: current coverage, implemented local contracts, exact evidence and pending integration.
- Formatter-only changes in `lib/features/stations/data/mock_station_actions_repository.dart` and `lib/features/stations/presentation/station_actions_screens.dart`.
- Generated output: `build/web`, 35 current PNG captures, manifest and five contact sheets under `build/previews`; only three explicitly obsolete generated PNGs removed.

## Historical group 1 bounded slice

**Current update — group 1, 29/10:** `/login`, three-step `/register` (consent → account → vehicle), profile name edit, owned vehicle add/edit/remove/select, logout confirmation and guarded navigation are implemented locally. Default fixture: Minh Nguyễn / Hyundai IONIQ 5; second account: An Trần / Nissan Leaf. The 28/10 baseline paragraphs below are historical; their “no auth/vehicle CRUD” limitation is superseded by this update.

All authentication and data remain **mock**, selected in composition. Use `minh@powerme.local` or `an@powerme.local`, password `PowerMe123!`, or register a local account. These synthetic credentials have no external service access. Accounts/passwords/consent/vehicles are in memory only; restart resets data and returns to login. This is not secure production authentication/storage. No network auth, payment, OCPP, or backend integration.

Restore is an asynchronous route gate; the local adapter restores no session. Every login has a new generation. Logout revokes adapter access immediately and clears private provider state; late responses cannot restore the old account. Only a format-checked station path continues after login through a fresh lookup; private vehicle routes and URL query strings are not replayed. Vehicle writes use expected revisions and reject wrong ownership/concurrent duplicates. Registration records consent version `powerme-consent-local-v1` and UTC time atomically. Consent copy, eight-character local password rule, real persistence/authorization and closure/refund remain integration/policy work. Non-VinFast exclusion remains enabled; override is next group.

### Historical 28/10 baseline

Discovery `/`: compact brand, current vehicle, local accent-insensitive name/address search, all/available/120kW filters, empty/reset and loading/error/retry. Each compatible connector produces a `StationOption`; controller groups stations and counts only observed available compatible connectors. Mixed busy-first/free-second remains discoverable. Station detail `/station/:id` displays independent connector type/power/status/update/quality and compatibility; unknown IDs recover to discovery. Account `/profile` shows Minh Nguyễn, vehicle and Vietnamese/English selection. Only discovery/account bottom destinations are present.

**All data is mock, selected in composition with one shared local store. No auth/login, backend, payment, OCPP, map/location, realtime, vehicle CRUD, tariff, reservation or suggestion integration.** The profile fixture is not a login. Fixed local AuthScope supports testable response guards, not server ownership/security. Suggest remains explicitly unsupported; no suggestion control is shown. Non-VinFast default hiding is implemented; user override remains pending. Nullable estimates remain null. Fixture timestamps are fixed UTC, shown in ICT; quality is fixture metadata, not calculated live freshness. No fixture NFR claims.

Language changes custom app copy only, persists during this process, resets on restart. `MaterialApp.locale`/delegates and framework localization are not configured. Montserrat is not bundled; system/Roboto fallback is used without adding font dependencies. Exact supplied black-backed wordmark and palette retained. Visible demo/technical banners are intentionally absent per latest user instruction.

## Run and check (nested app only)

Existing SDK: Flutter 3.44.2 / Dart 3.12.2 at `E:/MobileDev/Flutter`. Approved direct dependencies: flutter_riverpod 3.4.3, go_router 16.3.0; versions locked. No dependency added for redesign.

```powershell
Set-Location E:/Project/PowerMe/powerme/apps/mobile
$env:TMP = 'E:/Project/PowerMe/.review'
$env:TEMP = $env:TMP
$env:PUB_CACHE = 'E:/MobileDev/PubCache'
& E:/MobileDev/Flutter/bin/dart.bat format --output=none --set-exit-if-changed lib test tool
& E:/MobileDev/Flutter/bin/flutter.bat analyze --no-pub
& E:/MobileDev/Flutter/bin/flutter.bat test --no-pub
& E:/MobileDev/Flutter/bin/flutter.bat build web --no-pub
& E:/MobileDev/Flutter/bin/flutter.bat test --no-pub tool/capture_preview_test.dart --dart-define=POWERME_PREVIEW_FONTS=E:/MobileDev/Flutter/bin/cache/artifacts/material_fonts
```

Preview capture loads existing Roboto regular/medium/bold and MaterialIcons and awaits wordmark decode. Outputs: `build/previews/discovery-vi.png`, `station-detail-vi.png`, `account-vi.png`, `account-en.png`. These are Flutter render captures, not browser/device screenshots. Build output: `build/web`.

## Verification

**29/10 group 1:** formatter processed 38 Dart files; analyzer **no issues**; full suite **18 tests passed** (7 new auth/profile logic tests, 4 new auth/profile widget tests, 7 existing regression tests). Preview capture **1 test passed**, producing nine images. **Web build passed (36.3s), Wasm dry run succeeded.** Tests cover enabled auth/profile actions, validation, registration/login round trip, account switching, same-account new generation, restore/logout/dispose races, revision/ownership rejection, compatibility refresh, empty-vehicle recovery and 320px/200% forms. Device/browser runtime, backend/gateway and NFR integration remain untested.

Additional captures in `build/previews`: `login-vi.png`, `onboarding-consent-vi.png`, `onboarding-account-vi.png`, `onboarding-vehicle-vi.png`, `vehicle-edit-vi.png`. Reviewed these and `account-vi.png`: no clipping, original logo/palette retained. Coordinator independently reviewed login and onboarding vehicle captures. The four baseline capture filenames remain available.

Checks used the existing SDK/cache with process-local TMP/TEMP under `E:/Project/PowerMe/.review`, `PUB_CACHE=E:/MobileDev/PubCache`, `FLUTTER_SUPPRESS_ANALYTICS=true`. Restricted SDK wrappers could not complete normally; approved SDK-cache access was used, without installing/upgrading dependencies or changing global settings. [Group 1 research/trace](docs/auth-profile-slice.md).

28/10: analysis clean; 7 tests pass (repository compatibility/vehicle rejection, mixed connector availability/stale, late query/same-principal new-generation/current-vehicle/clear/dispose guards, injected profile/store, navigation/search/filter/detail/missing-ID/language, no technical labels, 320px at 200% Vietnamese/English); preview capture passes; web build passes. Final rerun after fixture/navigation-color correction: formatter 26 files, analysis no issues, 7 tests passed, capture passed, web build succeeded (33.5s). Coordinator reviewed discovery preview: legible, brand-preserved, no visual blocker. Android/iOS/device/browser runtime, backend/auth/payment/network and NFR integration not tested. No commit/push/deploy.

Research, pinned URLs, licenses and adaptations: [research record](docs/mb-01-foundation.md), [third-party notices](THIRD_PARTY_NOTICES.md). User diagrams/scaffold/empty folders preserved.

## 30/10 — Vietmap map và định vị

Phần Vietmap dưới đây là ghi nhận lịch sử. Widget test và công cụ chụp ảnh dùng cấu hình riêng trong `test/support`. [Thiết lập và nghiên cứu Vietmap của slice trước](docs/vietmap-setup.md).

79/79 tests pass; analyzer sạch. Chưa có key để xác minh live style/tiles; chưa kiểm GPS/permission trên thiết bị. Android debug APK build thành công (147.1 s), file build/app/outputs/flutter-apk/app-debug.apk. Có warning KGP của Vietmap trên Flutter mới; chưa disable check hoặc đổi SDK. Preview missing-key riêng đã pass; live tiles/GPS vẫn cần key và thiết bị. Không commit/push.

## Hai trụ giả lập Đông Hòa — hoàn tất local 30/10

Đã lưu hai trụ PowerMe Đông Hòa 01/02, CCS2 120/60 kW, quanh Nhà Văn hóa Sinh viên ĐHQG TP.HCM. Camera mặc định 10.87534, 106.80003, zoom 16. Tọa độ/nguồn và giới hạn tại docs/vietmap-setup.md. Run lại app để tải fixture; tìm “Đông Hòa” hoặc chạm marker → xem thẻ, chi tiết hoặc mở màn start. Hai trụ là dữ liệu giả lập, chưa có route địa lý.

Actual verification: targeted suite 9/9 pass; full suite 82/82 pass (12s), analyzer no issues (2.8s). Đã sửa assertion connectorId bị escape nhầm trong test lượt trước. Formatter kiểm tra cuối ghi bên dưới. Fetch thành công, HEAD...origin/main 0/0, WIP giữ nguyên. Không đọc key local, không đổi dependency/native/backend, không build APK lại, không commit/push. Native marker rendering/taps, style reload, live tiles/GPS cần xác minh trên thiết bị với key; callback test không thay thế native integration.


## 30/10 — middle tab: Scan QR

Navigation is Discover / Scan QR / Account. Scan QR uses the real mobile_scanner 7.4.2 camera plugin (approved dependency); Android CAMERA and iOS camera usage description are configured. Camera is mounted only on the visible foreground `/scan` route and released when navigating away/backgrounding/disposal, including pending permission/start. Error/retry UI and manual charger-code entry remain available. Scans resolve through the existing StationActionsRepository before opening StartScreen confirmation; no automatic start, URL navigation, new key or extra session subscription. Camera error/denied state hides the scan frame so it cannot cross the instruction text. Current/pending/unknown commands retain a session shortcut and block another connection. Charging remains local/mock; camera integration does not connect the app to a real CSMS.

Verification: fresh origin fetch succeeded with network permission; HEAD...origin/main = 0/0, user WIP preserved. Analyzer clean; full suite **85/85 pass** (including duplicate scan, canonical/manual lookup and foreign-URL rejection, camera denied, foreground/background/tab lifecycle, active/unknown preservation and one session subscription). Capture test **1/1 pass**, new `build/previews/qr-connect-vi.png` shows denied-camera/manual fallback at 390×844; camera pixels are a test platform fake, not a live-device capture. Android debug APK built successfully. Existing Vietmap Kotlin Gradle Plugin warning remains. Native camera/QR decoding, Android device permissions, iOS build/device, backend and real charger remain unverified. No commit/push. Research and license notes: docs/architecture.md, THIRD_PARTY_NOTICES.md.

To try: Stop and Run Android again after plugin installation; open Scan QR and allow Camera. Supported QR content: `powerme:connector:station-powerme-center/1` (or enter `station-powerme-center/1`). Review charging mode/limit on the next screen before confirming.

Final visual correction: denied/error camera hides the teal scan-frame overlay. Regenerated and inspected qr-connect-vi.png; analyzer clean, 8/8 navigation/QR tests and 1/1 capture test passed after this presentation-only correction. Full 85/85 suite was run immediately before the overlay correction.
