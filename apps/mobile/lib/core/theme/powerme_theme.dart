import 'package:flutter/material.dart';

abstract final class PowerMeColors {
  static const gold = Color(0xFFD4AF37);
  static const teal = Color(0xFF00E0C2);
  static const black = Color(0xFF0A0A0A);
  static const graphite = Color(0xFF141414);
  static const text = Color(0xFFF5F3EC);
  static const muted = Color(0xFFB9BCBA);
  static const outline = Color(0xFF444845);
}

ThemeData powerMeTheme() {
  const scheme = ColorScheme.dark(
    primary: PowerMeColors.teal,
    onPrimary: PowerMeColors.black,
    secondary: PowerMeColors.gold,
    onSecondary: PowerMeColors.black,
    surface: PowerMeColors.graphite,
    onSurface: PowerMeColors.text,
    onSurfaceVariant: PowerMeColors.muted,
    outline: PowerMeColors.outline,
  );
  final base = ThemeData(useMaterial3: true, colorScheme: scheme);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: PowerMeColors.black,
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: PowerMeColors.graphite,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      height: 68,
      indicatorColor: PowerMeColors.teal,
      indicatorShape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          size: 22,
          color: states.contains(WidgetState.selected)
              ? PowerMeColors.black
              : PowerMeColors.muted,
        ),
      ),
      labelTextStyle: WidgetStateProperty.resolveWith(
        (states) => base.textTheme.labelMedium?.copyWith(
          fontWeight: states.contains(WidgetState.selected)
              ? FontWeight.w700
              : FontWeight.w500,
          letterSpacing: .2,
          color: states.contains(WidgetState.selected)
              ? PowerMeColors.teal
              : PowerMeColors.muted,
        ),
      ),
    ),
    dividerTheme: DividerThemeData(
      color: PowerMeColors.outline.withValues(alpha: .32),
      thickness: 1,
      space: 1,
    ),
    chipTheme: ChipThemeData(
      side: BorderSide(color: PowerMeColors.outline.withValues(alpha: .6)),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      backgroundColor: PowerMeColors.graphite,
      selectedColor: PowerMeColors.teal.withValues(alpha: .16),
      checkmarkColor: PowerMeColors.teal,
      labelStyle: const TextStyle(
        color: PowerMeColors.text,
        fontWeight: FontWeight.w600,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: PowerMeColors.black,
      foregroundColor: PowerMeColors.text,
      surfaceTintColor: Colors.transparent,
      centerTitle: false,
      titleSpacing: 8,
      titleTextStyle: TextStyle(
        color: PowerMeColors.text,
        fontSize: 20,
        height: 1.25,
        letterSpacing: -.2,
        fontWeight: FontWeight.w700,
      ),
    ),
    cardTheme: CardThemeData(
      margin: EdgeInsets.zero,
      color: PowerMeColors.graphite,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: PowerMeColors.outline.withValues(alpha: .5)),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: PowerMeColors.graphite,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: PowerMeColors.outline.withValues(alpha: .6)),
      ),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: PowerMeColors.graphite,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: PowerMeColors.graphite,
      contentTextStyle: const TextStyle(
        color: PowerMeColors.text,
        fontWeight: FontWeight.w600,
      ),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: PowerMeColors.teal),
      ),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: PowerMeColors.teal,
      linearTrackColor: PowerMeColors.outline.withValues(alpha: .35),
      borderRadius: BorderRadius.circular(6),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 52),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 15),
        textStyle: base.textTheme.labelLarge?.copyWith(
          fontSize: 15,
          letterSpacing: .2,
          fontWeight: FontWeight.w700,
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(48, 48),
        foregroundColor: PowerMeColors.text,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
        textStyle: base.textTheme.labelLarge?.copyWith(
          fontSize: 14,
          letterSpacing: .15,
          fontWeight: FontWeight.w600,
        ),
        side: BorderSide(color: PowerMeColors.outline.withValues(alpha: .7)),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        minimumSize: const Size(48, 48),
        foregroundColor: PowerMeColors.teal,
        textStyle: base.textTheme.labelLarge?.copyWith(
          fontSize: 14,
          fontWeight: FontWeight.w600,
        ),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(minimumSize: const Size(48, 48)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: PowerMeColors.graphite,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      labelStyle: const TextStyle(color: PowerMeColors.muted),
      floatingLabelStyle: const TextStyle(
        color: PowerMeColors.gold,
        fontWeight: FontWeight.w600,
      ),
      prefixIconColor: PowerMeColors.gold,
      suffixIconColor: PowerMeColors.muted,
      helperStyle: const TextStyle(color: PowerMeColors.muted, fontSize: 12),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(
          color: PowerMeColors.outline.withValues(alpha: .6),
        ),
      ),
      disabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(
          color: PowerMeColors.outline.withValues(alpha: .3),
        ),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: PowerMeColors.teal, width: 1.5),
      ),
    ),
    textTheme: const TextTheme(
      headlineLarge: TextStyle(
        fontSize: 28,
        height: 1.15,
        letterSpacing: -.5,
        fontWeight: FontWeight.w800,
        color: PowerMeColors.text,
      ),
      headlineMedium: TextStyle(
        fontSize: 26,
        height: 1.2,
        letterSpacing: -.4,
        fontWeight: FontWeight.w800,
        color: PowerMeColors.text,
      ),
      headlineSmall: TextStyle(
        fontSize: 22,
        height: 1.25,
        letterSpacing: -.3,
        fontWeight: FontWeight.w700,
        color: PowerMeColors.text,
      ),
      titleLarge: TextStyle(
        fontSize: 19,
        height: 1.3,
        letterSpacing: -.2,
        fontWeight: FontWeight.w700,
        color: PowerMeColors.text,
      ),
      titleMedium: TextStyle(
        fontSize: 16,
        height: 1.38,
        letterSpacing: -.1,
        fontWeight: FontWeight.w600,
        color: PowerMeColors.text,
      ),
      bodyLarge: TextStyle(
        fontSize: 16,
        height: 1.5,
        color: PowerMeColors.text,
      ),
      bodyMedium: TextStyle(
        fontSize: 14,
        height: 1.5,
        color: PowerMeColors.text,
      ),
      bodySmall: TextStyle(
        fontSize: 12.5,
        height: 1.45,
        color: PowerMeColors.muted,
      ),
      labelLarge: TextStyle(
        fontSize: 14,
        height: 1.35,
        letterSpacing: .15,
        fontWeight: FontWeight.w600,
        color: PowerMeColors.text,
      ),
      labelMedium: TextStyle(
        fontSize: 12.5,
        height: 1.3,
        letterSpacing: .2,
        fontWeight: FontWeight.w600,
        color: PowerMeColors.text,
      ),
    ),
  );
}
