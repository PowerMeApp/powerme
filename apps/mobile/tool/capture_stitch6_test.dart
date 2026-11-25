import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/core/widgets/app_page.dart';
import 'package:driver_app/core/widgets/brand_mark.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/data/api_auth_repository.dart';
import 'package:driver_app/features/charging/application/charge_session_controller.dart';
import 'package:driver_app/features/charging/application/charge_start_controller.dart';
import 'package:driver_app/features/charging/data/api_charge_session_repository.dart';
import 'package:driver_app/features/charging/data/api_charge_start_repository.dart';
import 'package:driver_app/features/loyalty/application/loyalty_controller.dart';
import 'package:driver_app/features/loyalty/data/api_loyalty_repository.dart';
import 'package:driver_app/features/payments/application/charging_credit_controller.dart';
import 'package:driver_app/features/payments/application/credit_top_up_controller.dart';
import 'package:driver_app/features/payments/data/api_charging_credit_repository.dart';
import 'package:driver_app/features/payments/data/api_credit_top_up_repository.dart';
import 'package:driver_app/features/payments/domain/credit_top_up.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/api_profile_repository.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../test/driver_api_fixture.dart';
import '../test/driver_loyalty_test.dart' show loyaltyApi;
import '../test/support/loyalty_api_fixture.dart';

