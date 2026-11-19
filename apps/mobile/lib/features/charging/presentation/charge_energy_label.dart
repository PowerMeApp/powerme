import '../../../core/l10n/app_copy.dart';

String chargeEnergyLabel(int wh, AppCopy copy) {
  final separator = copy.text(',', '.');
  final fraction = (wh % 1000)
      .toString()
      .padLeft(3, '0')
      .replaceFirst(RegExp(r'0+$'), '');
  return '${wh ~/ 1000}${fraction.isEmpty ? '' : '$separator$fraction'} kWh';
}
