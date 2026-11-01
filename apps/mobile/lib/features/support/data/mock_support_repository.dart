import '../../../demo/demo_store.dart';
import '../../../demo/station_actions_store.dart';
import '../../auth/domain/auth_scope.dart';
import '../../stations/domain/station_actions.dart';
import '../domain/support_repository.dart';

class MockSupportRepository implements SupportRepository {
  MockSupportRepository(this.store, this.actions, this.scope, this.stations);
  final DemoStore store;
  final StationActionsStore actions;
  final AuthScope scope;
  final StationActionsRepository stations;
  @override
  Future<FaultReport> submit(
    String connectorId,
    String category,
    String note,
    String key,
  ) async {
    store.requireScope(scope);
    if (![
          'Không khởi động',
          'Cáp / đầu nối',
          'Màn hình',
          'Khác',
        ].contains(category) ||
        note.trim().length < 5 ||
        note.length > 500) {
      throw StateError('Chọn loại lỗi và mô tả từ 5–500 ký tự.');
    }
    final connector = await stations.resolve(connectorId);
    store.requireScope(scope);
    final identity = '${scope.principalId}/$key';
    final old = actions.reportKeys[identity];
    if (old != null) {
      if (old.connectorId != connectorId ||
          old.category != category ||
          old.note != note.trim()) {
        throw StateError('Nội dung yêu cầu đã thay đổi.');
      }
      return old;
    }
    final report = FaultReport(
      id: 'report-${++actions.serial}',
      connectorId: connectorId,
      category: category,
      note: note.trim(),
      savedAt: actions.clock().toUtc(),
    );
    actions.reportKeys[identity] = report;
    (actions.reports[scope.principalId] ??= []).add(report);
    final recentOwners = actions.reports.entries
        .where(
          (entry) => entry.value.any(
            (r) =>
                r.connectorId == connectorId &&
                actions.clock().difference(r.savedAt).inHours < 2,
          ),
        )
        .map((e) => e.key)
        .toSet();
    if (recentOwners.length >= 2 || connector.status.name != 'available') {
      store.reportedConnectors.add(connectorId);
    }
    return report;
  }

  @override
  Future<List<FaultReport>> ownedReports() async {
    store.requireScope(scope);
    return List.unmodifiable(actions.reports[scope.principalId] ?? []);
  }
}