void main() {
  for (final (width, scale) in [(390.0, 1.0), (320.0, 2.0)]) {
    for (final language in AppLanguage.values) {
      testWidgets('ZIP6 $width/$scale ${language.name}', (tester) async {
        final previousHitTestPolicy =
            WidgetController.hitTestWarningShouldBeFatal;
        WidgetController.hitTestWarningShouldBeFatal = true;
        addTearDown(
          () => WidgetController.hitTestWarningShouldBeFatal =
              previousHitTestPolicy,
        );
        await tester.runAsync(_loadFonts);
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 24, bottom: 24);
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPadding);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        var scenario = 'available';
        var withVehicle = true;
        var creditError = false;
        var available = 6000;
        final waiting = <Completer<ResponseBody>>[];
        final now = DateTime.now().toUtc();
        final launches = <String>[];
        final fixture = DriverApiFixture((request) async {
          if (request.path == 'auth/login') return reply(200, tokens(accessA));
          expect(request.headers['Authorization'], 'Bearer $accessA');
          switch (request.path) {
            case 'me':
              return reply(
                200,
                account(name: 'Trần Minh An', withVehicle: withVehicle),
              );
            case 'credit':
              return creditError
                  ? reply(503, {'error': 'unavailable'})
                  : reply(200, {
                      'balance_vnd': 74000,
                      'held_vnd': 0,
                      'available_vnd': 74000,
                      'status': 'active',
                    });
            case loyaltyQuotePath:
              if (scenario == 'loading' || scenario == 'quote-loading') {
                final pending = Completer<ResponseBody>();
                waiting.add(pending);
                return pending.future;
              }
              if (scenario == 'error' || scenario == 'quote-error') {
                return reply(503, {'error': 'unavailable'});
              }
              return reply(
                200,
                loyaltyQuote(
                  available: available,
                  maximum: available == 0 ? 0 : 2500,
                  discount: available == 0 ? 0 : 25000,
                ),
              );
            case 'billing/top-ups':
              expect(request.method, 'POST');
              expect(request.data, {
                'amount_vnd': 200000,
                'points_to_redeem': 123,
              });
              expect(request.headers['Idempotency-Key'], isNotEmpty);
              return reply(201, {
                'top_up_id': '31',
                'status': 'pending',
                'amount_vnd': 200000,
                'points_redeemed': 123,
                'points_discount_vnd': 12400,
                'amount_paid_vnd': 187600,
                'created_at': now.toIso8601String(),
                'expires_at': now
                    .add(const Duration(minutes: 15))
                    .toIso8601String(),
                'payment_url':
                    'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?vnp_TxnRef=31&vnp_SecureHash=fixture',
              });
            case 'billing/top-ups/31':
              expect(request.method, 'GET');
              return reply(200, {
                'top_up_id': '31',
                'status': 'pending',
                'amount_vnd': 200000,
                'points_redeemed': 123,
                'points_discount_vnd': 12400,
                'amount_paid_vnd': 187600,
                'created_at': now.toIso8601String(),
                'expires_at': now
                    .add(const Duration(minutes: 15))
                    .toIso8601String(),
                'payment_url':
                    'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?vnp_TxnRef=31&vnp_SecureHash=fixture',
              });
          }
          throw StateError(
            'Unexpected fixture request: ${request.method} ${request.path}',
          );
        });
        final session = DriverApiSession(loyaltyApi, adapter: fixture);
        await tester.runAsync(
          () => session.signIn('test@example.invalid', 'fixture password'),
        );
        final container = ProviderContainer(
          overrides: [
            apiRouterProvider.overrideWithValue(true),
            registrationOptionsProvider.overrideWithValue((
              enabled: false,
              needsVehicle: false,
            )),
            authRepositoryProvider.overrideWithValue(
              ApiAuthRepository(session, consentVersion: null),
            ),
            profileRepositoryProvider.overrideWithValue(
              ApiProfileRepository(session),
            ),
            profileControllerProvider.overrideWith(
              () => _ReviewProfile(language),
            ),
            chargingCreditRepositoryProvider.overrideWithValue(
              ApiChargingCreditRepository(session),
            ),
            creditTopUpRepositoryProvider.overrideWithValue(
              ApiCreditTopUpRepository(session),
            ),
            loyaltyBalanceRepositoryProvider.overrideWithValue(
              ApiLoyaltyRepository(session, probeAmountVnd: minTopUpVnd),
            ),
            chargeStartRepositoryProvider.overrideWithValue(
              ApiChargeStartRepository(session),
            ),
            chargeSessionRepositoryProvider.overrideWithValue(
              ApiChargeSessionRepository(session),
            ),
            openVnpayCheckoutProvider.overrideWithValue((url) async {
              launches.add(url);
              return true;
            }),
          ],
        );
        addTearDown(container.dispose);
        addTearDown(session.dispose);
        container.read(authControllerProvider);
        await tester.pump();
        final router = container.read(routerProvider);
        router.go('/profile');
        final boundaryKey = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundaryKey,
            child: UncontrolledProviderScope(
              container: container,
              child: const PowerMeApp(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(container.read(authControllerProvider).scope, isNotNull);
        await tester.runAsync(() async {
          for (final asset in [
            'powerme-master-icon.png',
            'powerme-wordmark.png',
            'powerme-master-lockup.png',
            'powerme-secondary-icon.png',
          ]) {
            await precacheImage(
              AssetImage('assets/brand/$asset'),
              boundaryKey.currentContext!,
              onError: (error, stack) => fail('Brand asset $asset: $error'),
            );
          }
        });
        await tester.pumpAndSettle();
        final manifest = <Map<String, Object>>[];

        Finder pageList() {
          final list = find.descendant(
            of: find.byType(AppPage),
            matching: find.byType(ListView),
          );
          expect(list, findsOneWidget);
          return list;
        }

        Finder pageScrollable() => find
            .descendant(of: pageList(), matching: find.byType(Scrollable))
            .first;

        ScrollPosition pagePosition() =>
            tester.state<ScrollableState>(pageScrollable()).position;

        Future<void> reveal(Finder target) async {
          if (target.evaluate().isEmpty) {
            await tester.scrollUntilVisible(
              target,
              180,
              scrollable: pageScrollable(),
            );
          }
          await tester.ensureVisible(target);
          await tester.pump();
        }

        const output = String.fromEnvironment(
          'POWERME_STITCH6_CAPTURE',
          defaultValue: 'build/previews/t145-stitch6',
        );
        final directory =
            '$output/${width.toInt()}-${scale.toInt()}x-${language.name}';

        Future<void> settlePage(ScrollPosition scroll) async {
          double? previousExtent;
          for (var frame = 0; frame < 12; frame++) {
            await tester.pump(const Duration(milliseconds: 16));
            if (scroll.outOfRange) {
              scroll.jumpTo(scroll.pixels.clamp(0, scroll.maxScrollExtent));
              previousExtent = null;
            } else if (previousExtent == scroll.maxScrollExtent) {
              return;
            } else {
              previousExtent = scroll.maxScrollExtent;
            }
          }
          fail('Page scroll geometry did not stabilize');
        }

        Finder headerTitle(String name) {
          final english = language == AppLanguage.english;
          final title = name.startsWith('profile')
              ? (english ? 'Account' : 'Tài khoản')
              : name.startsWith('loyalty')
              ? (english ? 'PowerMe points' : 'Điểm PowerMe')
              : name == 'top-up-pending-get-disclosure'
              ? (english ? 'Top-up pending' : 'Giao dịch đang chờ')
              : (english ? 'Top up credit' : 'Nạp tín dụng');
          return find.descendant(
            of: find.byType(AppPage),
            matching: find.text(title),
          );
        }

        void markTreeForPaint(RenderObject object) {
          object.visitChildren(markTreeForPaint);
          object.markNeedsPaint();
        }

        Future<void> capture(
          String name, {
          bool busy = false,
          bool wholePage = true,
          Finder? focus,
        }) async {
          FocusManager.instance.primaryFocus?.unfocus();
          if (busy) {
            await tester.pump(const Duration(milliseconds: 100));
          } else {
            await tester.pumpAndSettle();
          }
          final scroll = pagePosition();
          scroll.jumpTo(0);
          await settlePage(scroll);
          expect(scroll.pixels, 0);
          final offsets = <double>[];
          for (var page = 1; page <= 24; page++) {
            expect(tester.takeException(), isNull, reason: name);
            final offset = scroll.pixels;
            expect(
              offsets.contains(offset),
              isFalse,
              reason: '$name duplicate',
            );
            offsets.add(offset);
            final viewport = tester.getRect(pageList());
            final targetVisible =
                focus != null &&
                focus.evaluate().isNotEmpty &&
                tester.getRect(focus).overlaps(viewport);
            if (page > 1 && focus != null) {
              expect(targetVisible, isTrue, reason: '$name focused content');
            }
            final brand = find.byType(BrandMark);
            final logoRects = <Rect>[];
            if (brand.evaluate().isNotEmpty) {
              for (final logo
                  in find
                      .descendant(of: brand, matching: find.byType(RawImage))
                      .evaluate()) {
                final image = logo.widget as RawImage;
                expect(image.image, isNotNull, reason: '$name decoded logo');
                logoRects.add(
                  tester.getRect(
                    find.byElementPredicate(
                      (element) => identical(element, logo),
                    ),
                  ),
                );
              }
            }
            Rect? titleRect;
            if (page == 1) {
              expect(brand, findsOneWidget, reason: '$name first-frame logo');
              expect(logoRects, hasLength(2));
              final title = headerTitle(name);
              expect(title, findsOneWidget, reason: '$name first-frame title');
              titleRect = tester.getRect(title);
              expect(viewport.overlaps(titleRect), isTrue);
            }
            final boundary =
                boundaryKey.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            // Repaint retained child layers before each offscreen snapshot.
            markTreeForPaint(boundary);
            await tester.pump();
            expect(boundary.debugNeedsPaint, isFalse);
            final path =
                '$directory/$name-${page.toString().padLeft(2, '0')}.png';
            var logoPixels = 0;
            var titlePixels = 0;
            await tester.runAsync(() async {
              final image = await boundary.toImage();
              try {
                final rgba = (await image.toByteData(
                  format: ui.ImageByteFormat.rawRgba,
                ))!;
                int paintedPixels(Rect rect) {
                  var count = 0;
                  for (
                    var y = math.max(0, rect.top.ceil());
                    y < math.min(image.height, rect.bottom.floor());
                    y++
                  ) {
                    for (
                      var x = math.max(0, rect.left.ceil());
                      x < math.min(image.width, rect.right.floor());
                      x++
                    ) {
                      final index = (y * image.width + x) * 4;
                      if (rgba.getUint8(index) > 100 ||
                          rgba.getUint8(index + 1) > 100 ||
                          rgba.getUint8(index + 2) > 100) {
                        count++;
                      }
                    }
                  }
                  return count;
                }

                for (final rect in logoRects) {
                  final count = paintedPixels(rect);
                  expect(count, greaterThan(10), reason: '$name painted logo');
                  logoPixels += count;
                }
                if (titleRect != null) {
                  titlePixels = paintedPixels(titleRect);
                  expect(
                    titlePixels,
                    greaterThan(20),
                    reason: '$name painted first-frame title',
                  );
                }
                final bytes = await image.toByteData(
                  format: ui.ImageByteFormat.png,
                );
                await File(path).parent.create(recursive: true);
                await File(path).writeAsBytes(bytes!.buffer.asUint8List());
              } finally {
                image.dispose();
              }
            });
            manifest.add({
              'scenario': name,
              'path': path,
              'scrollOffset': offset,
              'maxScrollExtent': scroll.maxScrollExtent,
              'viewportDimension': scroll.viewportDimension,
              'coverage': wholePage ? 'full-page' : 'target',
              'frame': page == 1
                  ? 'header'
                  : focus != null
                  ? 'target'
                  : 'page',
              'targetVisible': targetVisible,
              'decodedImagesChecked': true,
              'paintedLogoPixels': logoPixels,
              'paintedTitlePixels': titlePixels,
              'headerPixelsChecked': page == 1,
              'width': width,
              'height': 844,
              'textScale': scale,
              'language': language.name,
            });
            if (focus != null) {
              if (page == 1) {
                await reveal(focus);
                await settlePage(scroll);
                if ((scroll.pixels - offset).abs() > 1) {
                  continue;
                }
                expect(targetVisible, isTrue, reason: '$name target at top');
              }
              break;
            }
            if (!wholePage || scroll.pixels >= scroll.maxScrollExtent - 1) {
              break;
            }
            scroll.jumpTo(
              math.min(
                scroll.pixels + scroll.viewportDimension * .75,
                scroll.maxScrollExtent,
              ),
            );
            await settlePage(scroll);
          }
          if (wholePage) {
            expect(offsets.first, 0);
            expect(
              offsets.last,
              closeTo(scroll.maxScrollExtent, 1),
              reason: '$name must cover the page bottom',
            );
          }
          scroll.jumpTo(0);
          await tester.pump();
        }

        Future<void> tap(String key, {bool busy = false}) async {
          final target = find.byKey(Key(key));
          await reveal(target);
          if (busy) {
            await tester.pump();
          } else {
            await tester.pumpAndSettle();
          }
          await tester.tap(target);
          if (busy) {
            await tester.pump(const Duration(milliseconds: 400));
          } else {
            await tester.pumpAndSettle();
          }
        }

        Future<void> type(String key, String value, {bool busy = false}) async {
          final target = find.byKey(Key(key));
          await reveal(target);
          await tester.enterText(target, value);
          await tester.pump(const Duration(milliseconds: 400));
          if (!busy) await tester.pumpAndSettle();
        }

        Future<void> refreshProfile() async {
          await tester.runAsync(() => session.refreshAccount());
          container.invalidate(profileControllerProvider);
          await tester.pumpAndSettle();
        }

        await capture('profile-ready');
        expect(find.byKey(const Key('nav-charging')), findsOneWidget);
        withVehicle = false;
        creditError = true;
        await refreshProfile();
        container.invalidate(chargingCreditProvider);
        await capture('profile-empty-credit-error');
        pagePosition().jumpTo(0);
        await tester.pump();
        expect(
          find.text(
            language == AppLanguage.english
                ? 'No vehicles yet.'
                : 'Chưa có xe trong hồ sơ.',
          ),
          findsOneWidget,
        );
        withVehicle = true;
        creditError = false;
        await refreshProfile();
        container.invalidate(chargingCreditProvider);

        router.go('/loyalty');
        await tester.pumpAndSettle();
        await capture('loyalty-available');
        expect(find.text('6000'), findsOneWidget);
        final badgeText = language == AppLanguage.english
            ? 'PowerMe rewards'
            : 'Điểm thưởng PowerMe';
        final paragraph = tester.renderObject<RenderParagraph>(
          find.descendant(
            of: find.text(badgeText),
            matching: find.byType(RichText),
          ),
        );
        final wordStart = badgeText.indexOf('PowerMe');
        expect(
          paragraph.getBoxesForSelection(
            TextSelection(baseOffset: wordStart, extentOffset: wordStart + 7),
          ),
          hasLength(1),
          reason: 'PowerMe must stay a whole word',
        );
        final refreshSize = tester.getSize(
          find.byKey(const Key('loyalty-refresh')),
        );
        expect(refreshSize.width, greaterThanOrEqualTo(48));
        expect(refreshSize.height, greaterThanOrEqualTo(48));
        for (final next in ['zero', 'error', 'loading']) {
          scenario = next;
          available = next == 'zero' ? 0 : 6000;
          await tap('loyalty-refresh', busy: next == 'loading');
          await capture('loyalty-$next', busy: next == 'loading');
          expect(find.text('6000'), findsNothing);
          if (next == 'zero') {
            expect(find.text('0'), findsOneWidget);
            expect(
              tester
                  .widget<FilledButton>(find.byKey(const Key('redeem-points')))
                  .onPressed,
              isNotNull,
            );
          }
          if (next == 'error') {
            expect(
              find.textContaining(
                language == AppLanguage.english
                    ? 'Could not load'
                    : 'Chưa tải được điểm',
              ),
              findsOneWidget,
            );
          }
          if (next == 'loading') {
            expect(find.byType(LinearProgressIndicator), findsOneWidget);
          }
        }
        for (final pending in waiting) {
          if (!pending.isCompleted) {
            pending.complete(reply(200, loyaltyQuote()));
          }
        }
        await tester.pumpAndSettle();
        scenario = 'available';
        available = 6000;
        router.go('/credit/top-up');
        await tester.pumpAndSettle();
        await tap('top-up-preset-200000');
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pumpAndSettle();
        expect(
          tester.widget<Text>(find.byKey(const Key('top-up-payable'))).data,
          language == AppLanguage.english ? '200,000 VND' : '200.000 đ',
        );
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('top-up-points')))
              .controller!
              .text,
          anyOf('', '0'),
        );
        await capture('top-up-zero-points');
        await tap('top-up-points-max');
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('top-up-points')))
              .controller!
              .text,
          '2500',
        );
        await capture(
          'top-up-max-points',
          wholePage: false,
          focus: find.byKey(const Key('top-up-points')),
        );
        await capture(
          'top-up-max-points-summary',
          wholePage: false,
          focus: find.byKey(const Key('top-up-payable-summary')),
        );
        expect(
          tester.widget<Text>(find.byKey(const Key('top-up-payable'))).data,
          language == AppLanguage.english ? '175,000 VND' : '175.000 đ',
        );
        await type('top-up-points', '600');
        expect(find.byKey(const Key('top-up-payable')), findsNothing);
        expect(find.byKey(const Key('top-up-payable-unknown')), findsOneWidget);
        await capture(
          'top-up-partial-unknown',
          wholePage: false,
          focus: find.byKey(const Key('top-up-points')),
        );
        await capture(
          'top-up-partial-unknown-summary',
          wholePage: false,
          focus: find.byKey(const Key('top-up-payable-summary')),
        );
        expect(
          find.text(
            language == AppLanguage.english
                ? 'Review payment amount'
                : 'Xem số tiền thanh toán',
          ),
          findsOneWidget,
        );
        await capture(
          'top-up-partial-review-action',
          wholePage: false,
          focus: find.byKey(const Key('top-up-create')),
        );
        await type('top-up-points', 'abc');
        expect(find.byKey(const Key('top-up-payable')), findsNothing);
        expect(
          tester
              .widget<FilledButton>(find.byKey(const Key('top-up-create')))
              .onPressed,
          isNull,
        );
        await capture(
          'top-up-invalid-points',
          wholePage: false,
          focus: find.byKey(const Key('top-up-points')),
        );
        await capture(
          'top-up-invalid-points-summary',
          wholePage: false,
          focus: find.byKey(const Key('top-up-payable-summary')),
        );
        await type('top-up-amount', 'abc');
        expect(find.byKey(const Key('top-up-payable')), findsNothing);
        expect(
          tester
              .widget<FilledButton>(find.byKey(const Key('top-up-create')))
              .onPressed,
          isNull,
        );
        await capture(
          'top-up-invalid-amount',
          wholePage: false,
          focus: find.byKey(const Key('top-up-amount')),
        );
        scenario = 'quote-error';
        await type('top-up-amount', '100000');
        await capture(
          'top-up-quote-error',
          wholePage: false,
          focus: find.text(
            language == AppLanguage.english
                ? 'The quote is unavailable.'
                : 'Chưa tải được báo giá.',
          ),
        );
        scenario = 'quote-loading';
        await type('top-up-amount', '200000', busy: true);
        await capture(
          'top-up-quote-loading',
          busy: true,
          wholePage: false,
          focus: find.byType(LinearProgressIndicator),
        );
        for (final pending in waiting) {
          if (!pending.isCompleted) {
            pending.complete(
              reply(
                200,
                loyaltyQuote(available: 6000, maximum: 2500, discount: 25000),
              ),
            );
          }
        }
        await tester.pumpAndSettle();
        scenario = 'available';
        await type('top-up-points', '600');
        await tap('top-up-create');
        expect(launches, isEmpty);
        expect(
          fixture.requests.any(
            (r) => r.method == 'GET' && r.path == 'billing/top-ups/31',
          ),
          isTrue,
        );
        expect(
          find.text(
            language == AppLanguage.english ? '187,600 VND' : '187.600 đ',
          ),
          findsOneWidget,
        );
        await capture('top-up-pending-get-disclosure');
        expect(
          fixture.requests.where(
            (r) =>
                r.method != 'GET' &&
                r.path != 'auth/login' &&
                r.path != 'billing/top-ups',
          ),
          isEmpty,
        );
        expect(
          fixture.requests.where((r) => r.path == 'billing/top-ups'),
          hasLength(1),
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        await tester.runAsync(
          () => File(
            '$directory/manifest.json',
          ).writeAsString(const JsonEncoder.withIndent('  ').convert(manifest)),
        );
      });
    }
  }
}

class _ReviewProfile extends ProfileController {
  _ReviewProfile(this.language);
  final AppLanguage language;
  DriverProfile _localized(DriverProfile p) => DriverProfile(
    displayName: p.displayName,
    email: 'minh.an+powerme@example.invalid',
    language: language,
    vehicles: p.vehicles,
    selectedVehicleId: p.selectedVehicleId,
    revision: p.revision,
  );
  @override
  ProfileState build() => ProfileState(_localized(super.build().profile));
  @override
  Future<bool> refresh() async {
    final result = await super.refresh();
    state = ProfileState(
      _localized(state.profile),
      busy: state.busy,
      failure: state.failure,
    );
    return result;
  }
}

Future<void> _loadFonts() async {
  const fonts = String.fromEnvironment('POWERME_PREVIEW_FONTS');
  expect(fonts, isNotEmpty);
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
