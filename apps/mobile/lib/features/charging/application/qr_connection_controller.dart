import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/format.dart';
import '../../auth/application/auth_controller.dart';
import '../../profile/application/profile_controller.dart';
import '../../stations/application/station_actions_controller.dart';
import '../domain/charging.dart';
import 'charging_controller.dart';

bool blocksQrConnection(ChargingViewState view) =>
    view.busy ||
    view.command?.status == CommandState.unknown ||
    view.command?.status == CommandState.requested ||
    view.command?.status == CommandState.accepted && view.session == null ||
    view.session != null && !view.session!.ended;

class QrConnectionState {
  const QrConnectionState({this.busy = false, this.error});
  final bool busy;
  final String? error;
}

final qrConnectionProvider =
    NotifierProvider.autoDispose<QrConnectionController, QrConnectionState>(
      QrConnectionController.new,
    );

class QrConnectionController extends Notifier<QrConnectionState> {
  int _generation = 0;
  @override
  QrConnectionState build() {
    ref.watch(authScopeProvider);
    ref.watch(profileControllerProvider.select((p) => p.profile.vehicleId));
    ++_generation;
    return const QrConnectionState();
  }

  Future<String?> resolve(String reference) async {
    if (state.busy ||
        blocksQrConnection(ref.read(chargingControllerProvider))) {
      return null;
    }
    final generation = ++_generation;
    state = const QrConnectionState(busy: true);
    try {
      final option = await ref
          .read(stationActionsRepositoryProvider)
          .resolve(reference);
      if (!ref.mounted || generation != _generation) return null;
      state = const QrConnectionState();
      if (blocksQrConnection(ref.read(chargingControllerProvider))) return null;
      return option.connectorId;
    } catch (error) {
      if (ref.mounted && generation == _generation) {
        state = QrConnectionState(error: failureText(error));
      }
      return null;
    }
  }
}
