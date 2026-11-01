import '../../features/profile/domain/driver_profile.dart';

class AppCopy {
  const AppCopy(this.language);
  final AppLanguage language;
  String text(String vi, String en) =>
      language == AppLanguage.vietnamese ? vi : en;
  String get home => text('Khám phá', 'Discover');
  String get scanQr => text('Quét QR', 'Scan QR');
  String get charging => text('Phiên sạc', 'Charging');
  String get profile => text('Tài khoản', 'Account');
  String get vehicle => text('Xe đang dùng', 'Current vehicle');
  String get languageTitle => text('Ngôn ngữ', 'Language');
  String get missing => text('Không tìm thấy trạm', 'Station not found');
  String get back => text('Quay lại', 'Back');
}
