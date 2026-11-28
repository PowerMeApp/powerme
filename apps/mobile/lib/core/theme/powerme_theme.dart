import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

/// Bộ màu nhận diện PowerMe. Dashboard dùng cùng giá trị trong
/// `apps/dashboard/src/styles/tokens.css`; đổi ở đây thì đổi cả bên đó.
abstract final class PowerMeColors {
  static const gold = Color(0xFFD4AF37);
  static const teal = Color(0xFF00E0C2);
  static const black = Color(0xFF0A0A0A);
  static const graphite = Color(0xFF141414);
  static const text = Color(0xFFF5F3EC);
  static const muted = Color(0xFFB9BCBA);

  /// Viền xám đặc cũ. Một số màn còn dùng trực tiếp với alpha; lớp theme
  /// chuyển sang [hairline].
  static const outline = Color(0xFF444845);

  /// Viền mảnh trắng ~10 % alpha cho thẻ, input, hộp thoại.
  static const hairline = Color(0x1AFFFFFF);

  /// Viền mảnh nhẹ hơn (~6 %) cho divider và đường phân cách trong thẻ.
  static const hairlineSoft = Color(0x0FFFFFFF);

  /// Phân tầng bề mặt (M3 surfaceContainer*), trung tính quanh Graphite.
  static const surfaceLowest = Color(0xFF0A0A0A);
  static const surfaceLow = Color(0xFF101010);
  static const surfaceHigh = Color(0xFF1B1B1B);
  static const surfaceHighest = Color(0xFF232323);
  static const surfaceBright = Color(0xFF2C2C2C);

  static const danger = Color(0xFFFF6B6B);
}

/// Bo góc dùng chung, khớp dashboard (thẻ 20, input 14, pill 30).
abstract final class PowerMeRadii {
  static const card = 20.0;
  static const tile = 14.0;
  static const input = 14.0;
  static const pill = 30.0;
  static const sheet = 28.0;
}

const _tabular = [FontFeature.tabularFigures()];

