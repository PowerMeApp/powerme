import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/history_models.dart';

final historyRepositoryProvider = Provider<FakeHistoryRepository>(
  (ref) => FakeHistoryRepository(),
);
final historyEntriesProvider = Provider<List<HistoryEntry>>(
  (ref) => ref.watch(historyRepositoryProvider).entries,
);

class FakeHistoryRepository {
  List<HistoryEntry> get entries {
    final now = DateTime.now().toUtc();
    return [
      HistoryEntry(
        id: 'session-2026-09-08',
        stationName: 'PowerMe Nguyễn Huệ',
        date: now.subtract(const Duration(days: 2)),
        energyWh: 10000,
        amountVnd: 30000,
        invoiceStatus: InvoiceStatus.issued,
        paymentLabel: 'Đã thanh toán',
      ),
      HistoryEntry(
        id: 'session-2026-09-05',
        stationName: 'PowerMe Landmark 81',
        date: now.subtract(const Duration(days: 5)),
        energyWh: 7200,
        amountVnd: 25200,
        invoiceStatus: InvoiceStatus.pending,
        paymentLabel: 'Đang đối soát',
      ),
      HistoryEntry(
        id: 'session-2026-08-30',
        stationName: 'PowerMe Tân Sơn Nhất',
        date: now.subtract(const Duration(days: 11)),
        energyWh: 5400,
        amountVnd: 18900,
        invoiceStatus: InvoiceStatus.failed,
        paymentLabel: 'Thanh toán thất bại',
      ),
    ];
  }
}
