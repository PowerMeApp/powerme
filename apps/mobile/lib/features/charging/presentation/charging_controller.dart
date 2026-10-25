import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../stations/domain/station_models.dart';
import '../domain/charging_models.dart';

final chargingControllerProvider =
    NotifierProvider<ChargingController, ChargingFlowState>(
      ChargingController.new,
    );

class ChargingController extends Notifier<ChargingFlowState> {
  @override
  ChargingFlowState build() => const ChargingFlowState();

  Future<void> startCommand(Station station, Connector connector) async {
    state = ChargingFlowState(
      station: station,
      connector: connector,
      commandStatus: CommandStatus.sending,
      sessionState: SessionState.preparing,
      connectionStatus: ConnectionStatus.online,
      dataQuality: DataQuality.live,
      message: 'Đang gửi yêu cầu đến trụ mô phỏng.',
    );
    await Future<void>.delayed(const Duration(milliseconds: 450));
    if (state.commandStatus == CommandStatus.sending) {
      state = state.copyWith(
        commandStatus: CommandStatus.accepted,
        message: 'Trụ đã nhận yêu cầu. Đang chờ StartTransaction.',
      );
    }
  }

  void simulateStartTransaction() {
    if (state.commandStatus != CommandStatus.accepted) return;
    final now = DateTime.now().toUtc();
    state = state.copyWith(
      sessionState: SessionState.charging,
      connectionStatus: ConnectionStatus.online,
      dataQuality: DataQuality.live,
      session: ChargingSession(
        id: 'sim-session-001',
        energyWh: 10000,
        estimatedCostVnd: 30000,
        startedAt: now.subtract(const Duration(minutes: 20)),
        lastUpdated: now,
        soc: null,
      ),
      message: 'StartTransaction đã được ghi nhận. Chỉ số là dữ liệu mô phỏng.',
    );
  }

  void simulateRejected() {
    if (state.commandStatus != CommandStatus.accepted ||
        state.session != null) {
      return;
    }
    state = state.copyWith(
      commandStatus: CommandStatus.rejected,
      sessionState: SessionState.none,
      message:
          'Simulator từ chối yêu cầu khởi động. Không tự gửi lại bằng key mới.',
    );
  }

  void simulateSuspended() {
    if (state.session == null) return;
    state = state.copyWith(
      sessionState: SessionState.suspendedEv,
      message: 'Xe đang tạm dừng truyền năng lượng.',
    );
  }

  void simulateStale() {
    if (state.session == null) return;
    state = state.copyWith(
      connectionStatus: ConnectionStatus.stale,
      dataQuality: DataQuality.stale,
      message: 'Chưa nhận chỉ số mới. Đang hiển thị last-known.',
    );
  }

  void reconnect() {
    if (state.session == null) return;
    state = state.copyWith(
      connectionStatus: ConnectionStatus.online,
      dataQuality: DataQuality.live,
      message: 'Đã khôi phục kết nối và lấy lại snapshot.',
    );
  }

  void requestStop() {
    if (!state.hasActiveSession || state.stopRequested) return;
    state = state.copyWith(
      commandStatus: CommandStatus.sending,
      sessionState: SessionState.finishing,
      stopRequested: true,
      message: 'Đang chờ xác nhận dừng từ hệ thống.',
    );
  }

  void simulateStopEvidence() {
    if (!state.stopRequested || state.session == null) return;
    final now = DateTime.now().toUtc();
    state = state.copyWith(
      commandStatus: CommandStatus.accepted,
      sessionState: SessionState.ended,
      connectionStatus: ConnectionStatus.online,
      dataQuality: DataQuality.live,
      summary: ChargeSummary(
        sessionId: state.session!.id,
        energyWh: state.session!.energyWh,
        amountVnd: state.session!.estimatedCostVnd,
        reason: 'Dừng từ ứng dụng',
        endedAt: now,
      ),
      message:
          'Đã nhận StopTransaction. Số tiền cuối cùng còn chờ đối soát nếu có.',
    );
  }

  void simulateStopUnknown() {
    if (!state.stopRequested) return;
    state = state.copyWith(
      commandStatus: CommandStatus.unknown,
      connectionStatus: ConnectionStatus.offline,
      dataQuality: DataQuality.unavailable,
      message: 'Chưa xác nhận được kết quả dừng. Không tạo lệnh mới tự động.',
    );
  }

  void queryStopResult() {
    if (state.commandStatus != CommandStatus.unknown) return;
    state = state.copyWith(
      connectionStatus: ConnectionStatus.online,
      dataQuality: DataQuality.stale,
      message: 'Đã gửi yêu cầu tra cứu snapshot hiện có.',
    );
  }
}
