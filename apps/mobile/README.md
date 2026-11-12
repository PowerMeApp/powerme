# @powerme/mobile — App tài xế PowerMe (WP3)

| | |
|---|---|
| Chủ sở hữu | WP3 — Mobile Developer (Sơn) |
| Cột mốc | **M3 — 18/10/2026** (giao diện + mock local, PR #70) |
| Stack | Flutter 3.44.2 / Dart 3.12.2, flutter_riverpod 3.4.3, go_router 16.3.0, vietmap_flutter_gl 4.1.1, geolocator 14.0.2, mobile_scanner 7.4.2; ngoài npm workspaces (ADR-0001, phụ lục 10/2026) |
| Hợp đồng API | [Driver OpenAPI](../../docs/api/driver-api.openapi.yaml) · T96 slice 1 hỗ trợ auth và hồ sơ đọc với Dio 5.9.2 |

**T96 slice 1.** App lấy `API_BASE_URL` từ `config/api.local.json`. Để test trên Android Emulator với backend staging, mở [tunnel API](docs/api-tunnel.md) rồi bấm **Run** với `lib/main.dart` hoặc chạy `flutter run`. Các màn chưa nối API được kiểm tra bằng widget test và công cụ chụp ảnh ở mục bên dưới. Xem [cấu hình và cách retest](docs/t96-driver-api.md).

Người dùng đã xác nhận đăng nhập, đăng xuất và đăng ký trên staging. App dùng Driver API cho các luồng này. Fake đăng nhập và cấu hình ghép các màn chưa tích hợp nằm trong `test/support`. Sau khi dọn mock, 106 test Flutter và 2 test chụp ảnh pass. Analyzer sạch, format kiểm 104 file không cần sửa.

Đọc [screen/function reference](docs/screens.md) và [architecture reference](docs/architecture.md) trước khi code. Đây là hai tài liệu chuẩn của mobile; [AGENTS.md](AGENTS.md) bắt buộc đọc chúng. SRS/registration và sơ đồ hiện hành dẫn từ đó thay thế các bản tóm tắt MB cũ.

## Phạm vi

- **MB-01** Khởi tạo app, hệ thống thiết kế, đa ngôn ngữ Việt và Anh
- **MB-02** Đăng ký và đăng nhập OTP, hồ sơ người dùng, quản lý xe
- **MB-03** Bản đồ tìm trụ, bộ lọc, trạng thái realtime tới từng súng
- **MB-04** Quét QR trên màn hình trụ để ghép phiên, remote start và stop
- **MB-05** Màn hình sạc realtime: SoC, kWh, điện áp, dòng, thời gian, chi phí
- **MB-06** Lịch sử phiên, xem hoá đơn, báo lỗi trụ

## Ràng buộc

- Backend hiện chỉ nhận **một chế độ bắt đầu phiên: hạn mức kWh** (`mode: energy_kwh`, hợp đồng #69, D4). Mock trong app có thêm `autoFull`, `timed`, `cost`; ba chế độ này chưa có backend và phải được xem là hướng phát triển cho tới khi hợp đồng đổi.
- Có hai đường bắt đầu phiên **không đi qua app** (quẹt thẻ RFID, thao tác trên trụ). App phải xử lý được việc thấy một phiên mà nó không tạo ra; hợp đồng mô tả ở `DRIVER-API-HOP-DONG.md` §5.
- Ngưỡng M3: SoC và kWh cập nhật **trong vòng vài giây** kể từ khi simulator gửi `MeterValues`. Giai đoạn mock: polling 5 s theo hợp đồng; SSE dự kiến tuần 10.
- Các luồng chưa tích hợp dùng dữ liệu mock trong kiểm thử. Giao diện tài xế không hiển thị nhãn demo/mock.

## Chạy trên clone mới

```bash
cd apps/mobile
cp config/api.example.json config/api.local.json           # cấu hình API cho Android Emulator
cp config/vietmap.example.json config/vietmap.local.json   # nếu dùng bản đồ Vietmap
flutter pub get
dart format --output=none --set-exit-if-changed .
flutter analyze
flutter test
flutter run                  # chọn Android Emulator API 24+ khi được hỏi
```

Sửa `API_BASE_URL` theo môi trường, rồi Stop và Run lại khi đổi file. Các file JSON trong `config/` được đóng gói vào app. Chỉ đưa cấu hình client công khai vào thư mục này.

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
