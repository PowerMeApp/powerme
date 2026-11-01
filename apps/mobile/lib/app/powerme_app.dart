import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/theme/powerme_theme.dart';
import 'router.dart';

class PowerMeApp extends ConsumerWidget {
  const PowerMeApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => MaterialApp.router(
    title: 'PowerMe',
    debugShowCheckedModeBanner: false,
    theme: powerMeTheme(),
    routerConfig: ref.watch(routerProvider),
  );
}
