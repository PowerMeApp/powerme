import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/format.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_scope.dart';
import '../../profile/application/profile_controller.dart';
import '../../stations/application/station_actions_controller.dart';
import '../domain/charging.dart';

final chargingRepositoryProvider = Provider<ChargingRepository>(
  (ref) => throw StateError('Select charging adapter.'),
);
final chargingControllerProvider =
    NotifierProvider<ChargingController, ChargingViewState>(
      ChargingController.new,
    );

class ChargingViewState {
  const ChargingViewState({
    this.preview,
    this.request,
    this.session,
    this.command,
    this.busy = false,
    this.error,
  });
  final StartPreview? preview;
  final StartRequest? request;
  final SessionSnapshot? session;
  final CommandOutcome? command;
  final bool busy;
  final String? error;
}

class ChargingController extends Notifier<ChargingViewState> {
  int _work = 0;
  int _serial = 0;
  String? _expectedId;
  int _watchGeneration = 0;
  StreamSubscription<SessionSnapshot>? _subscription;
  ChargingRepository get repository => ref.read(chargingRepositoryProvider);
  AuthScope get scope => ref.read(authScopeProvider);
  SessionSnapshot? get session => state.session;
  CommandOutcome? get command => state.command;
  @override
  ChargingViewState build() {
    ref.watch(authScopeProvider);
    ref.watch(chargingRepositoryProvider);
    ++_work;
    _expectedId = null;
    ++_watchGeneration;
    _subscription?.cancel();
    _subscription = null;
    ref.onDispose(dispose);
    final n = _work;
    Future.microtask(() {
      if (ref.mounted && n == _work) restore();
    });
    return const ChargingViewState();
  }

  void dispose() {
    ++_work;
    ++_watchGeneration;
    _subscription?.cancel();
    _subscription = null;
  }

  bool current(AuthScope captured, int n) =>
      ref.mounted &&
      n == _work &&
      captured.principalId == scope.principalId &&
      captured.generation == scope.generation;
  Future<void> restore() async {
    final r = repository;
    if (r is! ChargingPreparation) return;
    final captured = scope;
    final n = ++_work;
    try {
      final s = await (r as ChargingPreparation).current();
      if (current(captured, n) && s != null) {
        _expectedId = s.sessionId;
        _accept(s, authoritative: true);
        watch(s.sessionId);
      }
    } catch (e) {
      if (current(captured, n)) update(error: failureText(e));
    }
  }

  void update({
    StartPreview? preview,
    StartRequest? request,
    SessionSnapshot? session,
    CommandOutcome? command,
    bool busy = false,
    String? error,
  }) {
    state = ChargingViewState(
      preview: preview ?? state.preview,
      request: request ?? state.request,
      session: session ?? state.session,
      command: command ?? state.command,
      busy: busy,
      error: error,
    );
  }

  Future<void> prepare(
    String connector,
    ChargingMode mode,
    String input,
  ) async {
    if (state.busy ||
        command?.status == CommandState.unknown ||
        session != null &&
            session!.state != SessionState.reconciled &&
            session!.state != SessionState.failed) {
      return;
    }
    final captured = scope;
    final vehicle = ref.read(profileControllerProvider).profile.vehicleId;
    final n = ++_work;
    final previous = state.command == null ? state.request : null;
    ++_watchGeneration;
    _subscription?.cancel();
    _subscription = null;
    _expectedId = null;
    state = const ChargingViewState(busy: true);
    try {
      final value = mode == ChargingMode.autoFull
          ? null
          : double.tryParse(input.replaceAll(',', '.'));
      if (mode != ChargingMode.autoFull &&
          (value == null || !value.isFinite || value <= 0)) {
        throw StateError('Nhập giới hạn hợp lệ.');
      }
      final units = switch (mode) {
        ChargingMode.timed => 60,
        ChargingMode.energy => 1000,
        _ => 1,
      };
      final limit = value == null ? null : (value * units).round();
      final option = await ref
          .read(stationActionsRepositoryProvider)
          .resolve(connector);
      if (!current(captured, n)) return;
      connector = option.connectorId;
      final preparation = repository as ChargingPreparation;
      final preview = await preparation.preview(
        connector,
        vehicle,
        mode,
        limit,
      );
      if (!current(captured, n)) return;
      if (vehicle != ref.read(profileControllerProvider).profile.vehicleId) {
        state = const ChargingViewState(
          error: 'Xe đã thay đổi. Vui lòng kiểm tra lại.',
        );
        return;
      }
      final fingerprint =
          '$connector/$vehicle/${mode.name}/${preview.effectiveLimit}';
      final key = previous?.fingerprint == fingerprint
          ? previous!.key
          : 'start/${captured.principalId}/${captured.generation}/${DateTime.now().microsecondsSinceEpoch}/${++_serial}';
      state = ChargingViewState(
        preview: preview,
        session: session,
        request: StartRequest(
          scope: captured,
          connectorId: connector,
          vehicleId: vehicle,
          mode: mode,
          limitValue: preview.effectiveLimit,
          key: key,
        ),
      );
    } catch (e) {
      if (current(captured, n)) update(error: failureText(e));
    }
  }

  Future<void> startPrepared() async {
    final request = state.request;
    if (request != null &&
        request.vehicleId !=
            ref.read(profileControllerProvider).profile.vehicleId) {
      state = const ChargingViewState(
        error: 'Xe đã thay đổi. Kiểm tra lại trước khi bắt đầu.',
      );
      return;
    }
    if (request != null) await start(request);
  }

