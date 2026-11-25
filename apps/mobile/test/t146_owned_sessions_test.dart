import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/charging/application/charge_session_controller.dart';
import 'package:driver_app/features/charging/application/charge_start_controller.dart';
import 'package:driver_app/features/charging/application/owned_sessions_controller.dart';
import 'package:driver_app/features/charging/data/api_owned_session_repository.dart';
import 'package:driver_app/features/charging/data/api_charge_session_repository.dart';
import 'package:driver_app/features/charging/domain/owned_sessions.dart';
import 'package:driver_app/features/charging/domain/charge_session.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/stations/domain/station.dart';
import 'driver_api_fixture.dart';
import 't146_session_fixture.dart';
import 'package:driver_app/features/charging/domain/charge_start.dart';

const scopeA = AuthScope(principalId: '7', generation: 1);
const scopeB = AuthScope(principalId: '8', generation: 2);
OwnedSessionPage decode(Map<String, dynamic> json) =>
    decodeOwnedSessionPage(json, scope: scopeA, page: 1, pageSize: 20);

void main() {
  test('bigint strings, null actuals and captured scope survive decoding', () {
    final item = decode(
      ownedPageJson([ownedSessionJson(id: '9223372036854775807')]),
    ).items.single;
    expect(item.id, '9223372036854775807');
    expect(item.scope, same(scopeA));
    expect(item.vehicleId, isNull);
    expect(item.vehicleLabel, isNull);
    expect(item.energyWh, isNull);
    expect(item.amountVnd, isNull);
  });
  test('future string enums remain unknown with fail-closed capabilities', () {
    final row = ownedSessionJson()
      ..addAll({
        'origin': 'future',
        'status': 'future',
        'payment_mode': 'future',
        'settlement_state': 'future',
      });
    final item = decode(ownedPageJson([row])).items.single;
    expect(item.origin, SessionOrigin.unknown);
    expect(item.status, SessionState.unknown);
    expect(item.paymentMode, PaymentMode.unknown);
    expect(item.settlement, SettlementState.unknown);
    expect(item.canStop, false);
    expect(item.statementEligible, false);
  });
  for (final field in [
    'status',
    'origin',
    'payment_mode',
    'settlement_state',
  ]) {
    test('reject wrong JSON type for $field', () {
      for (final value in [false, 4, {}, []]) {
        expect(
          () => decode(ownedPageJson([ownedSessionJson()..[field] = value])),
          throwsA(isA<ChargeSessionException>()),
        );
      }
    });
  }
  test('malformed capabilities, IDs, numbers, dates and paging fail', () {
    for (final patch in <Map<String, dynamic>>[
      {'can_stop': 'false'},
      {'statement_available': null},
      {'can_stop': true},
      {'session_id': 78},
      {'session_id': '9223372036854775808'},
      {'connector_no': 0},
      {'energy_wh': -1},
      {'amount_vnd': 0},
      {'energy_wh': 9007199254740992},
      {'started_at': 'yesterday'},
      {'updated_at': null},
    ]) {
      expect(
        () => decode(ownedPageJson([ownedSessionJson()..addAll(patch)])),
        throwsA(isA<ChargeSessionException>()),
      );
    }
    for (final patch in <Map<String, dynamic>>[
      {'items': {}},
      {'total': -1},
      {'total': 0},
      {'page': 2},
      {'page': 1.0},
      {'page_size': 100},
      {'total': null},
    ]) {
      expect(
        () => decode(ownedPageJson([ownedSessionJson()])..addAll(patch)),
        throwsA(isA<ChargeSessionException>()),
      );
    }
  });
  test(
    'actual zero is retained; final statement requires closed/stop/posted',
    () {
      final zero = decode(
        ownedPageJson([
          ownedSessionJson(
            status: 'closed',
            stopped: true,
            statement: true,
            amount: 0,
          ),
        ]),
      ).items.single;
      expect(zero.amountVnd, 0);
      expect(zero.statementEligible, true);
      for (final status in ['active', 'review', 'unknown']) {
        final item = decode(
          ownedPageJson([
            ownedSessionJson(
              status: status,
              statement: true,
              amount: 0,
              stopped: true,
            ),
          ]),
        ).items.single;
        expect(item.statementEligible, false);
      }
      expect(
        decode(
          ownedPageJson([ownedSessionJson(status: 'closed', statement: true)]),
        ).items.single.statementEligible,
        false,
      );
    },
  );
  test(
    'metadata copy preserves capability and final statement business guards',
    () {
      final request = StartRequest(
        scope: scopeA,
        connectorId: '31',
        vehicleId: '9',
        mode: ChargingMode.energy,
        limitValue: 1000,
        key: 'test-key',
      );
      final source = ChargeProgress(
        origin: SessionOrigin.rfid,
        paymentMode: PaymentMode.csmsBilled,
        serverCanStop: false,
        statementAvailable: true,
        status: SessionState.review,
        settlement: SettlementState.posted,
        connection: ConnectionState.online,
        quality: DataQuality.observed,
        updatedAt: DateTime.utc(2026),
        limitValue: null,
        billingModeMissing: true,
        consumedWh: 4,
        meterStopWh: 4,
        energyWh: 4,
        estimatedCostVnd: null,
        billingReviewRequired: false,
      );
      final copied = source.withStartContext(request);
      expect(copied.origin, SessionOrigin.rfid);
      expect(copied.serverCanStop, false);
      expect(copied.statementAvailable, true);
      expect(copied.statementEligible, false);
      expect(
        progress(
          origin: SessionOrigin.rfid,
          status: SessionState.active,
          statement: true,
          settlement: SettlementState.posted,
        ).statementEligible,
        false,
      );
    },
  );
  test('selection rejects captured A summary after logout/login B', () {
    final c = container();
    addTearDown(c.dispose);
    final old = summary(scopeA);
    expect(
      c
          .read(selectedChargeSessionProvider.notifier)
          .select(old, target: (scope: scopeA, id: old.id)),
      true,
    );
    c.read(testScopeProvider.notifier).change(signedOutScope);
    expect(c.read(selectedChargeSessionProvider), isNull);
    c.read(testScopeProvider.notifier).change(scopeB);
    expect(
      c
          .read(selectedChargeSessionProvider.notifier)
          .select(old, target: (scope: scopeB, id: old.id)),
      false,
    );
    expect(c.read(confirmedChargeSessionProvider), isNull);
  });
  test(
    'manual and automatic selection cannot replace unresolved own start',
    () {
      final c = container();
      addTearDown(c.dispose);
      (c.read(chargeStartProvider.notifier) as TestStart).put(
        ChargeStartState(attempt()),
      );
      final item = summary(scopeA);
      for (final automatic in [false, true]) {
        expect(
          c
              .read(selectedChargeSessionProvider.notifier)
              .select(
                item,
                target: (scope: scopeA, id: item.id),
                automatic: automatic,
              ),
          false,
        );
      }
    },
  );
  test(
    'same-key app recovery survives stopping=false eligibility; RFID retry sends nothing',
    () async {
      final repository = SessionRepo();
      final c = container(repository: repository);
      addTearDown(c.dispose);
      final app = summary(scopeA, origin: 'app_qr');
      final target = (scope: scopeA, id: app.id);
      expect(
        c
            .read(selectedChargeSessionProvider.notifier)
            .select(app, target: target),
        true,
      );
      final stop = c.read(chargeStopProvider.notifier);
      await stop.send(
        target,
        retry: false,
        progress: progress(origin: SessionOrigin.appQr, canStop: true),
      );
      final original = c.read(chargeStopProvider)!.key;
      final rfid = summary(scopeA, id: '79');
      expect(
        c
            .read(selectedChargeSessionProvider.notifier)
            .select(rfid, target: (scope: scopeA, id: '79')),
        false,
      );
      await stop.send(
        target,
        retry: true,
        progress: progress(
          origin: SessionOrigin.rfid,
          status: SessionState.stopping,
        ),
      );
      expect(repository.keys, [original]);
      await stop.send(
        target,
        retry: true,
        progress: progress(
          origin: SessionOrigin.appQr,
          status: SessionState.stopping,
        ),
      );
      expect(repository.keys, [original, original]);
      stop.recordProgress(
        target,
        progress(
          origin: SessionOrigin.appQr,
          status: SessionState.closed,
          meterStop: 1400,
        ),
      );
      expect(
        c
            .read(selectedChargeSessionProvider.notifier)
            .select(rfid, target: (scope: scopeA, id: '79')),
        true,
      );
    },
  );
  test(
    'explicit known-session switching preserves the unrelated own intent and context',
    () {
      final c = container();
      addTearDown(c.dispose);
      final own = ChargeStartState(
        attempt(),
        snapshot: const ChargeStartSnapshot(
          intentId: '41',
          sessionId: '79',
          outcome: ChargeStartOutcome.active,
          effectConfirmed: true,
          version: 1,
          maxLimitValue: null,
        ),
      );
      (c.read(chargeStartProvider.notifier) as TestStart).put(own);
      expect(c.read(matchingChargeStartProvider), same(own));
      final item = summary(scopeA);
      expect(
        c
            .read(selectedChargeSessionProvider.notifier)
            .select(item, target: (scope: scopeA, id: '78')),
        true,
      );
      expect(c.read(matchingChargeStartProvider), isNull);
      expect(c.read(chargeStartProvider), same(own));
      c.read(selectedChargeSessionProvider.notifier).clear();
      expect(c.read(confirmedChargeSessionProvider), (scope: scopeA, id: '79'));
      expect(c.read(matchingChargeStartProvider), same(own));
    },
  );
  test(
    'a final reading for another session cannot rebind a resolved stop key',
    () async {
      final repository = SessionRepo()..outcome = ChargeStopOutcome.rejected;
      final c = container(repository: repository);
      addTearDown(c.dispose);
      final a = summary(scopeA, origin: 'app_qr');
      c
          .read(selectedChargeSessionProvider.notifier)
          .select(a, target: (scope: scopeA, id: '78'));
      await c
          .read(chargeStopProvider.notifier)
          .send(
            (scope: scopeA, id: '78'),
            retry: false,
            progress: progress(origin: SessionOrigin.appQr, canStop: true),
          );
      final original = c.read(chargeStopProvider);
      final b = summary(scopeA, id: '79');
      expect(
        c
            .read(selectedChargeSessionProvider.notifier)
            .select(b, target: (scope: scopeA, id: '79')),
        true,
      );
      c.read(chargeStopProvider.notifier).recordProgress((
        scope: scopeA,
        id: '79',
      ), progress(status: SessionState.closed, meterStop: 1400));
      expect(c.read(chargeStopProvider), same(original));
      expect(c.read(currentChargeStopProvider), isNull);
    },
  );
  testWidgets(
    'sequential 5s discovery, pagination, cancellation and late response discard',
    (tester) async {
      final repo = ListRepo();
      var context = 1;
      final controller = ActiveSessionsController(
        repo,
        scopeA,
        contextToken: () => context,
      );
      addTearDown(controller.dispose);
      controller.setVisible(true);
      expect(repo.requests.length, 1);
      await tester.pump(const Duration(seconds: 20));
      expect(repo.requests.length, 1);
      context = 2;
      repo.requests[0].complete(decode(ownedPageJson([ownedSessionJson()])));
      await tester.pump();
      expect(controller.loadedContext, 1);
      await tester.pump(const Duration(seconds: 4));
      expect(repo.requests.length, 1);
      await tester.pump(const Duration(seconds: 1));
      expect(repo.requests.length, 2);
      controller.setVisible(false);
      expect(repo.cancels, 1);
      controller.setVisible(true);
      expect(repo.requests.length, 3);
      repo.requests[1].complete(
        decode(ownedPageJson([ownedSessionJson(id: '79')])),
      );
      await tester.pump();
      expect(controller.reading, true);
      expect(controller.page!.items.single.id, '78');
      repo.requests[2].complete(decode(ownedPageJson([])));
      await tester.pump();
      expect(controller.page!.total, 0);
      controller.changePage(2);
      expect(repo.pages.last, 2);
      controller.setVisible(false);
      await tester.pump(const Duration(seconds: 30));
      expect(repo.requests.length, 4);
    },
  );
  test(
    'list transport reuses auth/refresh, query and cancellation; errors never become empty',
    () async {
      var code = 401;
      var reads = 0;
      final fixture = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account(id: '7')),
          'auth/refresh' => reply(200, tokens(accessB, login: false)),
          'sessions' =>
            ++reads == 1
                ? reply(401, {'error': 'unauthorized'})
                : code == 401
                ? reply(200, ownedPageJson([ownedSessionJson()]))
                : reply(code, {'error': 'not_found'}),
          _ => throw StateError('Unexpected request'),
        },
      );
      final session = DriverApiSession(
        ApiConfig.parse('https://fixture.invalid/api/driver/v1'),
        adapter: fixture,
      );
      addTearDown(session.dispose);
      await session.signIn('driver@example.invalid', 'fixture');
      final repo = ApiOwnedSessionRepository(session);
      expect(
        (await repo.list(scopeA, view: OwnedSessionView.active).result).total,
        1,
      );
      expect(fixture.requests.last.queryParameters, {
        'view': 'active',
        'page': 1,
        'page_size': 20,
      });
      expect(fixture.requests.last.headers['Authorization'], 'Bearer $accessB');
      for (final status in [404, 503]) {
        code = status;
        await expectLater(
          repo.list(scopeA, view: OwnedSessionView.all).result,
          throwsA(isA<ChargeSessionException>()),
        );
      }
      for (final patch in [
        {'can_stop': 'false'},
        {'origin': null},
        {'statement_available': 3},
      ]) {
        final malformed = DriverApiFixture(
          (r) async => switch (r.path) {
            'auth/login' => reply(200, tokens(accessA)),
            'me' => reply(200, account(id: '7')),
            'sessions/78/progress' => reply(
              200,
              externalProgress()..addAll(patch),
            ),
            _ => throw StateError('Unexpected request'),
          },
        );
        final s = DriverApiSession(
          ApiConfig.parse('https://fixture.invalid/api/driver/v1'),
          adapter: malformed,
        );
        addTearDown(s.dispose);
        await s.signIn('driver@example.invalid', 'fixture');
        await expectLater(
          ApiChargeSessionRepository(
            s,
          ).progress((scope: scopeA, id: '78')).result,
          throwsA(isA<ChargeSessionException>()),
        );
      }
    },
  );
}

