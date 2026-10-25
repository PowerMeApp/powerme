import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:powerme/app/powerme_app.dart';

void main() {
  testWidgets('auth screen opens the simulated app', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: PowerMeApp()));

    expect(find.text('Đăng nhập'), findsOneWidget);
    await tester.tap(find.text('Vào bản demo mô phỏng'));
    await tester.pumpAndSettle();

    expect(find.text('Chào bạn, Minh'), findsOneWidget);
    expect(find.text('PowerMe Nguyễn Huệ'), findsOneWidget);
  });
}
