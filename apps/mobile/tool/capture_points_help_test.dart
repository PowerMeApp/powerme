import 'dart:io';
import 'dart:ui' as ui;

import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/core/theme/powerme_theme.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/payments/application/charging_credit_controller.dart';
import 'package:driver_app/features/payments/application/credit_top_up_controller.dart';
import 'package:driver_app/features/payments/data/api_charging_credit_repository.dart';
import 'package:driver_app/features/payments/data/api_credit_top_up_repository.dart';
import 'package:driver_app/features/payments/presentation/credit_top_up_screen.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../test/driver_api_fixture.dart';
import '../test/driver_loyalty_test.dart'
    show loyaltyApi, openLocalizedLoyalty, tapLoyalty;
import '../test/support/loyalty_api_fixture.dart';

void main() {
  for (final (width, scale) in [(390.0, 1.0), (320.0, 2.0)]) {
    for (final language in AppLanguage.values) {
      testWidgets('points help $width/$scale ${language.name}', (tester) async {
        await tester.runAsync(_loadFonts);
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 24, bottom: 24);
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPadding);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final boundary = GlobalKey();
        Widget wrap(Widget child) =>
            RepaintBoundary(key: boundary, child: child);
        const output = String.fromEnvironment('POWERME_POINTS_HELP_CAPTURE');
        final dir =
            '$output/${width.toInt()}-${scale.toInt()}x-${language.name}';
        Future<void> capture(String name) async {
          await tester.pumpAndSettle();
          final render =
              boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await render.toImage();
            final data = await image.toByteData(format: ui.ImageByteFormat.png);
            final file = File('$dir/$name.png');
            await file.parent.create(recursive: true);
            await file.writeAsBytes(data!.buffer.asUint8List());
            image.dispose();
          });
          expect(tester.takeException(), null);
        }

        final fixture = loyaltyFixture(
          quote: (_) async => reply(200, loyaltyQuote()),
        );
        if (width == 390 && language == AppLanguage.vietnamese) {
          await openLocalizedLoyalty(
            tester,
            fixture,
            language: language,
            wrap: wrap,
          );
          await tapLoyalty(tester, 'points-help');
          await tester.tap(find.byKey(const Key('points-help-close')));
          await tester.pumpAndSettle();
          await capture('loyalty-heading');
          await tester.pumpWidget(const SizedBox.shrink());
        }
        final session = DriverApiSession(loyaltyApi, adapter: fixture);
        addTearDown(session.dispose);
        final principal = (await tester.runAsync(
          () => session.signIn('test@example.invalid', 'fixture password'),
        ))!;
        await tester.pumpWidget(
          wrap(
            ProviderScope(
              overrides: [
                authScopeProvider.overrideWithValue(
                  AuthScope(principalId: principal, generation: 1),
                ),
                profileControllerProvider.overrideWith(
                  () => _Profile(language),
                ),
                chargingCreditRepositoryProvider.overrideWithValue(
                  ApiChargingCreditRepository(session),
                ),
                creditTopUpRepositoryProvider.overrideWithValue(
                  ApiCreditTopUpRepository(session),
                ),
              ],
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: powerMeTheme(),
                home: const CreditTopUpScreen(),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tapLoyalty(tester, 'top-up-preset-200000');
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pumpAndSettle();
        await tapLoyalty(tester, 'points-help');
        final scroll = tester
            .state<ScrollableState>(
              find.descendant(
                of: find.byKey(const Key('points-help-content')),
                matching: find.byType(Scrollable),
              ),
            )
            .position;
        var index = 0;
        while (true) {
          expect(
            find.byKey(const Key('points-help-close')).hitTestable(),
            findsOneWidget,
          );
          await capture('sheet-${index++}');
          if (scroll.pixels >= scroll.maxScrollExtent) break;
          scroll.jumpTo(
            (scroll.pixels + scroll.viewportDimension * .85).clamp(
              0,
              scroll.maxScrollExtent,
            ),
          );
          await tester.pumpAndSettle();
        }
        await tester.tap(find.byKey(const Key('points-help-close')));
        await tester.pumpAndSettle();
        if (width == 390 && language == AppLanguage.vietnamese) {
          await capture('top-up-heading');
        }
        await tapLoyalty(tester, 'points-help');
        if (width == 390) {
          await tester.tapAt(const Offset(8, 8));
        } else {
          await tester.flingFrom(
            tester.getTopLeft(find.byType(BottomSheet)) + const Offset(140, 18),
            const Offset(0, 600),
            1500,
          );
        }
        await tester.pumpAndSettle();
        expect(find.byType(BottomSheet), findsNothing);
        expect(
          fixture.requests.where(
            (r) => r.method != 'GET' && r.path != 'auth/login',
          ),
          isEmpty,
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
      });
    }
  }
}

class _Profile extends ProfileController {
  _Profile(this.language);
  final AppLanguage language;
  @override
  ProfileState build() =>
      ProfileState(DriverProfile(displayName: 'Tài xế', language: language));
}

Future<void> _loadFonts() async {
  const fonts = String.fromEnvironment('POWERME_PREVIEW_FONTS');
  for (final family in ['Roboto', 'Ahem']) {
    final loader = FontLoader(family);
    for (final weight in ['regular', 'medium', 'bold']) {
      loader.addFont(
        File(
          '$fonts/roboto-$weight.ttf',
        ).readAsBytes().then(ByteData.sublistView),
      );
    }
    await loader.load();
  }
  await (FontLoader('MaterialIcons')..addFont(
        File(
          '$fonts/materialicons-regular.otf',
        ).readAsBytes().then(ByteData.sublistView),
      ))
      .load();
}
