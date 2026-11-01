class FaultReport {
  const FaultReport({
    required this.id,
    required this.connectorId,
    required this.category,
    required this.note,
    required this.savedAt,
  });
  final String id;
  final String connectorId;
  final String category;
  final String note;
  final DateTime savedAt;
}

abstract interface class SupportRepository {
  Future<FaultReport> submit(
    String connectorId,
    String category,
    String note,
    String key,
  );
  Future<List<FaultReport>> ownedReports();
}
