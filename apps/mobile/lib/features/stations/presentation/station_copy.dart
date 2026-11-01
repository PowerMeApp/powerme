import '../../../core/l10n/app_copy.dart';
import '../domain/station.dart';

String statusLabel(StationStatus status, AppCopy copy) => switch (status) {
  StationStatus.available => copy.text('Có thể sạc', 'Available'),
  StationStatus.inUse => copy.text('Đang sử dụng', 'In use'),
  StationStatus.freeingSoon => copy.text('Sắp trống', 'Freeing soon'),
  StationStatus.unavailable => copy.text('Không khả dụng', 'Unavailable'),
  StationStatus.offline => copy.text('Mất kết nối', 'Offline'),
};
String updatedLabel(DateTime time, AppCopy copy) {
  final ict = time.toUtc().add(const Duration(hours: 7));
  String two(int n) => n.toString().padLeft(2, '0');
  return '${copy.text('Cập nhật', 'Updated')} ${two(ict.hour)}:${two(ict.minute)} · ${two(ict.day)}/${two(ict.month)}/${ict.year} ICT';
}
