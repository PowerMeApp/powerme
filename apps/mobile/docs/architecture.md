# Coding reference 2 — class, package và ranh giới WP3

**Đọc bắt buộc trước coding**, cùng [screen/function requirements](screens.md). File này là canonical reference kiến trúc mobile. README là cách chạy; `mb-01-foundation.md` là record nghiên cứu/baseline cũ, không được ghi đè reference này.

## Authority và cách dùng

Đọc nguyên [PKG-3_mobile](../../../diagrams/team/PKG-3_mobile.puml), [WF01-class](../../../diagrams/team/WF01-class.puml) và [WF01-seq](../../../diagrams/team/WF01-seq.puml), sau đó matching [SRS](../../../docs/requirements/report3-srs.md) / [registration v1.3 candidate](../../../docs/requirements/registration-form-v1.3.md). Không sửa diagram theo code hoặc copy policy từ app cũ. Mỗi slice ghi view/FR/UC/BR/NFR, class/signature/package tác động, dependency/DEC, expected states/test trước implementation; cập nhật tiến độ trong screens.md sau kiểm.

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

### Groups 2–4 local implementation — 29/10, supersedes pending runtime baselines

- Exact WF01 ChargingController/ChargingRepository/StartRequest/CommandOutcome/SessionSnapshot/Statement and typed enums now exist. Controller owns prepare/start/stop/resync/recover/apply/dispose, scope/session/version guards and subscription lifecycle. `ChargingPreparation.preview/current`, StartPreview, connectorLabel, stopReason, pauseCause and tariff segments are local extensions. `statementProvider` resolves owned snapshots in the application layer; screens do not call adapters directly.
- StationsController.suggest calls StationRepository.suggest. The optional StationSuggestionPreferences interface supplies fixture battery/target/mode settings; SuggestionController orchestrates it. StationActionsRepository plus ReservationController handle canonical QR/manual resolution, quote/hold/cancel/expiry/void. SupportController handles stable-key saved acknowledgments; its label provider uses public station metadata to show a human connector label.
- PaymentsController → PaymentsRepository owns credit/order/checkout/query/closure request. HistoryRepository and LoyaltyRepository expose owned HistorySnapshot/TopUpOrder and LoyaltySnapshot/PointLot/PointMovement through scoped application providers. These are PKG-3 feature extensions, not classes falsely attributed to WF01 UML. Top-up, settlement and invoice states remain distinct.
- Composition selects mock adapters and shared in-memory stores, with separate clock-driven charging/payment engines under `lib/demo`. Widgets submit intent and render snapshots; repository queries do not run the engines. Local streams and timers are fixtures, **not SessionRealtimeAdapter/Socket.IO, APIs, Unity or OCPP integration**. ApiStationRepository, ApiChargingRepository and the real realtime adapter remain pending. No generated WP2 contract or endpoint was invented.
- Command acceptance does not set active; unknown keeps its original key. Local engines confirm active/closed/reconciled and separate verified/posted/invoice states. A stopped/failed intent releases its connector; authoritative settlement controls debit/statement/earn. UI shows pending settlement only for closed/reconciled/review states. Shared stores enforce once-only ledger and point references; real server transactions/authorization are still required.

Final evidence and limitations are in README; the earlier pending rows describe the original baseline only. No shared diagrams changed.

### Group 1 extension — 29/10, supersedes fixed-scope/auth-pending baseline below

- `AuthRepository.restore(): Future<String?>`, `signIn(email,password): Future<String>`, `register(Registration): Future<String>`, `signOut(): void`; `AuthController` owns restoring/busy/failure/scope and monotonically increasing generation. Repository does not create auth scope or navigate. Mock auth validates in-memory accounts, atomically stores registration/consent and revokes pending work on logout. No real restore/refresh/secure storage/API auth.
- `Vehicle(id,brand,model,connectors)`, derived `isVinFast`; `DriverProfile` holds owned vehicles, selected ID, email/name/language and revision. Empty selected vehicle is explicit. `ProfileState(profile,busy,failure)` wraps view state. `ProfileRepository` adds async `updateName(name,revision)`, `saveVehicle(draft,id?,revision)`, `removeVehicle(id,revision)`, `selectVehicle(id,revision)` returning `DriverProfile`; read/language remain synchronous local operations. This is project-specific PKG-3 work, not an invented WF01 class signature or WP2 endpoint.
- Composition binds store/adapters to `AuthScope`; `localScopeProvider` is an alias of public `authScopeProvider`. Private providers rebuild on scope change; adapters check principal/generation before reads/writes. Controllers guard pending responses with captured scope/request/dispose. Mutations enforce expected revision and owned IDs; local UI suppresses duplicate submit. Name/language changes do not reset station search; selected vehicle or connector changes refetch compatibility.
- Stable GoRouter refreshed from auth state; `/loading` precedes private views, login/register are public, only an allowlisted station path can resume after login. Private subtree keyed by principal/generation clears widget state. Routes add `/profile/edit`, `/vehicles/new`, `/vehicles/:id/edit`; query strings/external URLs never execute. Logout clears auth and adapter access immediately; real server authorization remains required.
- Consent receipt `powerme-consent-local-v1` + UTC time and eight-character password minimum are mock fixtures pending product/WP2 policy. No shared diagrams changed; existing enum extensions remain authoritative for app code. No dependencies added.

Evidence: 18 regression tests and one nine-image preview capture pass, analyzer clean; [research/trace](auth-profile-slice.md). No API/device/gateway/NFR certification.

`main → DemoApp (internal name) → ProviderScope → PowerMeApp/GoRouter`. Một store dùng chung mock Profile và Stations; dependencies được inject tập trung, test override interface được. Internal mock names được giữ; **UI không có demo/mock/sample/technical warning** theo yêu cầu mới nhất, scope local chỉ README. Riverpod 3.4.3 + go_router 16.3.0 đã được cho phép/lock; không dependency mới.

