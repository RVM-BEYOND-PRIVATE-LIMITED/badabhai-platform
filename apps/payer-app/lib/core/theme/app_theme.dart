import 'package:flutter/material.dart';

import 'app_colors.dart';
import 'app_spacing.dart';
import 'app_typography.dart';

/// The BadaBhai **JUL31 "JOSH"** theme, assembled from the design tokens
/// ([AppColors], [AppTypography], [AppSpacing], [AppRadii]).
///
/// Material 3, skinned to the tokens — we do **not** ship default Material
/// colours. Build the whole app from [AppTheme.light]; never hard-code a colour,
/// radius, or text style in a widget.
///
/// Colour intent: **haldi is the primary CTA** (ONE per screen) and **blue is
/// structure / trust / headers / links**; green is reserved for success·money.
/// So the Material `primary` slot is haldi (text on it is ALWAYS deep blue) and
/// `secondary` is blue. **Elevation is always 0** — surfaces are separated by
/// 1px hairline borders, never shadows or gradients.
class AppTheme {
  AppTheme._();

  static ThemeData light() {
    const ColorScheme scheme = ColorScheme(
      brightness: Brightness.light,
      // primary = haldi (the hero CTA); text on haldi is deep blue
      primary: AppColors.brand,
      onPrimary: AppColors.textOnBrand,
      primaryContainer: AppColors.brandTint,
      onPrimaryContainer: AppColors.blue,
      // secondary = deep-blue structure / trust
      secondary: AppColors.blue,
      onSecondary: AppColors.onBlue,
      secondaryContainer: AppColors.blueTintChat,
      onSecondaryContainer: AppColors.bluePressed,
      // tertiary = green (success / money)
      tertiary: AppColors.success,
      onTertiary: AppColors.textInverse,
      tertiaryContainer: AppColors.successTint,
      onTertiaryContainer: AppColors.green700,
      error: AppColors.danger,
      onError: AppColors.textInverse,
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
      shadow: Colors.transparent,
      scrim: AppColors.scrim,
      inverseSurface: AppColors.blue,
      onInverseSurface: AppColors.onBlue,
      inversePrimary: AppColors.haldi,
    );

    final TextTheme textTheme = AppTypography.textTheme();

    const RoundedRectangleBorder controlShape = RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(AppRadii.md)),
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

      // Flat header — canvas surface, ink foreground, no shadow.
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

      // Primary CTA — HALDI button, deep-blue label, flat.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppColors.brand,
          foregroundColor: AppColors.textOnBrand,
          disabledBackgroundColor: AppColors.disabled,
          disabledForegroundColor: AppColors.textSecondary,
          minimumSize: const Size(64, AppSpacing.controlLg),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
          textStyle: textTheme.labelLarge,
          shape: controlShape,
          elevation: 0,
          shadowColor: Colors.transparent,
        ),
      ),

      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.brand,
          foregroundColor: AppColors.textOnBrand,
          disabledBackgroundColor: AppColors.disabled,
          disabledForegroundColor: AppColors.textSecondary,
          minimumSize: const Size(64, AppSpacing.controlLg),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
          textStyle: textTheme.labelLarge,
          shape: controlShape,
          elevation: 0,
          shadowColor: Colors.transparent,
        ),
      ),

      // Secondary — outlined, ink on white, 1px hairline.
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          backgroundColor: AppColors.surfaceCard,
          foregroundColor: AppColors.textPrimary,
          minimumSize: const Size(64, AppSpacing.controlLg),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
          textStyle: textTheme.labelLarge,
          side: const BorderSide(color: AppColors.borderStrong, width: 1),
          shape: controlShape,
        ),
      ),

      // Ghost — text only, reads as a blue link.
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: AppColors.textLink,
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
        enabledBorder: _inputBorder(AppColors.borderStrong, 1),
        border: _inputBorder(AppColors.borderStrong, 1),
        focusedBorder: _inputBorder(AppColors.brand, 2),
        errorBorder: _inputBorder(AppColors.danger, 1),
        focusedErrorBorder: _inputBorder(AppColors.danger, 2),
        errorStyle: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.danger,
          weight: FontWeight.w500,
        ),
      ),

      // Cards — flat, separated by a 1px hairline (never a shadow).
      cardTheme: const CardThemeData(
        color: AppColors.surfaceCard,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(AppRadii.lg)),
          side: BorderSide(color: AppColors.border, width: 1),
        ),
      ),

      listTileTheme: ListTileThemeData(
        iconColor: AppColors.ink600,
        titleTextStyle: textTheme.titleSmall,
        subtitleTextStyle: AppTypography.body(color: AppColors.textSecondary),
      ),

      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith<Color>((states) {
          if (states.contains(WidgetState.selected)) return AppColors.success;
          return AppColors.surfaceCard;
        }),
        checkColor: const WidgetStatePropertyAll<Color>(AppColors.textInverse),
        side: const BorderSide(color: AppColors.borderStrong, width: 2),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.xs),
        ),
      ),

      // Dark surface = blue; action pops in haldi. Flat.
      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.surfaceInk,
        contentTextStyle: AppTypography.body(color: AppColors.onBlue),
        actionTextColor: AppColors.haldi,
        behavior: SnackBarBehavior.floating,
        elevation: 0,
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
        color: AppColors.brand,
      ),

      chipTheme: ChipThemeData(
        backgroundColor: AppColors.surfaceSunken,
        side: const BorderSide(color: AppColors.border),
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
/// Material doesn't theme by default — chiefly the **haldi brand** button and
/// the **red danger** action. Plain [FilledButton]s already pick up the haldi
/// theme; use these for brand emphasis or destructive actions. All flat.
class AppButtonStyles {
  AppButtonStyles._();

  /// Haldi **brand / primary** CTA — deep-blue label, flat. ONE per screen.
  static ButtonStyle brand = FilledButton.styleFrom(
    backgroundColor: AppColors.brand,
    foregroundColor: AppColors.textOnBrand,
    minimumSize: const Size(64, AppSpacing.controlLg),
    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
    textStyle: AppTypography.body(size: AppTypography.sizeMd, weight: FontWeight.w700),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(AppRadii.md)),
    ),
    elevation: 0,
    shadowColor: Colors.transparent,
  );

  /// Red danger action (delete account, destructive) — white label, flat.
  static ButtonStyle danger = FilledButton.styleFrom(
    backgroundColor: AppColors.danger,
    foregroundColor: AppColors.textInverse,
    minimumSize: const Size(64, AppSpacing.controlLg),
    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
    elevation: 0,
    shadowColor: Colors.transparent,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(AppRadii.md)),
    ),
  );
}
