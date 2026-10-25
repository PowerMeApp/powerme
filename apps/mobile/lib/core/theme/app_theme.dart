import 'package:flutter/material.dart';

abstract final class BrandColors {
  static const gold = Color(0xFFD4AF37);
  static const teal = Color(0xFF00E0C2);
  static const richBlack = Color(0xFF0A0A0A);
  static const graphite = Color(0xFF141414);
  static const danger = Color(0xFFFF6B6B);
  static const warning = Color(0xFFFFC857);
  static const muted = Color(0xFF9EA4B3);
}

abstract final class AppTheme {
  static ThemeData get dark {
    final scheme =
        ColorScheme.fromSeed(
          seedColor: BrandColors.teal,
          brightness: Brightness.dark,
          surface: BrandColors.graphite,
        ).copyWith(
          primary: BrandColors.teal,
          onPrimary: BrandColors.richBlack,
          secondary: BrandColors.gold,
          onSecondary: BrandColors.richBlack,
          surface: BrandColors.graphite,
          onSurface: Colors.white,
          error: BrandColors.danger,
        );
    return ThemeData(
      brightness: Brightness.dark,
      colorScheme: scheme,
      scaffoldBackgroundColor: BrandColors.richBlack,
      useMaterial3: true,
      appBarTheme: const AppBarTheme(
        backgroundColor: BrandColors.richBlack,
        foregroundColor: Colors.white,
        elevation: 0,
      ),
      cardTheme: CardThemeData(
        color: BrandColors.graphite,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: BrandColors.graphite,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: Color(0xFF2B2F3A), width: 1),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: BrandColors.teal, width: 1.5),
        ),
      ),
      navigationBarTheme: const NavigationBarThemeData(
        backgroundColor: BrandColors.graphite,
        indicatorColor: Color(0x3327E5C1),
        labelTextStyle: WidgetStatePropertyAll(TextStyle(fontSize: 12)),
      ),
    );
  }
}
