import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'app/composition/demo_app.dart';
import 'app/composition/vietmap_config.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final config = await VietmapConfig.load(rootBundle);
  runApp(DemoApp(mapConfig: config));
}
