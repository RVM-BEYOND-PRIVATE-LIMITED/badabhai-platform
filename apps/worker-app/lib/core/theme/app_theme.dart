import 'package:flutter/material.dart';

import 'app_colors.dart';
import 'app_spacing.dart';
import 'app_typography.dart';

/// The BadaBhai **"Josh"** theme, assembled from the design tokens
/// ([AppColors], [AppTypography], [AppSpacing], [AppRadii]).
///
/// Material 3, skinned to the tokens — we do **not** ship default Material
/// colours. Build the whole app from [AppTheme.light]; never hard-code a colour,
/// radius, or text style in a widget.
///
/// Colour intent (LOCKED 2026-07-27): **haldi is the hero / primary CTA** (one
/// per screen; text on haldi is ALWAYS deep blue) and **blue is structure /
/// trust / links**. Green means success / money / WhatsApp only. Surfaces are
/// separated by **hairline borders, never shadows** — every elevation is 0.
class AppTheme {
  AppTheme._();

  static ThemeData light() {
    const ColorScheme scheme = ColorScheme(
      brightness: Brightness.light,
      // primary = the haldi hero CTA (blue text on haldi)
      primary: AppColors.brand,
      onPrimary: AppColors.textOnBrand,
      primaryContainer: AppColors.brandTint,
      onPrimaryContainer: AppColors.bluePressed,
      // secondary = deep blue (structure, trust, links)
      secondary: AppColors.blue,
      onSecondary: AppColors.onBlue,
      secondaryContainer: AppColors.blueTintChat,
      onSecondaryContainer: AppColors.bluePressed,
      // tertiary = green (success / money accent)
      tertiary: AppColors.success,
      onTertiary: AppColors.onBlue,
      tertiaryContainer: AppColors.successTint,
      onTertiaryContainer: AppColors.green700,
      error: AppColors.danger,
      onError: AppColors.onBlue,
      errorContainer: AppColors.dangerTint,
      onErrorContainer: AppColors.red700,
      surface: AppColors.surfaceCard,
      onSurface: AppColors.textPrimary,
      onSurfaceVariant: AppColors.textSecondary,
      surfaceContainerLowest: AppColors.paper0,
      surfaceContainerLow: AppColors.paper1,
      surfaceContainer: AppColors.paper2,
      surfaceContainerHigh: AppColors.paper3,
      surfaceContainerHighest: AppColors.paper3,
      outline: AppColors.borderStrong,
      outlineVariant: AppColors.borderSubtle,
      shadow: AppColors.ink950,
      scrim: AppColors.scrim,
      inverseSurface: AppColors.ink900,
      onInverseSurface: AppColors.paper1,
      inversePrimary: AppColors.brandTint2,
    );

    final TextTheme textTheme = AppTypography.textTheme();

    const RoundedRectangleBorder controlShape = RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(AppRadii.sm)),
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: AppColors.surfacePage,
      textTheme: textTheme,
      primaryColor: AppColors.brand,
      splashColor: AppColors.brandTint,
      highlightColor: AppColors.brandTint,
      dividerColor: AppColors.divider,

      iconTheme: const IconThemeData(color: AppColors.ink700, size: 24),

      appBarTheme: AppBarTheme(
        backgroundColor: AppColors.surfacePage,
        foregroundColor: AppColors.textPrimary,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        shadowColor: Colors.transparent,
        centerTitle: true,
        titleTextStyle: textTheme.titleLarge,
        iconTheme: const IconThemeData(color: AppColors.ink700),
      ),