  Future<void> start(StartRequest request) async {
    if (state.busy ||
        command?.status == CommandState.unknown ||
        session != null &&
            session!.state != SessionState.reconciled &&
            session!.state != SessionState.failed) {
      return;
    }
    await runCommand(request.key, () => repository.start(request));
  }

  Future<void> stop(String sessionId, String key) async {
    if (state.busy || command?.status == CommandState.unknown) return;
    await runCommand(key, () => repository.stop(sessionId, key));
  }

  Future<void> stopCurrent() async {
    final s = session;
    if (s != null && !s.ended) {
      await stop(s.sessionId, 'stop/${scope.principalId}/${s.sessionId}');
    }
  }

  Future<void> recover(String key) async {
    if (!state.busy) await runCommand(key, () => repository.outcome(key));
  }

  Future<void> runCommand(
    String key,
    Future<CommandOutcome> Function() action,
  ) async {
    final captured = scope;
    final n = ++_work;
    update(busy: true);
    try {
      final c = await action();
      if (!current(captured, n) ||
          c.scope.principalId != captured.principalId ||
          c.scope.generation != captured.generation ||
          c.requestKey != key) {
        return;
      }
      if (command?.requestKey == key &&
          command?.status != CommandState.unknown &&
          c.version < command!.version) {
        update();
        return;
      }
      if (c.sessionId != null && c.sessionId != _expectedId) {
        _expectedId = c.sessionId;
        state = ChargingViewState(
          preview: state.preview,
          request: state.request,
          command: c,
          error: c.reasonCode,
        );
      } else {
        update(command: c, error: c.reasonCode);
      }
      if (c.sessionId != null) watch(c.sessionId!);
    } catch (_) {
      if (current(captured, n)) {
        update(
          command: CommandOutcome(
            scope: captured,
            requestKey: key,
            status: CommandState.unknown,
            version: 0,
            sessionId: session?.sessionId,
          ),
          error: 'Chưa rõ kết quả. Kiểm tra lại bằng yêu cầu hiện tại.',
        );
      }
    }
  }

  void watch(String id) {
    _subscription?.cancel();
    final captured = scope;
    final generation = ++_watchGeneration;
    _expectedId = id;
    _subscription = repository
        .watch(id)
        .listen(
          (snapshot) {
            if (ref.mounted &&
                generation == _watchGeneration &&
                captured.principalId == scope.principalId &&
                captured.generation == scope.generation) {
              apply(snapshot);
            }
          },
          onError: (Object e) {
            if (ref.mounted &&
                generation == _watchGeneration &&
                captured.principalId == scope.principalId &&
                captured.generation == scope.generation) {
              update(
                error:
                    'Chưa nhận được cập nhật. Giữ số liệu gần nhất và kiểm tra lại.',
              );
            }
          },
        );
  }

  Future<void> resync(String sessionId) async {
    if (state.busy) return;
    final captured = scope;
    final n = ++_work;
    update(busy: true);
    try {
      final snapshot = await repository.snapshot(sessionId);
      if (!current(captured, n)) return;
      _accept(snapshot, authoritative: true);
      update();
    } catch (_) {
      if (current(captured, n)) {
        update(error: 'Chưa kết nối được. Số liệu gần nhất được giữ nguyên.');
      }
    }
  }

  bool isCurrent(SessionSnapshot snapshot) {
    final expected = _expectedId ?? command?.sessionId ?? session?.sessionId;
    return snapshot.scope.principalId == scope.principalId &&
        snapshot.scope.generation == scope.generation &&
        (expected == null || expected == snapshot.sessionId) &&
        (session == null || snapshot.version > session!.version) &&
        (snapshot.statement == null ||
            snapshot.statement!.scope.principalId == scope.principalId &&
                snapshot.statement!.scope.generation == scope.generation &&
                snapshot.statement!.sessionId == snapshot.sessionId);
  }

  void apply(SessionSnapshot snapshot) => _accept(snapshot);
  void _accept(SessionSnapshot snapshot, {bool authoritative = false}) {
    if (!ref.mounted || !isCurrent(snapshot)) return;
    if (!authoritative &&
        session != null &&
        snapshot.version > session!.version + 1) {
      if (!state.busy) unawaited(resync(snapshot.sessionId));
      return;
    }
    update(session: snapshot, busy: state.busy);
  }
}

final _statementCacheProvider = Provider((ref) {
  ref.watch(authScopeProvider);
  return <String, SessionSnapshot>{};
});
final statementProvider = FutureProvider.autoDispose
    .family<SessionSnapshot, String>((ref, id) async {
      final scope = ref.watch(authScopeProvider);
      final snapshot = await ref.watch(chargingRepositoryProvider).snapshot(id);
      if (!ref.mounted ||
          snapshot.scope.principalId != scope.principalId ||
          snapshot.scope.generation != scope.generation ||
          snapshot.sessionId != id ||
          snapshot.statement != null &&
              (snapshot.statement!.sessionId != id ||
                  snapshot.statement!.scope.principalId != scope.principalId ||
                  snapshot.statement!.scope.generation != scope.generation)) {
        throw StateError('Không tìm thấy bảng kê thuộc tài khoản.');
      }
      final cache = ref.read(_statementCacheProvider);
      final previous = cache[id];
      if (previous != null && snapshot.version < previous.version) {
        return previous;
      }
      cache[id] = snapshot;
      return snapshot;
    });
