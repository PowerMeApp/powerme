# MB-01 — nền tảng demo Flutter

Historical baseline: phần UI/routes/status dưới đây được thay bởi redesign 28/10; canonical coding references là screens.md và architecture.md. Giữ phần research/attribution để truy vết.

Slice ngày 28/10/2026: app composition Riverpod, go_router, theme và hai route sử dụng được. `/` là trang bắt đầu demo, **chưa phải Home Map/List FR-03**. `/profile` đọc hồ sơ/xe fixture và chọn ngôn ngữ Việt/Anh, áp dụng tức thì qua repository/controller và giữ khi đi lại giữa các route. Khởi động lại app trả seed tiếng Việt.

## Trace và ranh giới

MB-01 trong kế hoạch nhóm: khởi tạo app/design system/Việt–Anh. FR-02, UC-ACC-02/03: chỉ bước chuẩn bị UI hồ sơ/xe mẫu; chưa hoàn thành quản lý hồ sơ/xe. WP3 sở hữu app; tích hợp auth/profile cần WP2. NFR-US-02 vẫn dành cho onboarding ≤3 màn, chưa thực hiện onboarding. NFR-SEC-01 và BR-P05/16 chưa được chứng minh: **không auth, login, consent, tài khoản thật hay private cache trong slice này**; fixture không giả làm phiên đăng nhập. Profile là read-only ngoài lựa chọn ngôn ngữ local.

Copy do app viết được đổi Việt/Anh qua `AppCopy`. `MaterialApp.locale`, localization delegates và framework localization **chưa cấu hình**; đây chưa phải localization toàn ứng dụng. Tên fixture/logo/nhãn ngôn ngữ giữ nguyên. Không thêm dependency localization trong slice. Chưa có lưu lựa chọn qua restart.

BR-P tiền/command/payment không được kích hoạt. Không API, OCPP, QR execution, checkout, tính tiền/credit/points, station map, realtime, stream/timer hay billing policy. Pending/unknown/offline/concurrency/auth generation sẽ kiểm ở slice có các ranh giới đó. Các DEC về provider/tax/retention/credit/reservation và candidate 26/10 chờ duyệt vẫn để mở. Demo chạy không chứng minh backend/NFR/research.

## Kiến trúc thực tế

`main → DemoApp (ProviderScope override) → PowerMeApp (MaterialApp.router)`.

`ProfileScreen / StartScreen → ProfileController → ProfileRepository ← MockProfileRepository → DemoStore`.

Domain là Dart thuần. Controller chỉ đọc/đổi preference thông qua interface; không khởi tạo adapter. Mock/store được tạo một lần theo vòng đời provider trong composition; không fallback từ API lỗi. Router được dispose cùng provider, route lạ có nội dung phục hồi về đầu và không lộ raw error. Chưa có adapter API/generated contract hoặc auth guard. Các thư mục feature rỗng người dùng chuẩn bị được giữ nguyên.

## Research trước implementation

Đã đọc code và test GitHub tại revision cố định, không chạy code tham khảo hoặc chỉ dựa README. SDK hiện có: Flutter **3.44.2**, Dart **3.12.2**. Chỉ thêm hai direct dependency đã được người dùng cho phép, ghim chính xác; `pubspec.lock` giữ transitive versions.