API integration là composition khác được chọn chủ động, cần committed WP2 OpenAPI và pinned generator recipe dart-dio đã review. Không generated contract giả, không direct DB/OCPP/signing secrets. Profile language hiện chỉ custom app copy, không MaterialApp.locale/delegates/persistence. Auth restore/guards, private data server authorization và API adapters **chưa có**.

## Guard / checks bắt buộc theo ranh giới

| Boundary | Guard | Evidence cần có |
| --- | --- | --- |
| Search | Request sequence + captured scope principal/generation + current vehicle; discard late responses; clear invalidate outstanding | Query A chậm sau B không overwrite; scope generation đổi giữa request bỏ response; vehicle switch refetch; dispose không write |
| Auth/private data (pending) | Mỗi login kể cả cùng principal generation mới; hủy requests/subscriptions, clear caches; route chờ restore | A→logout→B/cùng A đăng nhập lại, late refresh/event không phục hồi A; ownership API reject |
| Snapshot/events (pending) | principal/generation/session/version + authoritative resync gap/reconnect/foreground | Duplicate/out-of-order/gap; stale retained timestamp, unknown metrics; stream close |
| Commands/money (pending) | Stable keys, accepted≠effect, unknown≠failed; return≠paid; ledger server-owned | Retry same key; duplicate close/IPN; late verified payment; station_wallet/unattributed no auto-debit/earn |
| UI | Injected repo, loading/empty/error/retry, 5 statuses/update/quality, no unimplemented CTA | Search/filter/detail/account/language; no technical labels; focus/48px; 320px/200% Việt/Anh; preview correct fonts/image decoded |

Format/analyze/Flutter tests/web build chạy trực tiếp **nested `powerme/apps/mobile`**, TMP/TEMP ở E:/Project/PowerMe/.review. Không chạy outer checker trỏ standalone app cũ. Tests fixture không chứng minh device/backend/NFR. Sau mỗi slice cập nhật actual results README và status screens.md; docs không tự cho phép commit/push/deploy/real money.

## Vietmap UI extension — 30/10

Live map composition, foreground location repository/controller, config handling và giới hạn tọa độ được ghi tại [Vietmap setup/research](vietmap-setup.md). Không thay chữ ký StationRepository hoặc sơ đồ WF01; không project mapX/mapY lên bản đồ thật. Main chọn Vietmap, test harness cũ chọn local rõ ràng; không fallback runtime khi tile lỗi.

30/10 — Station.location: MapLocation? là extension thuần Dart cho hai trụ Đông Hòa được người dùng yêu cầu. MockStationRepository.observed giữ location khi map status. VietmapSurface chỉ render trạm có location từ StationsState.stations; canonical stationId qua onSelect gọi controller chọn trạm, dùng sheet/detail/start hiện có. Symbol queue + style epoch + tap listener cleanup quản lý lifecycle native; không thay interface find/suggest hoặc sơ đồ. Camera center không là vị trí GPS. Không vẽ roadRoute tương đối lên Vietmap. Kiểm chứng và giới hạn xem vietmap-setup.md/README.


### 30/10 — QR là tab giữa (yêu cầu trực tiếp)

ShellRoute bổ sung `/scan` cho Quét QR; `/charging` giữ nguyên màn phiên và vẫn chọn tab giữa. `/start` là route xác nhận riêng, không tự start. QR screen dùng QrConnectionController (extension Charging) → StationActionsRepository.resolve đã có → connectorId canonical → StartScreen. Không đổi WF01/class backend hoặc tạo API mới. Nhập tay và camera đi cùng resolver; chỉ chấp nhận mã đã hỗ trợ `station-id/number` hoặc `powerme:connector:station-id/number`, không mở URL tùy ý.

QrConnectionController loại response muộn khi auth/vehicle đổi, chặn duplicate/busy và pending/unknown/session chưa kết thúc. QR screen luôn có shortcut phiên nếu có command/session; không tạo key/start/recover khi vào tab. Camera chỉ mount trên top route `/scan` và foreground; dispose khi mở confirmation/session, đổi tab hoặc xuống nền. Serial release chờ pending permission/start trước stop/dispose. Permission error/retry và nhập tay có sẵn. Permission camera native chỉ sử dụng khi mở tab QR. Dữ liệu charging vẫn local; quét camera không đồng nghĩa tích hợp CSMS.

Dependency được người dùng duyệt: `mobile_scanner` pin 7.4.2 (Dart >=3.7, Flutter >=3.29, phù hợp SDK hiện tại). Research source thực từ archive pub: `lib/src/mobile_scanner.dart`, `mobile_scanner_controller.dart`, `test/mobile_scanner_widget/detect_barcode_test.dart`, `test/mobile_scanner_controller/dispose_test.dart`, pubspec/license. Nguồn: https://github.com/juliansteenbakker/mobile_scanner ; release https://pub.dev/packages/mobile_scanner/versions/7.4.2 . Source master/README chỉ để định hướng, implementation dựa archive 7.4.2; commit archive không cung cấp nên không tự ghi SHA. Chọn scanner thay tự ghép camera+decoder: ít glue native hơn, có QR-only/controller/permission/error; đổi lại thêm MLKit/CameraX và cần device validation. Không thêm gallery/upload/quyền ảnh, không lưu/log raw QR/frame. BSD-3-Clause của Julian Steenbakker, notice đầy đủ giữ THIRD_PARTY_NOTICES.md. Code PowerMe tự viết theo repository/lifecycle hiện có; test fake theo public platform interface để kiểm behavior, không khẳng định device pass.
