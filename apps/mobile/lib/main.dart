import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app/composition/api_app.dart';
import 'core/api/api_config.dart';
import 'core/theme/powerme_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final config = await ApiConfig.load(
      rootBundle,
      allowTunnelHttp: kDebugMode,
    );
    runApp(ApiApp(config: config));
  } on FormatException {
    runApp(
      MaterialApp(
        theme: powerMeTheme(),
        home: const Scaffold(
          body: SafeArea(
            child: Center(
              child: Padding(
                padding: EdgeInsets.all(20),
                child: Text('Không thể kết nối với dịch vụ PowerMe.'),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