final testScopeProvider = NotifierProvider<TestScope, AuthScope>(TestScope.new);

class TestScope extends Notifier<AuthScope> {
  @override
  AuthScope build() => scopeA;
  void change(AuthScope scope) => state = scope;
}

class TestStart extends ChargeStartController {
  @override
  ChargeStartState? build() {
    ref.watch(authScopeProvider);
    return null;
  }

  void put(ChargeStartState value) => state = value;
}

ProviderContainer container({SessionRepo? repository}) => ProviderContainer(
  overrides: [
    authScopeProvider.overrideWith((ref) => ref.watch(testScopeProvider)),
    chargeStartProvider.overrideWith(TestStart.new),
    chargeSessionRepositoryProvider.overrideWithValue(
      repository ?? SessionRepo(),
    ),
  ],
);
ChargeStartAttempt attempt() => (
  request: StartRequest(
    scope: scopeA,
    connectorId: '31',
    vehicleId: '9',
    mode: ChargingMode.energy,
    limitValue: 1000,
    key: 'pending-key',
  ),
  connector: (
    id: '31',
    displayCode: 'PM-T146',
    number: 2,
    stationName: 'Trạm',
    status: StationStatus.available,
    reportedIssue: false,
    canRequestStart: true,
  ),
  vehicleLabel: 'Xe',
  draftInput: '1',
);

class SessionRepo implements ChargeSessionRepository {
  final keys = <String>[];
  ChargeStopOutcome outcome = ChargeStopOutcome.responseUnknown;
  @override
  Future<ChargeStopOutcome> stop(
    ChargeSessionTarget target,
    String key, {
    required bool recovering,
  }) async {
    keys.add(key);
    return outcome;
  }

  @override
  ChargeSessionRead<ChargeProgress> progress(ChargeSessionTarget target) =>
      throw UnimplementedError();
  @override
  ChargeSessionRead<PostedChargeStatement> statement(
    ChargeSessionTarget target,
  ) => throw UnimplementedError();
}

class ListRepo implements OwnedSessionRepository {
  final requests = <Completer<OwnedSessionPage>>[];
  final pages = <int>[];
  int cancels = 0;
  @override
  ChargeSessionRead<OwnedSessionPage> list(
    AuthScope scope, {
    required OwnedSessionView view,
    int page = 1,
    int pageSize = 20,
  }) {
    final request = Completer<OwnedSessionPage>();
    requests.add(request);
    pages.add(page);
    return (result: request.future, cancel: () => cancels++);
  }
}
