import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/application/auth_controller.dart';
import '../../../core/format.dart';
import '../../../core/l10n/app_copy.dart';
import '../../profile/application/profile_controller.dart';
import '../../profile/domain/driver_profile.dart';
import '../domain/support_repository.dart';
import '../../stations/application/stations_controller.dart';

final reportConnectorLabelProvider = Provider.family<String, String>((ref, id) {
  AppCopy copy;
  try {
    copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
  } catch (_) {
    copy = const AppCopy(AppLanguage.vietnamese);
  }
  final parts = id.split('/');
  if (parts.length != 2) {
    return copy.text('Cổng sạc chưa xác định', 'Unidentified connector');
  }
  final station = ref.watch(stationDetailProvider(parts.first));
  if (station == null ||
      !station.connectors.any((c) => '${c.number}' == parts.last)) {
    return copy.text('Cổng sạc chưa xác định', 'Unidentified connector');
  }
  return '${station.name} · ${copy.text('Cổng', 'Connector')} ${parts.last}';
});

final supportRepositoryProvider = Provider<SupportRepository>(
  (ref) => throw StateError('Select support adapter.'),
);
final supportControllerProvider =
    NotifierProvider<SupportController, SupportState>(SupportController.new);

class SupportState {
  const SupportState({this.busy = false, this.report, this.error});
  final bool busy;
  final FaultReport? report;
  final String? error;
}

class SupportController extends Notifier<SupportState> {
  int _request = 0;
  String? _payload;
  String? _key;
  @override
  SupportState build() {
    ref.watch(authScopeProvider);
    ++_request;
    _payload = null;
    _key = null;
    return const SupportState();
  }

  void clear() {
    ++_request;
    _payload = null;
    _key = null;
    state = const SupportState();
  }

  Future<void> submit(String connector, String category, String note) async {
    if (state.busy) return;
    final scope = ref.read(authScopeProvider);
    final payload = '$connector|$category|${note.trim()}';
    if (_payload != payload) {
      _payload = payload;
      _key =
          'report/${scope.generation}/${DateTime.now().microsecondsSinceEpoch}';
    }
    final n = ++_request;
    state = const SupportState(busy: true);
    try {
      final report = await ref
          .read(supportRepositoryProvider)
          .submit(connector, category, note, _key!);
      if (ref.mounted &&
          n == _request &&
          identical(scope, ref.read(authScopeProvider))) {
        state = SupportState(report: report);
      }
    } catch (e) {
      if (ref.mounted &&
          n == _request &&
          identical(scope, ref.read(authScopeProvider))) {
        state = SupportState(error: failureText(e));
      }
    }
  }
}
