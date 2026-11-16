import '../../../core/l10n/app_copy.dart';

String roadDistance(double distanceM, AppCopy copy) {
  if (distanceM < 1000) return '${distanceM.round()} m';
  final km = (distanceM / 1000).toStringAsFixed(1);
  return copy.text('${km.replaceAll('.', ',')} km', '$km km');
}

String roadTravelTime(int durationSeconds, AppCopy copy) {
  final minutes = (durationSeconds / 60).ceil();
  return copy.text('$minutes phút', '$minutes min');
}

String heavyTrafficDistance(double distanceM, AppCopy copy) {
  final distance = roadDistance(distanceM, copy);
  return copy.text(
    '$distance ùn tắc nặng trở lên',
    '$distance of heavy or severe congestion',
  );
}