| Thư viện/nguồn đã đọc | Khớp, lựa chọn và đánh đổi |
| --- | --- |
| flutter_riverpod **3.4.3**, commit `128a8cacce6ddb73e04675e5204af452c9aec369`: [example](https://github.com/rrousselGit/riverpod/blob/128a8cacce6ddb73e04675e5204af452c9aec369/packages/flutter_riverpod/example/lib/main.dart), [example test](https://github.com/rrousselGit/riverpod/blob/128a8cacce6ddb73e04675e5204af452c9aec369/packages/flutter_riverpod/example/test/widget_test.dart), [scope override tests](https://github.com/rrousselGit/riverpod/blob/128a8cacce6ddb73e04675e5204af452c9aec369/packages/flutter_riverpod/test/provider_scope_test.dart), [MIT](https://github.com/rrousselGit/riverpod/blob/128a8cacce6ddb73e04675e5204af452c9aec369/LICENSE) | Áp dụng ProviderScope/Consumer watch/read và override để test injection. Dùng Notifier thủ công thay legacy StateProvider của example; không codegen/annotation/build_runner. Tách interface khỏi Flutter, phù hợp UML và ít tool/dependency hơn codegen, đổi lại khai báo provider thủ công. Yêu cầu Dart ^3.12 tương thích SDK. Maintained chính chủ; cần review changelog khi nâng bản. Scope isolation không tự chứng minh auth/ownership. |
| go_router **16.3.0**, commit `9ec29b6d23e79e8cb83a29ad29311c903d7cd07d`: [two-screen example](https://github.com/flutter/packages/blob/9ec29b6d23e79e8cb83a29ad29311c903d7cd07d/packages/go_router/example/lib/main.dart), [navigation test](https://github.com/flutter/packages/blob/9ec29b6d23e79e8cb83a29ad29311c903d7cd07d/packages/go_router/example/test/main_test.dart), [BSD-3-Clause](https://github.com/flutter/packages/blob/9ec29b6d23e79e8cb83a29ad29311c903d7cd07d/packages/go_router/LICENSE) | Áp dụng MaterialApp.router và nested GoRoute; test route/back. Phù hợp đích go_router sẵn có, hỗ trợ stack `/ → /profile`; chưa cần ShellRoute/typed generator cho hai route. Đòi Flutter ≥3.29/Dart ^3.7, tương thích SDK; version có sẵn cache, không khẳng định mới nhất. Chính chủ Flutter packages, dependency collection/logging/meta và Flutter web plugins; route guard không thay server authorization. |

Hai thư viện bổ trợ nhau, không thay thế nhau. Chọn provider thủ công + nested routes thay codegen/ShellRoute để giữ slice nhỏ. Source PowerMe viết riêng theo nghiệp vụ này, không copy nguyên example hoặc test. Giữ notices/license của dependency qua cơ chế Flutter và bản [notice local](../THIRD_PARTY_NOTICES.md); brand do người dùng cung cấp, không thuộc MIT/BSD của thư viện.

## Kiểm chứng

Lệnh và kết quả được cập nhật ở [README](../README.md). Tests bao phủ boot/composition/logo, repository override, intent đổi ngôn ngữ/giữ state qua route, reset theo store mới, direct route/back/unknown route và 320px với text 200% cả Việt/Anh. Tap test yêu cầu hit-test thành công, không tắt overflow/hit warnings. Preview là render Flutter test với font Roboto sẵn trong SDK, không phải ảnh thiết bị thật; capture tool không tham gia regression suite mặc định. Không dùng checker ngoài repo vì nó sẽ chạy app standalone cũ.


## Redesign research 28/10

Hallmark v2.0.0 at commit `6033bab2a8051b5454552d2e8e6cb8f27c483a42`: read [SKILL](https://github.com/Nutlope/hallmark/blob/6033bab2a8051b5454552d2e8e6cb8f27c483a42/skills/hallmark/SKILL.md), [redesign](https://github.com/Nutlope/hallmark/blob/6033bab2a8051b5454552d2e8e6cb8f27c483a42/skills/hallmark/references/redesign.md), [flow](https://github.com/Nutlope/hallmark/blob/6033bab2a8051b5454552d2e8e6cb8f27c483a42/skills/hallmark/references/flow.md), [gates](https://github.com/Nutlope/hallmark/blob/6033bab2a8051b5454552d2e8e6cb8f27c483a42/skills/hallmark/references/gates.md), relevant [sloplint source](https://github.com/Nutlope/hallmark/blob/6033bab2a8051b5454552d2e8e6cb8f27c483a42/skills/hallmark/scripts/sloplint.mjs) (initial source section; not full tool review), [MIT license](https://github.com/Nutlope/hallmark/blob/6033bab2a8051b5454552d2e8e6cb8f27c483a42/LICENSE). Applied task-first app density, hierarchy, restrained brand color, meaningful controls/states, manual visual gates. Web-oriented lint does not validate Dart; no code/tool/dependency from Hallmark executed or installed, no automated Hallmark pass claimed. Principles adapted to Flutter rather than copying implementation; no new runtime dependency/security boundary. Maintenance remains local Flutter widget tests and visual review.

Read old local auth/discovery/account/shell/scaffold/theme and `.stitch/DESIGN.md` as visual references only. Adapted compact wordmark/search/vehicle/list hierarchy and fixture station identities, not inline filtering or old business policy. No rendered Stitch exports found. User override removes visible demo labels; fixture boundary documented in README. Existing Riverpod/go_router research above remains applicable; ShellRoute now provides two functioning bottom destinations.
