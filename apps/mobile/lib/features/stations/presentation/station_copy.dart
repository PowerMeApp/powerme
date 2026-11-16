import '../../../core/l10n/app_copy.dart';
import '../domain/station.dart';

String statusLabel(StationStatus status, AppCopy copy) => switch (status) {
  StationStatus.available => copy.text('Có thể sạc', 'Available'),
  StationStatus.inUse => copy.text('Đang sử dụng', 'In use'),
  StationStatus.freeingSoon => copy.text('Sắp trống', 'Freeing soon'),
  StationStatus.unavailable => copy.text('Không khả dụng', 'Unavailable'),
  StationStatus.offline => copy.text('Mất kết nối', 'Offline'),
  StationStatus.unknown => copy.text('Chưa rõ trạng thái', 'Status unknown'),
};
String updatedLabel(DateTime? time, AppCopy copy) {
  if (time == null) {
    return copy.text('Chưa rõ thời điểm cập nhật', 'Update time unknown');
  }
  final ict = time.toUtc().add(const Duration(hours: 7));
  String two(int n) => n.toString().padLeft(2, '0');
  return '${copy.text('Cập nhật', 'Updated')} ${two(ict.hour)}:${two(ict.minute)} · ${two(ict.day)}/${two(ict.month)}/${ict.year} ICT';
}

String stationAddress(Station station, AppCopy copy) =>
    station.address ?? copy.text('Chưa rõ địa chỉ', 'Address unknown');

String connectorPower(StationConnector connector, AppCopy copy) {
  final watts = connector.powerW;
  if (watts == null) return copy.text('Chưa rõ công suất', 'Power unknown');
  return '${watts % 1000 == 0 ? watts ~/ 1000 : watts / 1000} kW';
}

String connectorLabel(StationConnector connector, AppCopy copy) {
  final number = copy.text(
    'Cổng ${connector.number}',
    'Connector ${connector.number}',
  );
  final point = connector.displayCode ?? connector.chargePointId;
  return point == null
      ? number
      : '${copy.text('Trụ', 'Charger')} $point · $number';
}

String connectorStatus(StationConnector connector, AppCopy copy) {
  final status = statusLabel(connector.status, copy);
  final quality = switch (connector.quality) {
    DataQuality.observed => null,
    DataQuality.stale => copy.text('Dữ liệu có thể đã cũ', 'Data may be stale'),
    DataQuality.unknown => copy.text('Chưa rõ độ mới', 'Freshness unknown'),
  };
  return quality == null ? status : '$status · $quality';
}
