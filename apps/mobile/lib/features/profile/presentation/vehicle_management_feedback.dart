import '../../../core/l10n/app_copy.dart';
import '../domain/profile_repository.dart';

String vehicleManagementMessage(
  AppCopy copy,
  ProfileFailure failure,
) => switch (failure) {
  ProfileFailure.invalidPlate => copy.text(
    'Biển số không hợp lệ. Kiểm tra lại chữ, số và dấu phân cách.',
    'Enter a valid plate number. Check the letters, digits and separators.',
  ),
  ProfileFailure.unknownModel => copy.text(
    'Mẫu xe này không còn trong danh mục. Hãy tải lại danh mục.',
    'This model is no longer in the catalog. Reload the catalog.',
  ),
  ProfileFailure.plateTaken => copy.text(
    'Biển số này đã được đăng ký.',
    'This plate number is already registered.',
  ),
  ProfileFailure.vehicleInUse => copy.text(
    'Chưa thể gỡ xe vì phiên hoặc yêu cầu sạc chưa hoàn tất.',
    'This vehicle has a charging session or request in progress.',
  ),
  ProfileFailure.vehicleMissing => copy.text(
    'Xe không còn trong hồ sơ. Tải lại hồ sơ để cập nhật.',
    'This vehicle is no longer in your profile. Reload to update it.',
  ),
  ProfileFailure.mutationUnconfirmed => copy.text(
    'Chưa xác nhận được thay đổi. Tải lại hồ sơ và kiểm tra danh sách xe trước khi thử lại.',
    'The change could not be confirmed. Reload your profile and check your vehicles before trying again.',
  ),
  ProfileFailure.mutationNeedsRefresh => copy.text(
    'Đã ghi nhận thay đổi. Tải lại hồ sơ để xem danh sách xe mới.',
    'The change was accepted. Reload your profile for the updated list.',
  ),
  _ => copy.text(
    'Chưa cập nhật được hồ sơ. Vui lòng thử lại.',
    'Could not update your profile. Please try again.',
  ),
};
