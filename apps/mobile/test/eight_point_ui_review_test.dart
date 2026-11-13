import 'support/driver_app_test_harness.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/theme/powerme_theme.dart';
import 'package:driver_app/core/widgets/flow_page.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/stations/application/station_actions_controller.dart';
import 'package:driver_app/features/stations/domain/station.dart';
import 'package:driver_app/features/stations/presentation/station_actions_screens.dart';
import 'package:driver_app/features/support/application/support_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'test_helpers.dart';

class _Suggestions extends SuggestionController {
  _Suggestions(this.result);
  final SuggestionState result;
  @override
  SuggestionState build() => result;
}

void viewport(WidgetTester tester, double width, double scale) {
  tester.view.physicalSize = Size(width, 1000);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

Future<ProviderContainer> boot(WidgetTester tester) async {
  await tester.pumpWidget(const DriverAppTestHarness());
  await tester.pumpAndSettle();
  await signIn(tester);
  return ProviderScope.containerOf(tester.element(find.byType(PowerMeApp)));
}

Future<void> reveal(WidgetTester tester, Finder target) async {
  await tester.scrollUntilVisible(
    target.hitTestable(),
    180,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
}

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  for (final (width, scale) in [(390.0, 1.0), (320.0, 2.0)]) {
    testWidgets(
      'Error announcement wraps and blank error has no layout $width/$scale',
      (tester) async {
        viewport(tester, width, scale);
        final semantics = tester.ensureSemantics();
        const message =
            'Chưa xác định kết quả yêu cầu. Hãy kiểm tra yêu cầu hiện tại trước khi thử lại.';
        await tester.pumpWidget(
          MaterialApp(
            theme: powerMeTheme(),
            home: const Scaffold(
              body: Padding(
                padding: EdgeInsets.all(20),
                child: Column(
                  children: [
                    FailureNotice(null),
                    FailureNotice('  '),
                    FailureNotice(message),
                  ],
                ),
              ),
            ),
          ),
        );
        expect(find.text(message), findsOneWidget);
        expect(find.bySemanticsLabel(message), findsOneWidget);
        expect(
          find.byWidgetPredicate(
            (w) => w is Semantics && w.properties.liveRegion == true,
          ),
          findsOneWidget,
        );
        expect(find.byIcon(Icons.info_outline_rounded), findsOneWidget);
        for (final notice in find.byType(FailureNotice).evaluate().take(2)) {
          expect(tester.getSize(find.byWidget(notice.widget)).height, 0);
        }
        expect(tester.takeException(), isNull);
        semantics.dispose();
      },
    );

    testWidgets(
      'Report needs saved acknowledgment; receipt and fallback back work $width/$scale',
      (tester) async {
        viewport(tester, width, scale);
        final container = await boot(tester);
        final router = container.read(routerProvider);
        router.go('/report?connector=station-powerme-center%2F1');
        await tester.pumpAndSettle();
        final controller = container.read(supportControllerProvider.notifier);
        await controller.submit(
          'station-powerme-center/1',
          'Cáp / đầu nối',
          '',
        );
        await tester.pumpAndSettle();
        expect(find.text('Đã nhận báo lỗi'), findsNothing);
        await reveal(tester, find.byType(FailureNotice));
        expect(container.read(supportControllerProvider).report, isNull);
        expect(find.byIcon(Icons.info_outline_rounded), findsOneWidget);
        await controller.submit(
          'station-powerme-center/1',
          'Cáp / đầu nối',
          'Đầu nối không sử dụng được.',
        );
        await tester.pumpAndSettle();
        final report = container.read(supportControllerProvider).report!;
        expect(find.text('Đã nhận báo lỗi'), findsOneWidget);
        expect(find.text(report.id), findsOneWidget);
        expect(find.text(ict(report.savedAt)), findsOneWidget);
        await reveal(tester, find.byKey(const Key('report-back')));
        await tester.tap(find.byKey(const Key('report-back')));
        await tester.pumpAndSettle();
        expect(router.routeInformationProvider.value.uri.path, '/');
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'Suggestions preserve supplied rank/reason; omit missing metadata $width/$scale',
      (tester) async {
        viewport(tester, width, scale);
        final updated = DateTime.utc(2026, 10, 30, 3);
        final station = Station(
          id: 'test-station',
          name: 'Trạm được backend gợi ý',
          address: 'Địa chỉ trạm',
          status: StationStatus.available,
          quality: DataQuality.stale,
          updatedAt: updated,
          availableCount: 1,
          connectors: [
            StationConnector(
              number: 1,
              type: 'CCS2',
              powerW: 120000,
              status: StationStatus.available,
              quality: DataQuality.stale,
              updatedAt: updated,
            ),
          ],
        );
        Future<void> render({
          int? rank,
          String? reason,
          String? source,
          String? range,
        }) async {
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpWidget(
            ProviderScope(
              overrides: [
                suggestionControllerProvider.overrideWith(
                  () => _Suggestions(
                    SuggestionState(
                      loaded: true,
                      options: [
                        StationOption(
                          station: station,
                          connectorId: 'test-station/1',
                          status: station.status,
                          updatedAt: updated,
                          rank: rank,
                          suggestionReason: reason,
                          estimateSource: source,
                          rangeLabel: range,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
              child: MaterialApp(
                theme: powerMeTheme(),
                home: const SuggestionsScreen(),
              ),
            ),
          );
          await tester.pumpAndSettle();
          await reveal(tester, find.text(station.name));
        }

        await render(
          rank: 7,
          reason: 'Lý do từ dịch vụ: phù hợp mục tiêu.',
          source: 'Nguồn ước tính',
          range: 'Khoảng 20–30 phút',
        );
        expect(find.text('#7'), findsOneWidget);
        expect(find.text('#1'), findsNothing);
        expect(
          find.text('Lý do từ dịch vụ: phù hợp mục tiêu.'),
          findsOneWidget,
        );
        await reveal(tester, find.text('Khoảng 20–30 phút'));
        expect(find.text('Nguồn ước tính'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await render(reason: '  ', source: '', range: null);
        expect(find.textContaining('#'), findsNothing);
        expect(find.text(''), findsNothing);
        expect(find.text('  '), findsNothing);
        await reveal(tester, find.textContaining('Độ mới:'));
        expect(find.textContaining('cần cập nhật'), findsOneWidget);
        expect(find.textContaining('Chưa xác định'), findsWidgets);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'Profile/vehicle direct URLs and pushed pages have localized safe back; email is read only',
    (tester) async {
      viewport(tester, 320, 2);
      final container = await boot(tester);
      final router = container.read(routerProvider);
      for (final language in AppLanguage.values) {
        container
            .read(profileControllerProvider.notifier)
            .selectLanguage(language);
        for (final path in [
          '/profile/edit',
          '/vehicles/vehicle-ioniq5/edit',
          '/vehicles/new',
          '/vehicles/missing/edit',
        ]) {
          router.go(path);
          await tester.pumpAndSettle();
          if (path == '/profile/edit') {
            expect(find.text('Email'), findsOneWidget);
            expect(find.text('minh@powerme.local'), findsOneWidget);
            expect(
              tester.widget<SelectableText>(find.byType(SelectableText)).data,
              'minh@powerme.local',
            );
            expect(find.byType(TextFormField), findsOneWidget);
          }
          final tooltip = language == AppLanguage.vietnamese
              ? 'Quay lại'
              : 'Back';
          await tester.tap(find.byTooltip(tooltip));
          await tester.pumpAndSettle();
          expect(router.routeInformationProvider.value.uri.path, '/profile');
          expect(tester.takeException(), isNull);
        }
        router.go('/');
        await tester.pumpAndSettle();
        for (final path in ['/profile/edit', '/vehicles/vehicle-ioniq5/edit']) {
          router.push(path);
          await tester.pumpAndSettle();
          await tester.tap(
            find.byTooltip(
              language == AppLanguage.vietnamese ? 'Quay lại' : 'Back',
            ),
          );
          await tester.pumpAndSettle();
          expect(router.routeInformationProvider.value.uri.path, '/');
        }
      }
    },
  );

  testWidgets(
    'Three navigation destinations retain visible selection and accessible labels',
    (tester) async {
      viewport(tester, 320, 2);
      await boot(tester);
      for (final (index, name, icon) in [
        (0, 'nav-discovery', Icons.explore),
        (1, 'nav-charging', Icons.qr_code_rounded),
        (2, 'nav-account', Icons.person_rounded),
      ]) {
        await tester.tap(find.byKey(Key(name)));
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<NavigationBar>(find.byType(NavigationBar))
              .selectedIndex,
          index,
        );
        final theme = NavigationBarTheme.of(
          tester.element(find.byType(NavigationBar)),
        );
        expect(theme.backgroundColor, PowerMeColors.graphite);
        expect(
          theme.iconTheme!.resolve({WidgetState.selected})!.color,
          PowerMeColors.black,
        );
        expect(theme.iconTheme!.resolve({})!.color, PowerMeColors.muted);
        expect(find.byIcon(icon), findsOneWidget);
        expect(tester.takeException(), isNull);
      }
    },
  );
}
