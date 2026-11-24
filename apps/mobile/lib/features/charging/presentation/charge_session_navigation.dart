import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../application/charge_session_controller.dart';
import '../application/charge_start_controller.dart';
import '../domain/charge_session.dart';

void leaveChargeSession(WidgetRef ref, ChargeSessionTarget target) {
  if (ref.read(selectedChargeSessionProvider)?.target == target) {
    ref.read(selectedChargeSessionProvider.notifier).clear();
  }
  if (ref.read(chargeStartProvider)?.sessionTarget == target) {
    ref.read(chargeStartProvider.notifier).releaseFinishedSession();
  }
}