      // Primary worker CTA — HALDI action button, deep-blue label. Flat.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppColors.brand,
          foregroundColor: AppColors.textOnBrand,
          disabledBackgroundColor: AppColors.disabled,
          disabledForegroundColor: AppColors.textMuted,
          minimumSize: const Size(64, AppSpacing.controlLg),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
          textStyle: textTheme.labelLarge,
          shape: controlShape,
          elevation: 0,
        ),
      ),

      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.brand,
          foregroundColor: AppColors.textOnBrand,
          minimumSize: const Size(64, AppSpacing.controlLg),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
          textStyle: textTheme.labelLarge,
          shape: controlShape,
          elevation: 0,
        ),
      ),

      // Secondary — outlined, ink on white.
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          backgroundColor: AppColors.surfaceCard,
          foregroundColor: AppColors.textPrimary,
          minimumSize: const Size(64, AppSpacing.controlLg),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
          textStyle: textTheme.labelLarge,
          side: const BorderSide(color: AppColors.borderStrong, width: 1.5),
          shape: controlShape,
        ),
      ),

      // Ghost — text only.
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: AppColors.textBrand,
          textStyle: textTheme.labelLarge,
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.s4,
            vertical: AppSpacing.s2,
          ),
          shape: controlShape,
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surfaceCard,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s4,
          vertical: AppSpacing.s4,
        ),
        hintStyle: AppTypography.body(color: AppColors.textFaint),
        labelStyle: AppTypography.body(
          color: AppColors.textPrimary,
          weight: FontWeight.w600,
        ),
        enabledBorder: _inputBorder(AppColors.borderStrong, 1.5),
        border: _inputBorder(AppColors.borderStrong, 1.5),
        focusedBorder: _inputBorder(AppColors.blue, 2),
        errorBorder: _inputBorder(AppColors.danger, 1.5),
        focusedErrorBorder: _inputBorder(AppColors.danger, 2),
        errorStyle: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.danger,
          weight: FontWeight.w500,
        ),
      ),

      // Cards separate by a 1px hairline, never a shadow. Flat (elevation 0).
      cardTheme: const CardThemeData(
        color: AppColors.surfaceCard,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(AppRadii.sm)),
          side: BorderSide(color: AppColors.borderSubtle),
        ),
      ),

      listTileTheme: ListTileThemeData(
        iconColor: AppColors.ink600,
        titleTextStyle: textTheme.titleSmall,
        subtitleTextStyle: AppTypography.body(color: AppColors.textSecondary),
      ),

      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith<Color>((states) {
          if (states.contains(WidgetState.selected)) return AppColors.blue;
          return AppColors.surfaceCard;
        }),
        checkColor: const WidgetStatePropertyAll<Color>(AppColors.onBlue),
        side: const BorderSide(color: AppColors.borderStrong, width: 2),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.xs),
        ),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.ink900,
        contentTextStyle: AppTypography.body(color: AppColors.paper1),
        actionTextColor: AppColors.haldi,
        behavior: SnackBarBehavior.floating,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(AppRadii.md)),
        ),
      ),

      dividerTheme: const DividerThemeData(
        color: AppColors.divider,
        thickness: 1,
        space: 1,
      ),

      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: AppColors.blue,
      ),

      chipTheme: ChipThemeData(
        backgroundColor: AppColors.surfaceSunken,
        side: const BorderSide(color: AppColors.borderSubtle),
        labelStyle: AppTypography.body(
          size: AppTypography.sizeSm,
          weight: FontWeight.w600,
        ),
        shape: const StadiumBorder(),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s3,
          vertical: AppSpacing.s2,
        ),
      ),
    );
  }

  static OutlineInputBorder _inputBorder(Color color, double width) {
    return OutlineInputBorder(
      borderRadius: BorderRadius.circular(AppRadii.md),
      borderSide: BorderSide(color: color, width: width),
    );
  }
}

/// Shared button [ButtonStyle]s for the variants the design system defines but
/// Material doesn't theme by default. The default [FilledButton] is already the
/// haldi primary; use these for status-specific actions. All flat (elevation 0).
class AppButtonStyles {
  AppButtonStyles._();

  /// **Haldi brand** CTA — the hero action, deep-blue label. Used as the one
  /// primary per screen. Flat: hairlines + fill carry hierarchy, never shadow.
  static ButtonStyle brand = FilledButton.styleFrom(
    backgroundColor: AppColors.brand,
    foregroundColor: AppColors.textOnBrand,
    minimumSize: const Size(64, AppSpacing.controlLg),
    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
    textStyle: AppTypography.body(size: AppTypography.sizeMd, weight: FontWeight.w700),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(AppRadii.sm)),
    ),
    elevation: 0,
  );

  /// Crimson danger action (delete account, destructive) — white label.
  static ButtonStyle danger = FilledButton.styleFrom(
    backgroundColor: AppColors.danger,
    foregroundColor: AppColors.onBlue,
    minimumSize: const Size(64, AppSpacing.controlLg),
    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(AppRadii.sm)),
    ),
    elevation: 0,
  );
}
