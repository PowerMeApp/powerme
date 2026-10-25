enum InvoiceStatus { issued, pending, failed }

class HistoryEntry {
  const HistoryEntry({
    required this.id,
    required this.stationName,
    required this.date,
    required this.energyWh,
    required this.amountVnd,
    required this.invoiceStatus,
    required this.paymentLabel,
  });

  final String id;
  final String stationName;
  final DateTime date;
  final int energyWh;
  final int amountVnd;
  final InvoiceStatus invoiceStatus;
  final String paymentLabel;
}
