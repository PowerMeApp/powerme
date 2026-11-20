# Coding reference 2 — class, package và ranh giới WP3

## T145 — presentation trợ giúp điểm, 20/11

`PointsHelpHeading(copy: AppCopy, icon: IconData)` tại `features/loyalty/presentation/points_help.dart` ghép heading Expanded + nút help 48dp, giữ icon gốc từng màn. LoyaltyScreen và CreditTopUpScreen dùng chung sheet private/static; Payments → Loyalty theo PKG-3 hiện có. Không thêm domain/controller/repository/provider/route/dependency hoặc sửa các guard. Chỉ đọc `AppCopy`, theme và MediaQuery; unfocus bàn phím, bù viewInsets; SafeArea + Flexible/SingleChildScrollView và nút đóng nằm ngoài vùng cuộn. ShowModalBottomSheet native giữ barrier/Back/swipe, focus route và drag handle; không tính điểm/tiền, đọc balance hoặc tạo giao dịch. Copy đầu sheet nêu minimum hiện tại BR-P35: balance còn hạn và mỗi lần đổi đều ít nhất 500 điểm; dưới 500 vẫn nạp không dùng điểm. Maximum/mức giảm vẫn theo live quote, server quyết định validation; không sửa logic hoặc test dynamic policy.

Dùng lại cách gọi `charging_credit_screen.dart:_openStatement` (`isScrollControlled`, `useSafeArea`, `showDragHandle`); khác statement ở chỗ nội dung hoàn toàn tĩnh. Đã đọc actual SDK source và tests, không thực thi source ngoài hoặc chép implementation: Flutter 3.44.2 pin `c9a6c484230f8b5e408ec57be1ef71dee1e77020`, BSD-3-Clause, [bottom_sheet.dart](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/lib/src/material/bottom_sheet.dart) và [bottom_sheet_test.dart](https://github.com/flutter/flutter/blob/c9a6c484230f8b5e408ec57be1ef71dee1e77020/packages/flutter/test/material/bottom_sheet_test.dart) (SafeArea, barrier, enableDrag). Native pattern phù hợp app/dependency hiện có, không thêm framework; nội dung dài cần cuộn, nút đóng giữ ngoài scroll. Local tests/capture tại [screens](screens.md#t145--trợ-giúp-sử-dụng-điểm-2011), không chứng minh device/staging.

## T145 — Stitch ZIP (6), 20/11

Slice chỉ restyle ba presentation `ProfileScreen`, `LoyaltyScreen`, `CreditTopUpScreen`, test navigation helpers/capture và tài liệu mobile. Giữ `Screen → Controller → domain Repository ← API adapters`, các signatures và 9 file lib protected của T145 trước restyle; hash từng file ở `E:/Project/PowerMe/.review/t145-stitch6/finalhandoff.json`. Không widget HTTP/DTO, không policy hoặc money/points arithmetic mới. Bản research Dio/Riverpod có pin/license bên dưới được giữ; correction này là UI/bug fix, không tính năng mới và không lấy thêm source/dependency bên ngoài.

- Profile chỉ trình bày profile/credit/vehicle hiện có; menu garage đếm xe snapshot với đơn vị, badge đổi vị trí theo width/text scale. Logout chỉ thay semantic error style, giữ dialog và identity của AuthScope trước signOut. Năm tab và central QR giữ nguyên; history subtitle là Phiên sạc và bảng kê.
- Loyalty header responsive tách refresh khi width nhỏ/text lớn, giữ key và 48dp. Available vẫn từ read-only quote probe bằng minTopUpVnd tại composition, không từ max_points. `/loyalty` vẫn private, không autoDispose; screen theo notifier hiện tại, route/foreground và auth/request generation/cancel guards không đổi. Không endpoint T149, reserved/history/expiry model mới.
- Top-up chọn label review chỉ khi form đủ điều kiện và payable hiện chưa biết, sau nhánh creating/retry hiện có. `_controller.create(shownPayableVnd: payable, isSourceVisible: ...)` và status/continue payment không đổi. Exact maximum dùng nguyên max discount; arbitrary partial vẫn chờ GET amount_paid. 422 requote+clear, 409 resume, UUID/body, visible route/auth generation, cancellation, verified credited/refunded refresh và Return URL không xác nhận paid đều giữ nguyên.
- Harness chỉ ở tool/test: precache asset, chọn outer AppPage ListView thay inner TextField scrollable, ổn định geometry bằng bounded frame pumps, reset zero, force repaint render tree qua `markNeedsPaint`/`pump`, lấy snapshot qua `RenderRepaintBoundary.toImage`. Đối chiếu SDK local Flutter 3.44.2 `packages/flutter/test/rendering/proxy_box_test.dart` (capture/composite) và rendering `object.dart` (markNeedsPaint/flushPaint), không copy source ngoài hoặc sửa production DriverTaskPage/BrandMark. Pixel sample/decoded assertions pass nhưng còn thiếu app-bar chrome trong một số PNG; không coi chúng là chứng minh painted-header toàn bộ.

Nguồn visual người dùng: `stitch_powerme_ev_app_ui_design (6).zip`, SHA-256 `992a01cda61d5cbf501dbf5f06e496bc505a5ae3373ae9af02cc7db3165f8355`; ba HTML/PNG + DESIGN chỉ đọc, không thực thi script/CDN. Adapt composition/hierarchy native Flutter, không import Tailwind, fonts, assets hay policy của ZIP. Protected 9 lib và 4 PNG byte-identical; no new dependencies/config/backend/root-doc/diagram writes. Coordinator fresh-fetch main `86285d0ce3cc5ec485b46c630bef501d8f45248d`, mobile HEAD/main diff đã xác minh rỗng; Driver API contract diff rỗng theo coordinator, T149 chưa có. Không rebase/reset WIP.

Verification: format 180/0, analyze sạch, focused 50 + API 5, full confirmation 229/229 sau một test-helper viewport fix (initial 228/229, giữ log), 4 capture cases/174 PNG, offline Android debug build **30s**. Coordinator confirmed đúng bốn sửa UI trong một correction/confirmation, không thêm visual loop. Một số ảnh state/cuộn vẫn thiếu chrome app bar: `390-1x-vietnamese/loyalty-zero-01.png` và `390-1x-vietnamese/top-up-partial-unknown-summary-02.png`; zero đã có body title, pending GET/normal frames có logo. Decoded asset và các assertion lấy mẫu pixel pass không chứng minh mọi header PNG đã paint. Coordinator xác nhận bốn sửa UI đã đạt; không thêm vòng UI/capture. Chưa kiểm device/emulator/iOS, API đăng nhập staging, thanh toán thật hoặc NFR. Xem README cho actual logs/preview và screens cho FR/UC/BR/NFR trace; không nghiệm thu NFR bằng fixture/build.

## T145 — điểm khả dụng qua báo giá (20/11)

View 13 → FR-17, UC-PAY-03/04, BR-P34–37, NFR-SEC-01 → PKG-3 Loyalty/Payments/Profile/composition. `LoyaltyBalanceRepository.read(AuthScope): LoyaltyRead` trả `LoyaltyBalance(scope, availablePoints)` và cancel, không giả version/lots/reserved/history. `ApiLoyaltyRepository` chỉ gọi `DriverApiSession.quoteTopUp(principal, probeAmountVnd, cancel)`; `ApiApp` truyền `minTopUpVnd` hiện có. Không cần xe. Widget không có URL, HTTP hoặc mức probe riêng. `driverTopUpQuote` kiểm đủ ba số nguyên không âm/an toàn, max không vượt available và discount nhất quán; không áp minimum/rate/cap seeded tại client.

`LoyaltyController` giữ sống theo container như controller nạp, theo dõi auth scope/generation và request identity. Màn chỉ bật đọc khi route hiện và foreground; rời route/background/dispose hủy transport, xóa số cũ, bỏ response muộn. Resume/Back từ top-up tải mới. Screen theo notifier hiện tại qua `watch`, đồng bộ visibility sau build nên invalidate không giữ notifier đã chết. Sau GET `credited` hoặc `refunded`, Payments chỉ gọi refresh nếu `ref.exists(loyaltyControllerProvider)`; không khởi tạo Loyalty hoặc làm GET tài chính lỗi khi chưa từng xem điểm. Không trừ/khôi phục điểm local và không tin Return URL.

`/loyalty` là private route ngoài shell, mở từ Tài khoản API; Back không stack về `/profile`; CTA tới `/credit/top-up`. DriverTaskPage/HeroCard/shared widgets, logo/fonts/palette và năm tab giữ nguyên. Runtime cũ được chuyển sang `test/support/preview_loyalty_*`; public snapshot/lot contracts cũ giữ cho shared fixture. Không runtime mock fallback. UI có số 0 thật/loading/error/retry và trợ giúp; không các trường chưa được API cung cấp.

Top-up chỉ kiểm điểm dạng số không âm trong live `quote.maxPoints`; `maxPoints == 0` ẩn input. Server 422 quyết định minimum/availability/cap, tải lại quote và xóa lựa chọn. Không suy tỷ lệ từ max_discount/max_points: selection bằng maximum dùng trực tiếp max_discount, selection khác chờ GET amount_paid trước nút tiếp tục. Auto-open vẫn chỉ new 201 + GET đã xác minh + cùng visible route/auth + đúng số tiền đã hiển thị + URL còn hạn; 0 điểm giữ luồng cũ. Stable UUID/body, 409 pending/recovery, hạn link và status polling giữ nguyên.

Đã đọc source/tests trước implementation; áp dụng khái niệm, không sao chép source, thêm dependency hoặc chạy code ngoài:

| Nguồn ghim / license | Fit, dependencies, maintainability | Áp dụng / tradeoff / security |
| --- | --- | --- |
| [Dio cancel_token.dart](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/dio/lib/src/cancel_token.dart), [cancel tests](https://github.com/cfug/dio/blob/f1bef462289b40992d625d4eb2a2f42321217573/dio/test/cancel_token_test.dart), MIT | Dio 5.9.2 đã khóa; cancel trước/interceptor/nhiều request, dùng lại DriverApiSession và shared refresh | Token riêng cho read, hủy I/O khi mất visibility/auth. Transport cancel không đủ bảo đảm state nếu response đã về; vẫn cần identity/scope guards. Không đưa Bearer vào widget hoặc client riêng. |
| [Riverpod ref.dart](https://github.com/rrousselGit/riverpod/blob/cca264d8d6eeacfd0e650f89c8c1c3017ae4c75c/packages/riverpod/lib/src/core/ref.dart), [ref tests](https://github.com/rrousselGit/riverpod/blob/cca264d8d6eeacfd0e650f89c8c1c3017ae4c75c/packages/riverpod/test/src/core/ref_test.dart), MIT | Riverpod 3.4.3 đã khóa; onDispose/mounted/exists có sẵn, không thêm cơ chế lifecycle ngoài | Scoped repo/controller thay coupling balance với Payments controller: không kéo UUID/payment state vào màn chỉ đọc; đổi lại thêm interface nhỏ. `mounted` không hủy transport; onDispose + captured scope/request, visibility và notifier hiện tại vẫn bắt buộc. Server tiếp tục kiểm ownership. |

Lịch sử và điểm sắp hết hạn chờ API T149; đảo điểm khi sửa/hoàn phiên còn thiếu nghiệp vụ backend riêng. T149 chỉ bổ sung route riêng xem số dư/lịch sử/điểm sắp hết hạn, không hứa fields lots/reserved. Quote không reserve điểm; mô hình reserved chỉ dùng trong legacy test fixtures; các diagram CD-2/SD-2b/SD-2e là nghiệp vụ backend, không được suy thành endpoint mới. Statement `earned_points` hiện có giữ nguyên authoritative; không tính earn hoặc rounding. Local verification: 21 file format sạch, analyze sạch, 30 focused + 8 vehicle regression và 228 full pass; capture confirmation 4/4 (32 PNG) review đạt; Android debug offline build thành công (1m 2s). Xem [screens](screens.md) và README cho paths/logs; fixture/build không chứng minh authenticated read staging/device/emulator/iOS/NFR. Các kiểm đó chưa thực hiện. Guide T145 ngày 19/11 nêu giới hạn VNPay staging/T140, chưa được xác minh lại.

## T96 — bốn chế độ, Stitch ZIP (5), 19/11

Extension giữ `Screen → Controller → Domain repository ← API adapter`, WF01 `StartRequest(scope, connectorId, vehicleId, mode, limitValue?, key)` và enum `autoFull/timed/energy/cost`. `ApiChargeStartRepository` chuyển đúng shape §17 sang `full/timed/energy_kwh/amount_vnd`; full bỏ trường limit. Integer dương trong miền JS an toàn, cap 0 hợp lệ nhưng không Apply; cap khác mode/số sai kiểu/mode trả về mâu thuẫn là uncertain. `maxLimitValue` có đơn vị của request. Energy 0.13 không có các field 0.14 vẫn được đọc; chỉ thiếu field mới được xem là legacy, null/lạ không được coi là mode hợp lệ.

`ChargeStartDraftController` giữ mode/input theo `DiscoverySession` và connector, reset khi auth/xe/cổng đổi. Attempt giữ draft đã gửi để `edit()` khôi phục sau kết quả từ chối/cap; chỉ cùng scope, xe, connector, không busy và chưa effect. `clear()` giữ hành vi quét lại. `acceptLimit` giữ mode và tạo key mới, `resend` dùng chính request bất biến. `pauseStatusReads()` hủy GET qua token và bỏ kết quả đã mất quyền hiển thị; POST đang chờ vẫn giữ key và kết quả cho recovery.

`QrConnectScreen` dùng `listenManual` để lập lịch điều hướng sau frame. Đích chỉ lấy từ attempt đã xác nhận; route/mounted/foreground/scope/vehicle/attempt được đối chiếu lần nữa ngay trước `go('/charge-session')`. Xác nhận ở background được giữ chờ resume khi vẫn ở QR; rời route xóa chuyển màn đang chờ. Listener không tự chạy lại với snapshot đã started khi QR được tạo lại sau Back. Lối mở lại chỉ phục vụ phiên đã biết. Không HTTP trong widget hoặc thay router global.

`ChargeProgress` bổ sung `billingMode?`, `limitValue?` (null/phút/Wh/VND), `elapsedSeconds?`, `costEstimateVnd?`, `ChargeCostQuality(exact,interpolated,unknown)` và `ChargeCostClock(cp,cpOffset,csms)?`; `estimatedCostVnd` vẫn là maximum riêng. Adapter kiểm integer/timestamp, bảo toàn unknown và không dùng maximum làm money progress. `withStartContext` chỉ bổ sung mode/target khi field billing_mode thiếu và controller đã có StartRequest của đích xác nhận. Mode trả về khác mode/limit request không ghi đè progress đã biết. Không dùng điện thoại làm đồng hồ cutoff hoặc tính tiền. GET statement vẫn chỉ sau chốt meter + closed/reconciled + posted, cùng principal/session.

Nguồn code/tests được ghim theo commit ở bảng dưới; API public đã đối chiếu với cache khóa Riverpod 3.4.3/go_router 16.3.0. Áp dụng khái niệm lifecycle/navigation vào code PowerMe, không sao chép source hoặc thêm dependency:

| Nguồn, giấy phép | Fit, dependencies, maintainability | Cách áp dụng và tradeoff/security |
| --- | --- | --- |
| [Riverpod widget_ref.dart](https://github.com/rrousselGit/riverpod/blob/cca264d8d6eeacfd0e650f89c8c1c3017ae4c75c/packages/flutter_riverpod/lib/src/core/widget_ref.dart), MIT | Có sẵn; listenManual dành cho initState, tự đóng subscription khi widget dispose | Listener cục bộ không cần provider/router toàn cục mới. Vẫn cần kiểm scope, route và response muộn; lifecycle thư viện không thay quyền sở hữu server. |
| [go_router router.dart](https://github.com/flutter/packages/blob/b16aef16bc4fe24dbcadf081cf139f6edfe6750d/packages/go_router/lib/src/router.dart), [router tests](https://github.com/flutter/packages/blob/b16aef16bc4fe24dbcadf081cf139f6edfe6750d/packages/go_router/test/go_router_test.dart), BSD-3-Clause | Có sẵn; API go/pushReplacement và stack được maintained trong Flutter packages | `go` dùng route shell hiện hành, Back fallback QR đã có. Tránh giữ pending screen như bước phải bấm tiếp. State attempt sống ngoài route; URL không cung cấp session tùy ý và không bypass auth guard. |

Stitch HTML/PNG chỉ làm visual reference read-only ở `.cache/stitch-charge-modes-5`; không chạy script/timer/random của HTML, không tải font/ảnh ngoài hoặc thêm WebView. Sai khác nghiệp vụ và evidence ở design-system/README; diagrams/root docs/backend giữ nguyên.

**Đọc bắt buộc trước coding**, cùng [screen/function requirements](screens.md). File này là canonical reference kiến trúc mobile. README là cách chạy; `mb-01-foundation.md` là record nghiên cứu/baseline cũ, không được ghi đè reference này.

## Authority và cách dùng

Đọc nguyên [PKG-3_mobile](../../../diagrams/report4/package/PKG-3/PKG-3.puml), [WF01-class](../../../diagrams/report4/class/CD-1/CD-1.puml) và [WF01-seq](../../../diagrams/report4/sequence/SD-1a/SD-1a.puml), sau đó matching [SRS](../../../docs/requirements/report3-srs.md) / [registration v1.3 candidate](../../../docs/requirements/registration-form-v1.3.md). Không sửa diagram theo code hoặc copy policy từ app cũ. Mỗi slice ghi view/FR/UC/BR/NFR, class/signature/package tác động, dependency/DEC, expected states/test trước implementation; cập nhật tiến độ trong screens.md sau kiểm.

PKG-3 là hướng phụ thuộc; WF01 là logical class design của Stations/Charging, không phải toàn bộ UML Profile/Payments. ProfileRepository/ProfileController là project-specific adapter/controller phục vụ slice account, không giả là class có trong WF01. Nếu cần mở rộng model để render detail, ghi field bổ sung rõ thay vì thay tên/signature class nguồn. Không tạo stub 8 feature hoặc fake generated DTO chỉ để đủ tầng.

## Package đúng PKG-3

| Package diagram | Folder / trách nhiệm | Phụ thuộc công khai |
| --- | --- | --- |
| App composition / router | `lib/app`, `app/composition`: ProviderScope, chọn adapter/store/scope, go_router, lifecycle | Wire features/API/realtime; không business policy |
| Auth | `features/auth/{domain,application,presentation,data}` khi cần; login/consent; `domain/auth_scope.dart` | Public AuthScope cho Stations/Charging; credential chỉ auth adapter |
| Profile | `features/profile`: own driver/vehicle, selected vehicle/compatibility | Stations/Charging đọc model/state public; không import Profile data |
| Stations | `features/stations`: discovery, detail, suggestions | Public Profile vehicle + AuthScope + StationRepository; Charging/Support nhận connector reference public |
| Charging | `features/charging`: command/session/progress | Profile vehicle, Stations connector, Payments credit; interface/realtime |
| Payments | `features/payments`: credit/top-up | Loyalty public contracts; cùng backend WP2/WP5, không API WP5 riêng |
| History | `features/history`: statement/invoice/ledger | Authorized business API, không tự suy financial truth |
| Loyalty | `features/loyalty`: points/redeem/expiry/reversal | Business API; không tính rate tại UI |
| Support | `features/support`: fault report | Stations connector public; saved acknowledgement |
| Shared UI | `lib/core/{theme,widgets,l10n}` | Theme/widgets/formatters; không repository/DTO/HTTP/OCPP |
| API adapter | `features/<feature>/data` khi tích hợp | Implements domain interface, map committed WP2 OpenAPI; client chỉ business API |
| Realtime adapter | Chưa triển khai; place khi slice session cần | SessionRealtimeAdapter.watch/close; không direct OCPP |

Nguồn backend PKG-3: WP2 CSMS, WP4 ranking, WP5 money/points. Theo **candidate v1.3 26/10 chưa duyệt**: WP2 status/time-left, WP4 suggestion/RQ2. Không gộp status/time-left vào WP4 theo guide cũ hoặc gọi candidate đã approved.

```text
lib/
  app/                    # root/router
    composition/          # adapter/store/scope selection
  core/theme/ widgets/ l10n/
  features/<feature>/
    domain/               # Dart thuần: entities/enums/interfaces
    application/          # Riverpod controllers/providers/intent/state
    data/                 # adapter implements interface, no widget import
    presentation/         # render + intent, no mock/DTO/HTTP/policy
  demo/                   # internal local fixture/store only
```

`Screen → Controller → Repository interface ← Adapter`. Composition injects adapter; controller không tạo mock, screen không inline filter dataset. Widget không tính tiền/credit/points/rank; display formatting đơn vị/ICT được phép. Giữ thư mục scaffold rỗng người dùng; không cần tạo class rỗng.

## Exact WF01 class contract

Tên/case Dart enum map ở bảng sau; `Future`/nullable/units phải giữ. Dòng ghi **pending** chưa phải runtime đã có.

| Class | Fields/signatures trong diagram | Status hiện tại |
| --- | --- | --- |
| `StationsController` | `repository: StationRepository`, `scope: AuthScope`; `find(vehicleId: String, query: String): Future<void>`; `suggest(vehicleId: String): Future<void>`; `clear(): void` | Đã kiểm async find/clear/filter, late query/scope generation/current vehicle/dispose guard; suggest chưa hỗ trợ, phải báo unsupported, không trả fake ranking |
| `StationRepository` | `find(vehicleId: String, query: String): Future<List<StationOption>>`; `suggest(vehicleId: String): Future<List<StationOption>>` | Interface có 2 signatures; mock find đọc injected store, vehicle ownership/compatibility; suggest unsupported. `getById(id): Station?` là extension read-only cho detail local, không endpoint WP2 giả |
| `StationOption` | `connectorId: String`, `status: StationStatus`, `updatedAt: DateTime`, `rank: int?`, `estimatedTariffVndPerKwh: int?`, `etaSeconds: int?`, `waitingSeconds: int?`, `suggestionReason: String?` | Có domain model; optional values giữ null. `station: Station` là field bổ sung grouping/detail; không thay connector identity |
| `AuthScope` | `principalId: String`, `generation: int` | Value object Dart; fixed local scope injected để test guard; **không phải auth/login** |
| `ChargingController` | `repository`, `scope`, `session: SessionSnapshot?`, `command: CommandOutcome?`; `start(request): Future<void>`, `stop(sessionId,key): Future<void>`, `resync(sessionId): Future<void>`, `recover(key): Future<void>`, `apply(snapshot): void`, private `isCurrent(snapshot): bool`, `dispose(): void` | Pending toàn bộ; không shell UI giả |
| `ChargingRepository` | `start(StartRequest): Future<CommandOutcome>`; `stop(sessionId:String,key:String): Future<CommandOutcome>`; `outcome(key:String): Future<CommandOutcome>`; `snapshot(sessionId:String): Future<SessionSnapshot>`; `watch(sessionId:String): Stream<SessionSnapshot>` | Pending |
| `ApiStationRepository` | `scope: AuthScope`; same `find` / `suggest` as StationRepository | Pending WP2 OpenAPI, không fallback API failure sang mock |
| `ApiChargingRepository` | `scope: AuthScope`, `realtime: SessionRealtimeAdapter`; same start/stop/outcome/snapshot/watch as ChargingRepository | Pending |
| `SessionRealtimeAdapter` | `watch(scope: AuthScope,sessionId:String): Stream<SessionSnapshot>`; `close(): Future<void>` | Pending, không claim local stream đã có |
| `StartRequest` | `scope:AuthScope`, `connectorId:String`, `vehicleId:String`, `mode:ChargingMode`, `limitValue:int?`, `key:String` | Pending; limit có unit theo mode; key principal-scoped/stable |
| `CommandOutcome` | `scope`, `commandId:String?`, `requestKey:String`, `status:CommandState`, `sessionId:String?`, `reasonCode:String?`, `version:int` | Pending; accepted là receipt, không effect |
| `SessionSnapshot` | `scope`, `sessionId:String`, `version:int`, `observedAt:DateTime`, `state:SessionState`, `settlement:SettlementState`, `energyWh:int?`, `estimatedCostVnd:int?`, `availableCreditVnd:int?`, `socPercent:int?`, `elapsedSeconds:int?`, `connectionState:ConnectionState`, `paymentMode:PaymentMode`, `quality:DataQuality`, `statement:Statement?` | Pending; không gom connection/quality/settlement vào lifecycle |
| `Statement` | `scope`, `sessionId:String`, `version:int`, `debitVnd:int`, `balanceVnd:int`, `earnedPoints:int` | Pending; session statement khác top-up invoice |

Station/StationConnector hiện là model hỗ trợ UI ngoài logical WF01: name/address/VinFast-only/connector type/powerW/quality; không nguồn policy mới. **Mỗi connector có own status + updatedAt/quality**; find trả option từng connector compatible; application StationListing nhóm station, đếm available observed từ các options, không suy từ connector đầu tiên. Mixed busy-first/free-second được test. Compatibility theo selected vehicle, không cùng CCS2 là đủ cho mọi provider restriction. BR-P03 override non-VinFast cần riêng slice nếu chưa làm; ghi pending, không âm thầm bypass.

## Exact enums / mapping

| UML | Dart / wire mapping |
| --- | --- |
| StationStatus: Available, In use, Freeing soon, Unavailable, Offline | `available`, `inUse`, `freeingSoon`, `unavailable`, `offline`; không status thứ sáu cho stale |
| SessionState | `pending, active, paused, stopping, closed, reconciled, orphaned, review, failed, unknown` |
| SettlementState | `pending, posted, review, notApplicable, unknown` |
| CommandState | `requested, accepted, rejected, unknown` |
| ChargingMode | `autoFull, timed, energy, cost` |
| ConnectionState | `online, offline, unknown` |
| PaymentMode | wire `csms_billed, station_wallet, free, unattributed, unknown`; Dart camelCase map ở data adapter khi triển khai |
| DataQuality | `observed, stale, unknown`; shared metadata type, không đồng nghĩa trụ offline |

Chỉ Stations/quality enums đã được thêm trong slice discovery; các enum Charging là contract pending, không claim file đã tồn tại. UTC lưu/ICT hiển thị; integer VND/Wh/W/seconds. Unknown nullable không render thành 0, không cumulative summing. Power UI kW chỉ formatting từ W, không financial calculation.

## Extension bản đồ UI — 30/10

Yêu cầu trực tiếp mới: Discover `/` mở bản đồ trước; chạm pin → thẻ trạm → preview đường đi, hoặc Gợi ý → nhập pin/target → kết quả → đường đi trong app. Chỉ local UI, không đổi backend/shared diagram hoặc tuyên bố thêm routing engine. Đây là extension Stations trong PKG-3; giữ nguyên chữ ký `StationRepository.find/suggest` và các controller WF01 hiện có.

- Domain thuần Dart `station_route.dart`: `MapPoint`, `MapRoad`, `RoadMapScene`, `RoadRoute`; enums `TrafficLevel(clear,slow,unknown)` và `RouteReachability(reachable,insufficient,unknown)`. Điểm là tọa độ tương đối trên sơ đồ, không latitude/longitude. Distance integer m, travel/delay integer seconds, pin nullable percent, timestamp UTC. `StationOption.roadRoute?` bổ sung metadata hiển thị; không thay station/connector/session enums.
- Optional capability `StationRouteRepository.mapScene` và `route(vehicleId, stationId, battery): Future<RoadRoute?>` do adapter Stations thực hiện. Adapter không hỗ trợ/route thiếu → null/unavailable; không đường nối thẳng tự sinh. `roadMapSceneProvider` chọn capability từ repository đã inject. Không tạo mock tại controller/widget hoặc thêm dependency.
- `StationRouteController` giữ station selection, loading/requested/error/route; request sequence + captured auth generation/current vehicle + mounted loại response muộn. Select/clear/auth/vehicle/repository change invalidate route cũ. `RoadMapCanvas` chỉ project tọa độ để paint và nhận select/pan/zoom; `RouteSummary` chỉ format/render. Không tính khoảng cách địa lý, traffic, pin, ranking hoặc tiền trong widget.
- MockStationRepository cung cấp scene/tuyến theo fixture của từng trạm, ETA có delay, traffic segments, battery-use fixture và kiểm scope/vehicle. Đây không là mô hình tiêu hao hoặc routing được kiểm chứng; adapter tương lai phải trả dữ liệu từ business service. Route không có battery/model thì giữ unknown; không đổi null thành 0. Battery phần trăm chỉ dùng cho request, không lưu history.
- `SuggestionMode.nearest` là **extension UI theo yêu cầu trực tiếp**, adapter fixture xếp theo khoảng cách đường bộ của các trạm phù hợp; `fastest` giữ tổng travel + wait + charge, `cheapest` giữ cost. UI không sort/rank. `SuggestionState.batteryPercent` giữ input của lượt search đã trả kết quả; nút đường đi dùng giá trị đó, không dùng nội dung field mới sửa sau search.
- Existing ShellRoute vẫn ba tab. Suggestions route đọc riêng `mode=nearest` enum allowlist; kết quả gọi controller rồi về `/`, không mở URL bên ngoài. State route scoped giữ khi chuyển tab, camera transform cục bộ có thể reset. Detail/start/hold/manual code/credit/profile/history vẫn đến được, không start/hold tự động khi xem map.
- SRS §3.7 cho phép fallback khoảng cách thẳng/30kmh và handoff Navigate sang map app. **Yêu cầu trực tiếp 30/10 ghi đè chỉ cho UI slice này**: preview nội bộ theo đường bộ, không fallback đường chim bay; thiếu road route thì unavailable. Shared SRS/contract/backend chưa thay đổi, provider còn chưa chọn; không coi UI là FR-21/NFR nghiệm thu.

Research/pinned sources, comparison/license/adaptation: [map UI research](map-first-research.md). Không key GPS/maps/provider, network hoặc SDK bản đồ thật; không turn-by-turn/live traffic. Bản đồ local không bảo đảm vị trí/đường thực ngoài đời.

## Composition / trạng thái hiện tại

### 30/10 — ba tab, không đổi lifecycle nghiệp vụ

`ShellRoute` hiện có chứa `/` (Discover), `/charging` (Charging), `/profile` (Account). Cùng một `_PrivatePage`/auth-generation guard bao quanh shell; form/detail/checkout vẫn là route riêng. Tap tab chỉ `go` sang route, tap tab đang chọn là no-op. Không gọi start/stop/restore/recover hoặc tạo ProviderScope trong shell. ChargingController là NotifierProvider giữ sống theo scope hiện có: stream tiếp tục khi sang tab khác, logout/switch scope vẫn cancel/clear; không thêm lifecycle/subscription trong ActiveSessionScreen. View Phiên sạc bỏ back và link “Về tìm trạm”, dùng bottom nav để chuyển.

Giữ ShellRoute thay StatefulShellRoute/indexed stack: đã đủ ba đích cấp cao và state nghiệp vụ nằm ngoài widget; tránh giữ thêm ba navigator/stack và thay cả router. Đánh đổi: scroll/map toggle cục bộ của Home có thể reset khi chuyển tab; query/filter và phiên/lệnh vẫn do scoped controller quản lý. Không cam kết khôi phục qua process restart hoặc backend trước khi có tích hợp.

Research trước sửa: đọc source [ShellRoute example](https://github.com/flutter/packages/blob/9ec29b6d23e79e8cb83a29ad29311c903d7cd07d/packages/go_router/example/lib/shell_route.dart), [test chuyển tab/detail/back](https://github.com/flutter/packages/blob/9ec29b6d23e79e8cb83a29ad29311c903d7cd07d/packages/go_router/example/test/shell_route_test.dart) và phần GoRoute/navigator-key trong [route.dart](https://github.com/flutter/packages/blob/9ec29b6d23e79e8cb83a29ad29311c903d7cd07d/packages/go_router/lib/src/route.dart). Commit `9ec29b6d23e79e8cb83a29ad29311c903d7cd07d`, go_router 16.3.0 đã lock; Flutter packages chính chủ, BSD-3-Clause ([license](https://github.com/flutter/packages/blob/9ec29b6d23e79e8cb83a29ad29311c903d7cd07d/packages/go_router/LICENSE), notice local giữ nguyên). Áp dụng mô hình shell chứa navigator + path-selected tab, viết code/test riêng theo PowerMe; không copy nguyên example, chạy code nguồn hay thêm dependency. Route guard không thay ownership/authorization server. Test upstream dùng `example/test/shell_route_test.dart`; đường dẫn `test/shell_route_test.dart` thử trước trả 404 nên không dùng làm bằng chứng.

### Historical snapshot — groups 2–4 local implementation, 29/10

- Exact WF01 ChargingController/ChargingRepository/StartRequest/CommandOutcome/SessionSnapshot/Statement and typed enums now exist. Controller owns prepare/start/stop/resync/recover/apply/dispose, scope/session/version guards and subscription lifecycle. `ChargingPreparation.preview/current`, StartPreview, connectorLabel, stopReason, pauseCause and tariff segments are local extensions. `statementProvider` resolves owned snapshots in the application layer; screens do not call adapters directly.
- StationsController.suggest calls StationRepository.suggest. The optional StationSuggestionPreferences interface supplies fixture battery/target/mode settings; SuggestionController orchestrates it. StationActionsRepository plus ReservationController handle canonical QR/manual resolution, quote/hold/cancel/expiry/void. SupportController handles stable-key saved acknowledgments; its label provider uses public station metadata to show a human connector label.
- PaymentsController → PaymentsRepository owns credit/order/checkout/query/closure request. HistoryRepository and LoyaltyRepository expose owned HistorySnapshot/TopUpOrder and LoyaltySnapshot/PointLot/PointMovement through scoped application providers. These are PKG-3 feature extensions, not classes falsely attributed to WF01 UML. Top-up, settlement and invoice states remain distinct.
- Composition selects mock adapters and shared in-memory stores, with separate clock-driven charging/payment engines under `lib/demo`. Widgets submit intent and render snapshots; repository queries do not run the engines. Local streams and timers are fixtures, **not SessionRealtimeAdapter/Socket.IO, APIs, Unity or OCPP integration**. ApiStationRepository, ApiChargingRepository and the real realtime adapter remain pending. No generated WP2 contract or endpoint was invented.
- Command acceptance does not set active; unknown keeps its original key. Local engines confirm active/closed/reconciled and separate verified/posted/invoice states. A stopped/failed intent releases its connector; authoritative settlement controls debit/statement/earn. UI shows pending settlement only for closed/reconciled/review states. Shared stores enforce once-only ledger and point references; real server transactions/authorization are still required.

Final evidence and limitations are in README; the earlier pending rows describe the original baseline only. No shared diagrams changed.

### Historical snapshot — group 1 extension, 29/10

- `AuthRepository.restore(): Future<String?>`, `signIn(email,password): Future<String>`, `register(Registration): Future<String>`, `signOut(): void`; `AuthController` owns restoring/busy/failure/scope and monotonically increasing generation. Repository does not create auth scope or navigate. Mock auth validates in-memory accounts, atomically stores registration/consent and revokes pending work on logout. No real restore/refresh/secure storage/API auth.
- `Vehicle(id,brand,model,connectors)`, derived `isVinFast`; `DriverProfile` holds owned vehicles, selected ID, email/name/language and revision. Empty selected vehicle is explicit. `ProfileState(profile,busy,failure)` wraps view state. `ProfileRepository` adds async `updateName(name,revision)`, `saveVehicle(draft,id?,revision)`, `removeVehicle(id,revision)`, `selectVehicle(id,revision)` returning `DriverProfile`; read/language remain synchronous local operations. This is project-specific PKG-3 work, not an invented WF01 class signature or WP2 endpoint.
- Composition binds store/adapters to `AuthScope`; `localScopeProvider` is an alias of public `authScopeProvider`. Private providers rebuild on scope change; adapters check principal/generation before reads/writes. Controllers guard pending responses with captured scope/request/dispose. Mutations enforce expected revision and owned IDs; local UI suppresses duplicate submit. Name/language changes do not reset station search; selected vehicle or connector changes refetch compatibility.
- Stable GoRouter refreshed from auth state; `/loading` precedes private views, login/register are public, only an allowlisted station path can resume after login. Private subtree keyed by principal/generation clears widget state. Routes add `/profile/edit`, `/vehicles/new`, `/vehicles/:id/edit`; query strings/external URLs never execute. Logout clears auth and adapter access immediately; real server authorization remains required.
- Consent receipt `powerme-consent-local-v1` + UTC time and eight-character password minimum are mock fixtures pending product/WP2 policy. No shared diagrams changed; existing enum extensions remain authoritative for app code. No dependencies added.

Evidence: 18 regression tests and one nine-image preview capture pass, analyzer clean; [research/trace](auth-profile-slice.md). No API/device/gateway/NFR certification.

Widget test và công cụ chụp ảnh dùng `DriverAppTestHarness → ProviderScope → PowerMeApp/GoRouter`. Harness và `FakeAuthRepository` nằm trong `test/support`. Một store dùng chung dữ liệu mock cho Profile, Stations, Charging và Payments trong các test tương ứng.

Profile language trong harness chỉ dùng custom app copy, chưa có MaterialApp.locale/delegates/persistence. Xem mục T96 bên dưới cho composition dùng Driver API.

## Guard / checks bắt buộc theo ranh giới

| Boundary | Guard | Evidence cần có |
| --- | --- | --- |
| Search | Request sequence + captured scope principal/generation + current vehicle; discard late responses; clear invalidate outstanding | Query A chậm sau B không overwrite; scope generation đổi giữa request bỏ response; vehicle switch refetch; dispose không write |
| Auth/private data (pending) | Mỗi login kể cả cùng principal generation mới; hủy requests/subscriptions, clear caches; route chờ restore | A→logout→B/cùng A đăng nhập lại, late refresh/event không phục hồi A; ownership API reject |
| Snapshot/events (pending) | principal/generation/session/version + authoritative resync gap/reconnect/foreground | Duplicate/out-of-order/gap; stale retained timestamp, unknown metrics; stream close |
| Commands/money (pending) | Stable keys, accepted≠effect, unknown≠failed; return≠paid; ledger server-owned | Retry same key; duplicate close/IPN; late verified payment; station_wallet/unattributed no auto-debit/earn |
| UI | Injected repo, loading/empty/error/retry, 5 statuses/update/quality, no unimplemented CTA | Search/filter/detail/account/language; no technical labels; focus/48px; 320px/200% Việt/Anh; preview correct fonts/image decoded |

Format/analyze/Flutter tests/web build chạy trực tiếp **nested `powerme/apps/mobile`**, TMP/TEMP ở E:/Project/PowerMe/.review. Không chạy outer checker trỏ standalone app cũ. Tests fixture không chứng minh device/backend/NFR. Sau mỗi slice cập nhật actual results README và status screens.md; docs không tự cho phép commit/push/deploy/real money.

## T96 discovery — 13/11

Review quyền vị trí: `DiscoveryContext` chỉ lưu điểm đi sau thao tác đồng ý, hủy cập nhật điểm đi cũ khi bỏ điểm, đổi xe hoặc tài khoản. `discoverySearchProvider` đối chiếu điểm đi với context và truyền quyền gửi PowerMe xuống repository. `StationDiscoveryRepository` yêu cầu `consentToVietmap` riêng cho tìm địa chỉ, lấy tọa độ từ địa chỉ và xem tuyến. Adapter chặn trước transport nếu chưa đồng ý. Quyền gửi Vietmap cho gợi ý vẫn gắn với điểm đi, bộ lọc và mức pin đã gửi. Client chỉ đóng gói hai config công khai, trong đó key Vietmap chỉ dùng cho Tilemap.

- Các màn Stitch của T96 dùng chung thành phần trình bày trong Stations. Bản đồ và danh sách đọc cùng một `DiscoverySearch`; chế độ hiển thị là state cục bộ. Xóa từ khóa giữ bộ lọc và về trang đầu. Bản đồ dùng tâm mặc định của app khi chưa có kết quả hoặc điểm đi. Tâm bản đồ chỉ dùng để hiển thị, không cấp tọa độ cho search, suggest hoặc route.

- `ApiApp` ghép `ApiStationRepository` vào `StationRepository`, thêm capability `StationDiscoveryRepository` cho trang kết quả, smart, địa chỉ và route. Chữ ký WF01 cho fixture vẫn giữ. `DriverApiSession.readForVehicle` dùng phiên Bearer hiện tại, kiểm xe thuộc snapshot `/me` và dùng lại refresh GET một lần cùng cancel khi phiên kết thúc. CSMS kiểm quyền sở hữu và tính tương thích. API mode mở Tài khoản/Thêm xe, Khám phá, gợi ý và chi tiết. Các provider fixture không được ghép vào ApiApp.
- `DiscoverySession` khóa provider request theo scope và ID xe mặc định. Khóa search còn có query, trang, bộ lọc, origin và SoC/target. Response cũ không thay kết quả hiện tại. Scope/xe đổi sẽ bỏ adapter/cache, lựa chọn và điểm đi. Chọn địa chỉ hoặc lấy vị trí có guard riêng cho lần yêu cầu. Detail snapshot đến từ kết quả người dùng chọn trong phiên hiện tại. Chưa có endpoint detail độc lập.
- `StationSearchPage` giữ các trạm theo thứ tự server. `StationSearchHit.bestConnector` trỏ bằng ID chuỗi opaque, phân biệt các trụ có cùng số cổng. Timestamp, công suất, địa chỉ và tọa độ có thể null. Chỉ trạng thái `available_now` từ backend được đếm là khả dụng. `DataQuality` và trạng thái unknown hiển thị riêng.
- `ApiSuggestionsScreen` hỏi pin hiện tại (không bắt buộc) và kiểm số hữu hạn từ 0% đến 100%, chấp nhận dấu phẩy thập phân. `SmartSearchInput.target` luôn dùng mốc nội bộ 80% trên màn này. Khi bỏ trống hoặc nhập từ 80% trở lên, adapter bỏ `soc_percent` để nhận danh sách trạm phù hợp và vẫn có thể gửi điểm đi cho CSMS. Lý do thiếu ước tính dựa trên lần gửi gần nhất. Khi pin từ 80% trở lên, màn giữ nguyên số đã nhập.
- Gợi ý hiện thông báo Vietmap khi có điểm đi và pin hợp lệ dưới 80%. App chỉ gửi `location_consent=true` sau khi tài xế bấm **Xem gợi ý** với hai điều kiện đó. Đổi điểm đi hoặc bộ lọc hủy xác nhận cũ. Thử lại dùng truy vấn đã gửi. Adapter đọc `ranking_source` và `road_estimate` nullable. Thẻ chỉ hiện km đường bộ và thời gian Vietmap khi nguồn là `vietmap_route` hoặc đã lấy tuyến riêng cho trạm đó. Brief tiếp tục dùng cho thứ tự dự phòng.
- `DiscoveryRoads` dùng chung tuyến đã lấy giữa thẻ trạm và chi tiết, theo tài khoản, xe, điểm đi, trạm và bộ lọc. Thẻ xin xác nhận trước mỗi yêu cầu tuyến mới. Đổi điểm đi hoặc phiên hủy yêu cầu và bỏ cache cũ.
- Shell dùng ba tab **Khám phá / Quét QR / Tài khoản** ở cả hai composition. API vào `/discover` sau đăng nhập hoặc đăng ký. Nút **Gợi ý** trong Khám phá mở `/suggestions`.
- `VietmapSurface` dùng pin từ tọa độ thật, điểm đi đã cấp phép/chọn và polyline địa lý từ `StationRoadRoute`. Viewport thế giới chỉ dùng để mở map khi chưa có điểm. Scene và `MapPoint` tương đối của fixture giữ trong harness. Nếu có Tile, map tự hiện ở Khám phá và cùng kết quả tuyến sau khi bấm xem đường. Camera fit vào dữ liệu hiện tại. Xem [giới hạn và quy trình smoke](t96-driver-api.md#5-kiểm-thử-tìm-trạm-và-gợi-ý-trên-emulator).
- T96 xem trước tuyến mở rộng `StationRoadRoute` với chỉ dẫn và giao thông tùy chọn. `ApiStationRepository` kiểm khoảng chỉ số theo `LineString`, chấp nhận một điểm cho chỉ dẫn và một điểm chung giữa hai đoạn nối tiếp. Bỏ mảng sai hình dạng hoặc chồng lấn mà vẫn giữ quãng đường và ETA. `RouteMapPreview` chọn chặng trong bộ nhớ, lấy điểm neo từ `startIndex` hợp lệ và chia sẻ biểu tượng hướng rẽ giữa banner với `VietmapSurface`. Trong hàng đợi theo controller/style, surface vẽ viền và dải màu đục bằng `addPolylines`, cập nhật symbol theo chặng và khôi phục khung toàn tuyến khi kết thúc. Chú giải ở trong khung và dùng xám cho đoạn thiếu dữ liệu. Khi bản đồ không khả dụng, nội dung và nút chặng vẫn hoạt động. App dùng ETA và thứ tự gợi ý do server trả.

## Vietmap UI extension — 30/10

Live map composition, foreground location repository/controller, config handling và giới hạn tọa độ được ghi tại [Vietmap setup/research](vietmap-setup.md). Không thay chữ ký StationRepository hoặc sơ đồ WF01; không project mapX/mapY lên bản đồ thật. Mục này ghi lại slice cũ. Widget test vẫn chọn surface Vietmap hoặc sơ đồ thông qua harness.

30/10 — Station.location: MapLocation? là extension thuần Dart cho hai trụ Đông Hòa được người dùng yêu cầu. MockStationRepository.observed giữ location khi map status. VietmapSurface chỉ render trạm có location từ StationsState.stations; canonical stationId qua onSelect gọi controller chọn trạm, dùng sheet/detail/start hiện có. Symbol queue + style epoch + tap listener cleanup quản lý lifecycle native; không thay interface find/suggest hoặc sơ đồ. Camera center không là vị trí GPS. Không vẽ roadRoute tương đối lên Vietmap. Kiểm chứng và giới hạn xem vietmap-setup.md/README.


### 30/10 — QR là tab giữa (yêu cầu trực tiếp)

ShellRoute bổ sung `/scan` cho Quét QR; `/charging` giữ nguyên màn phiên và vẫn chọn tab giữa. `/start` là route xác nhận riêng, không tự start. QR screen dùng QrConnectionController (extension Charging) → StationActionsRepository.resolve đã có → connectorId canonical → StartScreen. Không đổi WF01/class backend hoặc tạo API mới. Nhập tay và camera đi cùng resolver; chỉ chấp nhận mã đã hỗ trợ `station-id/number` hoặc `powerme:connector:station-id/number`, không mở URL tùy ý.

QrConnectionController loại response muộn khi auth/vehicle đổi, chặn duplicate/busy và pending/unknown/session chưa kết thúc. QR screen luôn có shortcut phiên nếu có command/session; không tạo key/start/recover khi vào tab. Camera chỉ mount trên top route `/scan` và foreground; dispose khi mở confirmation/session, đổi tab hoặc xuống nền. Serial release chờ pending permission/start trước stop/dispose. Permission error/retry và nhập tay có sẵn. Permission camera native chỉ sử dụng khi mở tab QR. Dữ liệu charging vẫn local; quét camera không đồng nghĩa tích hợp CSMS.

Dependency được người dùng duyệt: `mobile_scanner` pin 7.4.2 (Dart >=3.7, Flutter >=3.29, phù hợp SDK hiện tại). Research source thực từ archive pub: `lib/src/mobile_scanner.dart`, `mobile_scanner_controller.dart`, `test/mobile_scanner_widget/detect_barcode_test.dart`, `test/mobile_scanner_controller/dispose_test.dart`, pubspec/license. Nguồn: https://github.com/juliansteenbakker/mobile_scanner ; release https://pub.dev/packages/mobile_scanner/versions/7.4.2 . Source master/README chỉ để định hướng, implementation dựa archive 7.4.2; commit archive không cung cấp nên không tự ghi SHA. Chọn scanner thay tự ghép camera+decoder: ít glue native hơn, có QR-only/controller/permission/error; đổi lại thêm MLKit/CameraX và cần device validation. Không thêm gallery/upload/quyền ảnh, không lưu/log raw QR/frame. BSD-3-Clause của Julian Steenbakker, notice đầy đủ giữ THIRD_PARTY_NOTICES.md. Code PowerMe tự viết theo repository/lifecycle hiện có; test fake theo public platform interface để kiểm behavior, không khẳng định device pass.

### T96 — tra mã cổng trong API mode

`QrConnectScreen` dùng camera và form hiện có. API mode gọi `ConnectorLookupController` → `ConnectorLookupRepository.resolve(vehicleId, code)` → `DriverApiSession.readForVehicle`. Adapter trong `ApiApp` dùng Bearer của phiên và xe mặc định từ hồ sơ. Khi scope hoặc xe thay đổi, adapter hủy yêu cầu và controller bỏ phản hồi cũ. Tra mã chỉ đọc và trả tên trạm, mã trụ, số cổng, trạng thái và nhãn báo lỗi khi có. Harness giữ `QrConnectionController` và màn xác nhận riêng.

Dùng lại lifecycle QR của [mobile_scanner 7.4.2](https://github.com/juliansteenbakker/mobile_scanner/releases) (BSD-3-Clause) và GET có query/cancel của [Dio 5.9.2](https://github.com/cfug/dio/tree/main/dio) (MIT), đối chiếu controller/widget tests và `dio_mixin.dart`/`cancel_token_test.dart` từ hai gói khóa. Adapter dùng phiên Driver API sẵn có để tập trung kiểm quyền xe và refresh. Mở URL từ QR sẽ bỏ qua ranh giới này. Không sao chép mã thư viện.

### T96 — bắt đầu sạc từ kết quả QR

Theo PKG-3, panel QR gửi thao tác xác nhận đến `ChargeStartController`. Controller đối chiếu `ResolvedConnector` với kết quả tra cứu và xe mặc định của `AuthScope` hiện tại, sau đó tạo `StartRequest` (mode `ChargingMode.energy`, hạn mức Wh). `ApiApp` ghép `ChargeStartRepository.start(StartRequest)` và `read(StartRequest)` với `ApiChargeStartRepository`. Cả hai trả `ChargeStartSnapshot` từ Driver API.

`DriverApiSession` giữ Bearer và cancel theo phiên. POST dùng cùng body/key nếu 401 cần refresh một lần. Controller giữ một yêu cầu bất biến theo auth generation trong bộ nhớ, kể cả khi đổi tab hoặc xe mặc định. Xác nhận hạn mức mới chỉ áp dụng cho xe ban đầu. Đăng xuất xóa yêu cầu và loại phản hồi cũ. Khi QR đang hiện và app ở foreground, panel tự đọc trạng thái yêu cầu theo key mỗi 1,5 giây trong 135 giây đầu, sau đó mỗi 5 giây, với tối đa một lần đọc đang chờ. Khi có `session_id` và `effect_confirmed: true`, QR chuyển sang đọc progress mỗi 5 giây để theo dõi kết thúc phiên. Chỉ progress từ backend khớp phiên đã xác nhận và `AuthScope` hiện tại, có chỉ số chốt và trạng thái `closed`, `reconciled`, `review` hoặc `failed`, mới xác nhận kết thúc. Màn Theo dõi phiên giữ bảng kê đã tải cho đến khi tài xế rời màn. **Về Quét QR** hoặc Back từ màn phiên mở máy quét mới khi đã xác nhận kết thúc, còn phiên đang hoạt động hoặc chưa xác định vẫn giữ khóa yêu cầu. Snapshot sai intent, cũ hơn hoặc mâu thuẫn không thay thế trạng thái đã biết. Trạng thái phiên xác nhận có thể đổi cùng version của intent. Xem [hợp đồng, nghiên cứu và kiểm thử](t96-driver-api.md#7-bắt-đầu-sạc-từ-qr).

### T96 — theo dõi phiên và bảng kê

`/charge-session` lấy đích từ yêu cầu QR đã xác nhận thuộc `AuthScope` hiện tại. `ChargeSessionController` dùng `ChargeSessionRepository.progress(target)` và `statement(target)`. `ApiApp` ghép adapter qua `DriverApiSession` sẵn có. Adapter chỉ nhận ID phiên thập phân dương trong miền số nguyên an toàn BE-22 và đối chiếu ID trả về. Bảng kê còn phải khớp principal.

`ChargeProgress` và `PostedChargeStatement` đọc hợp đồng BE-22 và dùng lại `SessionState`, `SettlementState`, `ConnectionState` và `DataQuality`. Progress dùng `updated_at` thay cho version vì API không có version. Cùng timestamp vẫn có thể chứa số đo mới. Số dư, SoC và thời gian còn lại nằm ngoài dữ liệu hiển thị của BE-22. Controller dừng/hủy I/O khi rời màn, ra nền hoặc đổi scope. Chuyển từ poll sang đọc bảng kê khi progress vừa xác nhận chỉ số chốt, trạng thái đã dừng/đối soát và quyết toán `posted`. Màn QR vẫn dùng luồng kiểm tra yêu cầu bắt đầu khi cần mở lại thao tác quét. Xem [hợp đồng và kiểm thử](t96-driver-api.md#8-theo-dõi-phiên-và-bảng-kê).

## T96 slice 1 — API mode

`main.dart → ApiConfig.load(rootBundle) → ApiApp`. Composition đọc `API_BASE_URL` và `API_CONSENT_VERSION` tùy chọn từ `config/api.local.json`. Debug chỉ cho HTTP tới host tunnel được phép, profile/release yêu cầu HTTPS. Cấu hình thiếu hoặc không hợp lệ mở màn hình lỗi kết nối. `lib/main.dart` là entrypoint của app. Xem [lệnh chạy và điều kiện backend](t96-driver-api.md).

`ApiApp` injects `ApiAuthRepository` và `ApiProfileRepository` vào Riverpod. Hai adapter chia sẻ `DriverApiSession` với Dio và DTO `/me` ở `core/api`. `AuthRepository` giữ nguyên signatures; optional `AuthSessionEvents` báo hết phiên hoặc bị chặn để `AuthController` xóa scope. `ProfileRepository.read()` đọc snapshot đã bootstrap sau auth; optional `RefreshableProfileRepository.refresh()` đọc lại cùng phiên. `ProfileController` giữ guard scope/request khi nhận kết quả. Xem [hợp đồng, nghiên cứu và retest](t96-driver-api.md).

## T96 slice 2 — quản lý xe

- API router mở `/profile`, `/vehicles`, `/vehicles/new`, `/vehicles/:id` và `/vehicles/:id/manage` cho hồ sơ đã đăng nhập. Chi tiết và quản lý đọc xe thuộc snapshot `/me`. `VehicleManagementRepository.listModels/addVehicle` dùng ID chuỗi. `ApiProfileRepository` dùng `selectVehicle/removeVehicle` để đặt mặc định và gỡ theo BE-34.
- `vehicleModelsProvider` theo scope và tự giải phóng khi rời form. `DriverApiSession` dùng chung lần refresh đang chạy cho GET và thao tác xe. POST/PATCH/DELETE xe chỉ gửi lại một lần sau `401 unauthorized` từ bước xác thực trước handler. Đổi phiên hủy I/O và ngăn gửi lại. Sau 201/200/204, app tải `/me` cùng phiên. Lỗi kết nối, 5xx hoặc lỗi tải `/me` không dẫn tới gửi lại thao tác ghi.
- `ProfileController` tuần tự hóa tải hồ sơ và thao tác xe. Mất phản hồi, 404 hoặc lỗi tải `/me` sau khi ghi khóa thao tác tới khi tài xế tải lại thành công. UI hiển thị snapshot cuối và dùng thứ tự/cờ mặc định do server trả. Đối chiếu [BE-34 và hướng dẫn kiểm thử](t96-driver-api.md#4-kiểm-thử-xe-qua-tunnel-api).
- `VehicleCatalog` lọc danh mục đã tải theo hãng và từ khóa không phân biệt hoa thường, giữ thứ tự API. Form giữ ID đã chọn độc lập với bộ lọc và đối chiếu danh mục hiện hành trước khi lưu. `ApiProfileRepository` chuyển thông số nullable từ `DriverVehicleModelResponse` sang `VehicleModel`; form đọc trực tiếp model để hiển thị.
- BE-38 thêm `imageUrl` và `imageCredit` nullable vào `Vehicle` và `VehicleModel`. DTO kiểm kiểu, chấp nhận thiếu trường ở bản API cũ và chỉ chuyển URL HTTPS thuộc Wikimedia theo hợp đồng. `VehiclePhoto` tải trực tiếp qua `Image.network`, tách khỏi Dio có Bearer. Asset mặc định hiển thị khi thiếu URL, đang tải hoặc tải lỗi. Credit được hiển thị nguyên văn cạnh ảnh, gồm preview mẫu xe đã chọn.

## T96 — tín dụng đọc và dừng thủ công

- `ApiApp` ghép `ChargingCreditRepository.summary(scope)` và `transactions(scope, page)` vào Payments qua `ApiChargingCreditRepository`. Hai provider đọc riêng, tự hủy theo màn và theo auth generation. `DriverApiSession` gắn Bearer của đúng principal, dùng cùng cơ chế refresh GET của app. Route riêng `/credit` dùng guard scope và chỉ nhận dữ liệu từ adapter API.
- `ChargeSessionRepository.stop(target, key, recovering:)` trả `ChargeStopOutcome` có kiểu. `ChargeStopController` khóa ý định theo phiên QR đã xác nhận, giữ cùng key khi mất phản hồi và giữ nó khi đổi route. `ChargeSessionController` tiếp tục chạy progress và quyết toán theo hợp đồng đã có. Transport stop dùng token hủy của auth session. Điều kiện cho yêu cầu mới nằm ở trạng thái progress và kết quả lệnh. [Chi tiết contract và nghiên cứu](t96-driver-api.md#9-tín-dụng-sạc-và-dừng-thủ-công).
- Danh sách route preview và hai adapter charging/payments mock được chuyển vào `test/support`. Harness giữ các fixture dùng chung cho start/stop, top-up, loyalty và history. Các fixture vẫn chạy được từ test/capture. Route production và preview dùng chung guard auth.


### T96 — năm tab trong Driver API mode

`ShellRoute` giữ Khám phá / Lịch sử / Sạc / Tín dụng / Tài khoản. Sạc dùng `confirmedChargeSessionProvider` có cùng `AuthScope`: mở `/charge-session` khi có target hoặc `/scan` khi chưa có. Đổi tab không giải phóng target đã dừng. Nút về QR hoặc Back trong màn phiên dùng `releaseFinishedSession` hiện có. Scanner và poller vẫn theo route foreground; các route chi tiết khác vẫn giữ phạm vi trước đó.

Lịch sử dùng cùng ledger provider có phân trang với Tín dụng và chỉ chiếu các dòng `session_debit`. Adapter giữ `session_id` nullable theo BE-22. Bảng kê mở từ dòng sổ cái đã tải, qua `ChargeSessionRepository.statement` và cùng auth generation, tách khỏi active target, GET progress và POST stop. Không khai báo route deep link bảng kê mới. Tham khảo [Flutter NavigationBar tests](https://github.com/flutter/flutter/blob/master/packages/flutter/test/material/navigation_bar_test.dart) về semantics và [go_router ShellRoute](https://github.com/flutter/packages/blob/main/packages/go_router/example/lib/shell_route.dart) về shared shell. Thanh Sạc là widget Material của PowerMe, không chép mã nguồn ngoài hoặc thêm dependency.

### T32 và FE-17 trong Driver API mode

- `CreditTopUpRepository.quote/create/status` dùng `DriverApiSession` theo hợp đồng §14. `CreditTopUpController` giữ UUID/body và ID giao dịch theo auth generation, hủy báo giá cũ, kiểm tra trạng thái tuần tự tối đa 12 lượt mỗi lần kích hoạt ở foreground. Kết quả GET `credited` làm mới cả số dư và họ provider sổ cái. GET 404 `not_found` xác nhận có thể bỏ theo dõi ID đó. Người dùng có thể tiếp tục từ cùng phiên đăng nhập sau khi quay về tab Tín dụng.
- Nút **Thanh toán qua VNPay** gửi yêu cầu idempotent. Chỉ phản hồi tạo mới 201 có thể mở trình duyệt từ lần GET xác minh ngay sau đó. Controller đối chiếu ID, số tiền nạp, điểm, số tiền phải trả đã hiển thị, trạng thái pending và hạn dùng của URL. Quyền mở một lần gắn với phiên đăng nhập và màn đang hiển thị ở foreground. Giao dịch có sẵn, lựa chọn điểm không có số tiền chính xác trong báo giá, số tiền thay đổi hoặc lỗi mở trình duyệt đều dùng nút tiếp tục/mở lại với số tiền từ GET và URL còn hạn.
- Cầu nối riêng `powerme/vnpay_checkout` chuyển URL ký nguyên văn sang Android ACTION_VIEW hoặc iOS UIApplication.open. Allowlist hiện gồm gateway sandbox đã được PowerMe cấu hình và VNPay công bố. App đọc kết quả từ CSMS, gồm trạng thái hoàn tiền. [Tài liệu VNPay Pay/IPN](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html).
- `ConnectorFaultReportRepository.submit` dùng §15 và một JSON `description`. `ConnectorFaultReportController` kiểm scope, xe, connector đang chọn và route trước khi gửi hoặc dùng ACK. Nếu `reported_issue` là true, đánh dấu cổng hiện tại và tải lại tìm kiếm. Chi tiết trạm và QR giữ nguyên tham chiếu ID dạng chuỗi.
- `CreditTopUpScreen` đọc số dư qua `chargingCreditProvider` và đưa lựa chọn nhanh vào cùng luồng báo giá. Khi dùng điểm, màn trạng thái hiển thị số tiền VNPay từ giao dịch đã đọc. `ConnectorFaultReportScreen` dùng biên nhận §15 và hiển thị riêng lỗi trùng 409, cổng không khả dụng và lỗi có thể thử lại. Hai màn dùng chung `DriverTaskPage` trong lớp trình bày.
- Flutter url_launcher cung cấp mẫu giao tiếp với trình duyệt qua ACTION_VIEW và callback iOS, gồm trường hợp không có trình xử lý (BSD-3-Clause). Cầu nối PowerMe dùng MethodChannel sẵn có và chỉ nhận gateway đã xác minh. Không chép mã hoặc thêm SDK. [Android UrlLauncher.kt](https://github.com/flutter/packages/blob/main/packages/url_launcher/url_launcher_android/android/src/main/kotlin/io/flutter/plugins/urllauncher/UrlLauncher.kt), [iOS URLLauncherPlugin.swift](https://github.com/flutter/packages/blob/main/packages/url_launcher/url_launcher_ios/ios/url_launcher_ios/Sources/url_launcher_ios/URLLauncherPlugin.swift).
- Stripe Node giữ idempotency key nhất quán khi retry (MIT). PowerMe dùng UUID đã có và giữ cả body qua lần thử lại do tài xế chọn. Adapter hiện tại dùng Dio và hợp đồng WP2, không thêm SDK hoặc chép mã. [Stripe RequestSender](https://github.com/stripe/stripe-node/blob/master/src/RequestSender.ts), [Stripe RequestSender tests](https://github.com/stripe/stripe-node/blob/master/test/RequestSender.spec.ts).