TextTheme _powerMeTextTheme() => const TextTheme(
  displayLarge: TextStyle(
    fontSize: 44,
    height: 1.08,
    letterSpacing: -1.2,
    fontWeight: FontWeight.w800,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  displayMedium: TextStyle(
    fontSize: 38,
    height: 1.1,
    letterSpacing: -1,
    fontWeight: FontWeight.w800,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  displaySmall: TextStyle(
    fontSize: 32,
    height: 1.12,
    letterSpacing: -.8,
    fontWeight: FontWeight.w800,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  headlineLarge: TextStyle(
    fontSize: 28,
    height: 1.15,
    letterSpacing: -.6,
    fontWeight: FontWeight.w800,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  headlineMedium: TextStyle(
    fontSize: 26,
    height: 1.18,
    letterSpacing: -.5,
    fontWeight: FontWeight.w800,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  headlineSmall: TextStyle(
    fontSize: 22,
    height: 1.24,
    letterSpacing: -.35,
    fontWeight: FontWeight.w700,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  titleLarge: TextStyle(
    fontSize: 19,
    height: 1.3,
    letterSpacing: -.25,
    fontWeight: FontWeight.w700,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  titleMedium: TextStyle(
    fontSize: 16,
    height: 1.38,
    letterSpacing: -.1,
    fontWeight: FontWeight.w600,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  titleSmall: TextStyle(
    fontSize: 14,
    height: 1.4,
    letterSpacing: 0,
    fontWeight: FontWeight.w600,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  bodyLarge: TextStyle(
    fontSize: 16,
    height: 1.5,
    letterSpacing: 0,
    color: PowerMeColors.text,
  ),
  bodyMedium: TextStyle(
    fontSize: 14,
    height: 1.5,
    letterSpacing: .05,
    color: PowerMeColors.text,
  ),
  bodySmall: TextStyle(
    fontSize: 12.5,
    height: 1.45,
    letterSpacing: .1,
    color: PowerMeColors.muted,
  ),
  labelLarge: TextStyle(
    fontSize: 14,
    height: 1.35,
    letterSpacing: .15,
    fontWeight: FontWeight.w600,
    color: PowerMeColors.text,
    fontFeatures: _tabular,
  ),
  labelMedium: TextStyle(
    fontSize: 12.5,
    height: 1.3,
    letterSpacing: .2,
    fontWeight: FontWeight.w600,
    color: PowerMeColors.text,
  ),
  labelSmall: TextStyle(
    fontSize: 11.5,
    height: 1.3,
    letterSpacing: .3,
    fontWeight: FontWeight.w600,
    color: PowerMeColors.muted,
  ),
);

/// Lớp phủ tương tác chung: hover nhẹ, focus/pressed rõ hơn.
WidgetStateProperty<Color?> _overlay(Color color) =>
    WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.pressed)) {
        return color.withValues(alpha: .14);
      }
      if (states.contains(WidgetState.focused)) {
        return color.withValues(alpha: .14);
      }
      if (states.contains(WidgetState.hovered)) {
        return color.withValues(alpha: .07);
      }
      return null;
    });

const _pill = StadiumBorder();

ThemeData powerMeTheme() {
  const scheme = ColorScheme.dark(
    primary: PowerMeColors.teal,
    onPrimary: PowerMeColors.black,
    primaryContainer: Color(0xFF0B2D29),
    onPrimaryContainer: Color(0xFF7FF0DF),
    secondary: PowerMeColors.gold,
    onSecondary: PowerMeColors.black,
    secondaryContainer: Color(0xFF0E2A26),
    onSecondaryContainer: PowerMeColors.teal,
    tertiary: PowerMeColors.gold,
    onTertiary: PowerMeColors.black,
    error: PowerMeColors.danger,
    onError: PowerMeColors.black,
    errorContainer: Color(0xFF3A1416),
    onErrorContainer: Color(0xFFFFB4B0),
    surface: PowerMeColors.graphite,
    onSurface: PowerMeColors.text,
    onSurfaceVariant: PowerMeColors.muted,
    surfaceDim: PowerMeColors.black,
    surfaceBright: PowerMeColors.surfaceBright,
    surfaceContainerLowest: PowerMeColors.surfaceLowest,
    surfaceContainerLow: PowerMeColors.surfaceLow,
    surfaceContainer: PowerMeColors.graphite,
    surfaceContainerHigh: PowerMeColors.surfaceHigh,
    surfaceContainerHighest: PowerMeColors.surfaceHighest,
    outline: PowerMeColors.outline,
    outlineVariant: Color(0xFF262826),
    shadow: Colors.black,
    scrim: Colors.black,
    inverseSurface: PowerMeColors.text,
    onInverseSurface: PowerMeColors.black,
    inversePrimary: Color(0xFF00806F),
    surfaceTint: Colors.transparent,
  );
  // Gộp với Typography mặc định để mọi style dẫn xuất (nút, input…) giữ
  // fontFamily của nền tảng thay vì rơi về font fallback.
  final text = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    textTheme: _powerMeTextTheme(),
  ).textTheme;
  const hairline = BorderSide(color: PowerMeColors.hairline);
  final pillButtonText = text.labelLarge!.copyWith(
    fontSize: 15,
    letterSpacing: .1,
    fontWeight: FontWeight.w700,
  );
  const transitions = PageTransitionsTheme(
    builders: {
      TargetPlatform.android: FadeForwardsPageTransitionsBuilder(
        backgroundColor: PowerMeColors.black,
      ),
      TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
      TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
      TargetPlatform.windows: FadeForwardsPageTransitionsBuilder(
        backgroundColor: PowerMeColors.black,
      ),
      TargetPlatform.linux: FadeForwardsPageTransitionsBuilder(
        backgroundColor: PowerMeColors.black,
      ),
      TargetPlatform.fuchsia: FadeForwardsPageTransitionsBuilder(
        backgroundColor: PowerMeColors.black,
      ),
    },
  );
  OutlineInputBorder inputBorder(BorderSide side) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(PowerMeRadii.input),
    borderSide: side,
  );

  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    textTheme: text,
    scaffoldBackgroundColor: PowerMeColors.black,
    canvasColor: PowerMeColors.black,
    dividerColor: PowerMeColors.hairlineSoft,
    splashFactory: InkRipple.splashFactory,
    highlightColor: Colors.transparent,
    hoverColor: Colors.white.withValues(alpha: .04),
    focusColor: PowerMeColors.teal.withValues(alpha: .14),
    pageTransitionsTheme: transitions,
    iconTheme: const IconThemeData(color: PowerMeColors.text, size: 22),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: PowerMeColors.graphite,
      surfaceTintColor: Colors.transparent,
      shadowColor: Colors.transparent,
      elevation: 0,
      height: 68,
      indicatorColor: Colors.transparent,
      overlayColor: _overlay(PowerMeColors.teal),
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          size: 22,
          color: states.contains(WidgetState.selected)
              ? PowerMeColors.teal
              : PowerMeColors.muted,
        ),
      ),
      labelTextStyle: WidgetStateProperty.resolveWith(
        (states) => text.labelMedium?.copyWith(
          fontWeight: states.contains(WidgetState.selected)
              ? FontWeight.w700
              : FontWeight.w500,
          color: states.contains(WidgetState.selected)
              ? PowerMeColors.teal
              : PowerMeColors.muted,
        ),
      ),
    ),
    dividerTheme: const DividerThemeData(
      color: PowerMeColors.hairlineSoft,
      thickness: 1,
      space: 1,
    ),
    chipTheme: ChipThemeData(
      side: WidgetStateBorderSide.resolveWith(
        (states) => BorderSide(
          color: states.contains(WidgetState.selected)
              ? PowerMeColors.teal.withValues(alpha: .55)
              : PowerMeColors.hairline,
        ),
      ),
      shape: _pill,
      backgroundColor: PowerMeColors.graphite,
      selectedColor: PowerMeColors.teal.withValues(alpha: .14),
      disabledColor: PowerMeColors.graphite,
      checkmarkColor: PowerMeColors.teal,
      iconTheme: const IconThemeData(color: PowerMeColors.muted, size: 18),
      labelStyle: text.labelLarge?.copyWith(color: PowerMeColors.text),
      secondaryLabelStyle: text.labelLarge?.copyWith(color: PowerMeColors.teal),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      showCheckmark: true,
      elevation: 0,
      pressElevation: 0,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: PowerMeColors.black,
      foregroundColor: PowerMeColors.text,
      surfaceTintColor: Colors.transparent,
      shadowColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleSpacing: 8,
      iconTheme: const IconThemeData(color: PowerMeColors.text, size: 22),
      actionsIconTheme: const IconThemeData(
        color: PowerMeColors.text,
        size: 22,
      ),
      titleTextStyle: text.titleLarge?.copyWith(
        fontSize: 20,
        height: 1.25,
        letterSpacing: -.3,
      ),
    ),
    cardTheme: CardThemeData(
      margin: EdgeInsets.zero,
      color: PowerMeColors.graphite,
      elevation: 0,
      shadowColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(PowerMeRadii.card),
        side: hairline,
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: PowerMeColors.surfaceHigh,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      barrierColor: Colors.black.withValues(alpha: .62),
      titleTextStyle: text.headlineSmall,
      contentTextStyle: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
      actionsPadding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(24),
        side: hairline,
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: PowerMeColors.surfaceHigh,
      modalBackgroundColor: PowerMeColors.surfaceHigh,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      modalElevation: 0,
      modalBarrierColor: Colors.black.withValues(alpha: .62),
      dragHandleColor: PowerMeColors.muted.withValues(alpha: .4),
      dragHandleSize: const Size(36, 4),
      clipBehavior: Clip.antiAlias,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(PowerMeRadii.sheet),
        ),
        side: hairline,
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: PowerMeColors.surfaceHighest,
      contentTextStyle: text.bodyMedium?.copyWith(
        color: PowerMeColors.text,
        fontWeight: FontWeight.w600,
      ),
      actionTextColor: PowerMeColors.teal,
      closeIconColor: PowerMeColors.muted,
      elevation: 0,
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(PowerMeRadii.tile),
        side: BorderSide(color: PowerMeColors.teal.withValues(alpha: .45)),
      ),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: PowerMeColors.teal,
      linearTrackColor: Colors.white.withValues(alpha: .08),
      circularTrackColor: Colors.transparent,
      linearMinHeight: 6,
      borderRadius: BorderRadius.circular(6),
      strokeCap: StrokeCap.round,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 52),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 15),
        textStyle: pillButtonText,
        elevation: 0,
        shape: _pill,
      ).copyWith(overlayColor: _overlay(PowerMeColors.black)),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        minimumSize: const Size(48, 52),
        backgroundColor: PowerMeColors.surfaceHigh,
        foregroundColor: PowerMeColors.text,
        textStyle: pillButtonText,
        elevation: 0,
        shape: _pill,
        side: hairline,
      ).copyWith(overlayColor: _overlay(Colors.white)),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style:
          OutlinedButton.styleFrom(
            minimumSize: const Size(48, 48),
            foregroundColor: PowerMeColors.text,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
            textStyle: text.labelLarge,
            shape: _pill,
          ).copyWith(
            overlayColor: _overlay(Colors.white),
            side: WidgetStateProperty.resolveWith((states) {
              if (states.contains(WidgetState.disabled)) {
                return const BorderSide(color: PowerMeColors.hairlineSoft);
              }
              if (states.contains(WidgetState.focused)) {
                return const BorderSide(color: PowerMeColors.teal, width: 1.5);
              }
              if (states.contains(WidgetState.pressed) ||
                  states.contains(WidgetState.hovered)) {
                return BorderSide(color: Colors.white.withValues(alpha: .22));
              }
              return BorderSide(color: Colors.white.withValues(alpha: .14));
            }),
          ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        minimumSize: const Size(48, 48),
        foregroundColor: PowerMeColors.teal,
        textStyle: text.labelLarge,
        shape: _pill,
      ).copyWith(overlayColor: _overlay(PowerMeColors.teal)),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(
        minimumSize: const Size(48, 48),
      ).copyWith(overlayColor: _overlay(Colors.white)),
    ),
    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      backgroundColor: PowerMeColors.teal,
      foregroundColor: PowerMeColors.black,
      elevation: 0,
      focusElevation: 0,
      hoverElevation: 0,
      highlightElevation: 0,
      shape: _pill,
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: SegmentedButton.styleFrom(
        selectedBackgroundColor: PowerMeColors.teal.withValues(alpha: .14),
        selectedForegroundColor: PowerMeColors.teal,
        foregroundColor: PowerMeColors.text,
        side: hairline,
        shape: _pill,
        textStyle: text.labelLarge,
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: PowerMeColors.graphite,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      labelStyle: text.bodyLarge?.copyWith(color: PowerMeColors.muted),
      floatingLabelStyle: WidgetStateTextStyle.resolveWith(
        (states) => TextStyle(
          fontWeight: FontWeight.w600,
          color: states.contains(WidgetState.error)
              ? PowerMeColors.danger
              : PowerMeColors.gold,
        ),
      ),
      hintStyle: text.bodyLarge?.copyWith(
        color: PowerMeColors.muted.withValues(alpha: .8),
      ),
      prefixIconColor: PowerMeColors.gold,
      suffixIconColor: PowerMeColors.muted,
      helperStyle: text.bodySmall,
      errorStyle: text.bodySmall?.copyWith(color: PowerMeColors.danger),
      border: inputBorder(hairline),
      enabledBorder: inputBorder(
        BorderSide(color: Colors.white.withValues(alpha: .12)),
      ),
      disabledBorder: inputBorder(
        const BorderSide(color: PowerMeColors.hairlineSoft),
      ),
      focusedBorder: inputBorder(
        const BorderSide(color: PowerMeColors.teal, width: 1.5),
      ),
      errorBorder: inputBorder(
        BorderSide(color: PowerMeColors.danger.withValues(alpha: .7)),
      ),
      focusedErrorBorder: inputBorder(
        const BorderSide(color: PowerMeColors.danger, width: 1.5),
      ),
    ),
    listTileTheme: ListTileThemeData(
      iconColor: PowerMeColors.muted,
      textColor: PowerMeColors.text,
      titleTextStyle: text.titleMedium,
      subtitleTextStyle: text.bodySmall,
      leadingAndTrailingTextStyle: text.labelLarge,
      selectedColor: PowerMeColors.teal,
      selectedTileColor: PowerMeColors.teal.withValues(alpha: .08),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(PowerMeRadii.tile),
      ),
    ),
    expansionTileTheme: const ExpansionTileThemeData(
      iconColor: PowerMeColors.teal,
      collapsedIconColor: PowerMeColors.muted,
      textColor: PowerMeColors.text,
      collapsedTextColor: PowerMeColors.text,
      shape: Border(),
      collapsedShape: Border(),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? PowerMeColors.black
            : PowerMeColors.muted,
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? PowerMeColors.teal
            : PowerMeColors.surfaceHighest,
      ),
      trackOutlineColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? Colors.transparent
            : PowerMeColors.hairline,
      ),
      overlayColor: _overlay(PowerMeColors.teal),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? PowerMeColors.teal
            : Colors.transparent,
      ),
      checkColor: const WidgetStatePropertyAll(PowerMeColors.black),
      side: WidgetStateBorderSide.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? BorderSide.none
            : BorderSide(
                color: Colors.white.withValues(alpha: .32),
                width: 1.5,
              ),
      ),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(5)),
      overlayColor: _overlay(PowerMeColors.teal),
    ),
    radioTheme: RadioThemeData(
      fillColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? PowerMeColors.teal
            : PowerMeColors.muted,
      ),
      overlayColor: _overlay(PowerMeColors.teal),
    ),
    tabBarTheme: TabBarThemeData(
      labelColor: PowerMeColors.teal,
      unselectedLabelColor: PowerMeColors.muted,
      indicatorColor: PowerMeColors.teal,
      indicatorSize: TabBarIndicatorSize.label,
      dividerColor: PowerMeColors.hairlineSoft,
      labelStyle: text.labelLarge?.copyWith(fontWeight: FontWeight.w700),
      unselectedLabelStyle: text.labelLarge,
      overlayColor: _overlay(PowerMeColors.teal),
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(
        color: PowerMeColors.surfaceHighest,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: PowerMeColors.hairline),
      ),
      textStyle: text.labelMedium,
      waitDuration: const Duration(milliseconds: 400),
    ),
    badgeTheme: const BadgeThemeData(
      backgroundColor: PowerMeColors.teal,
      textColor: PowerMeColors.black,
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: PowerMeColors.surfaceHigh,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      textStyle: text.bodyMedium,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(PowerMeRadii.tile),
        side: hairline,
      ),
    ),
    menuTheme: MenuThemeData(
      style: MenuStyle(
        backgroundColor: const WidgetStatePropertyAll(
          PowerMeColors.surfaceHigh,
        ),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        elevation: const WidgetStatePropertyAll(0),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(PowerMeRadii.tile),
            side: hairline,
          ),
        ),
      ),
    ),
    dropdownMenuTheme: DropdownMenuThemeData(
      textStyle: text.bodyLarge,
      menuStyle: MenuStyle(
        backgroundColor: const WidgetStatePropertyAll(
          PowerMeColors.surfaceHigh,
        ),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(PowerMeRadii.tile),
            side: hairline,
          ),
        ),
      ),
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: PowerMeColors.teal,
      selectionColor: PowerMeColors.teal.withValues(alpha: .3),
      selectionHandleColor: PowerMeColors.teal,
    ),
    scrollbarTheme: ScrollbarThemeData(
      thumbColor: WidgetStatePropertyAll(Colors.white.withValues(alpha: .18)),
      radius: const Radius.circular(8),
      thickness: const WidgetStatePropertyAll(4),
    ),
  );
}
