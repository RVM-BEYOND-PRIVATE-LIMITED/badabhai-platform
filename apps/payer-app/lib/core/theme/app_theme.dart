import 'package:flutter/material.dart';

import 'app_colors.dart';
import 'app_spacing.dart';
import 'app_typography.dart';

/// The BadaBhai **"Desi Vernacular Pop"** theme, assembled from the design
/// tokens ([AppColors], [AppTypography], [AppSpacing], [AppRadii]).
///
/// Material 3, skinned to the tokens — we do **not** ship default Material
/// colours. Build the whole app from [AppTheme.light]; never hard-code a colour,
/// radius, or text style in a widget.
///
/// Colour intent: **green is the action / "go" colour** (primary CTAs: Apply,
/// Continue, consent) and **vermilion is the brand** (logo, highlights). So the
/// Material `primary` slot is green and `secondary` is the vermilion brand —
/// reach the brand colour via [AppColors.brand] / [AppButtonStyles.brand].
class AppTheme {
  AppTheme._();

  static ThemeData light() {
    const ColorScheme scheme = ColorScheme(
      brightness: Brightness.light,
      // primary = the green action colour
      primary: AppColors.success,
      onPrimary: AppColors.textOnBrand,
      primaryContainer: AppColors.green100,
      onPrimaryContainer: AppColors.green700,
      // secondary = the vermilion brand
      secondary: AppColors.brand,
      onSecondary: AppColors.textOnBrand,
      secondaryContainer: AppColors.vermilion50,
      onSecondaryContainer: AppColors.vermilion700,
      // tertiary = saffron warmth
      tertiary: AppColors.saffron,
      onTertiary: AppColors.ink900,
      tertiaryContainer: AppColors.saffron50,
      onTertiaryContainer: AppColors.saffron700,
      error: AppColors.danger,
      onError: AppColors.textOnBrand,
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
      inversePrimary: AppColors.green300,
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

      appBarTheme: AppBarTheme(
        backgroundColor: AppColors.surfacePage,
        foregroundColor: AppColors.textPrimary,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 2,
        shadowColor: AppColors.borderSubtle,
        centerTitle: true,
        titleTextStyle: textTheme.titleLarge,
        iconTheme: const IconThemeData(color: AppColors.ink700),
      ),

      // Primary worker CTA — GREEN action button.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppColors.success,
          foregroundColor: AppColors.textOnBrand,
          disabledBackgroundColor: AppColors.green100,
          disabledForegroundColor: AppColors.paper1,
          minimumSize: const Size(64, AppSpacing.controlLg),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
          textStyle: textTheme.labelLarge,
          shape: controlShape,
          elevation: 2,
          shadowColor: AppColors.green500.withValues(alpha: 0.45),
        ).copyWith(
          // Tactile press: scale-like darken via overlay + green-tinted shadow.
          overlayColor: const WidgetStatePropertyAll<Color>(
            Color(0x1AFFFFFF),
          ),
        ),
      ),

      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.success,
          foregroundColor: AppColors.textOnBrand,
          minimumSize: const Size(64, AppSpacing.controlLg),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
          textStyle: textTheme.labelLarge,
          shape: controlShape,
          elevation: 2,
          shadowColor: AppColors.green500.withValues(alpha: 0.45),
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
        focusedBorder: _inputBorder(AppColors.brand, 2),
        errorBorder: _inputBorder(AppColors.danger, 1.5),
        focusedErrorBorder: _inputBorder(AppColors.danger, 2),
        errorStyle: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.danger,
          weight: FontWeight.w500,
        ),
      ),

      cardTheme: CardThemeData(
        color: AppColors.surfaceCard,
        surfaceTintColor: Colors.transparent,
        shadowColor: AppColors.ink900.withValues(alpha: 0.10),
        elevation: 2,
        margin: EdgeInsets.zero,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(AppRadii.lg)),
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
        checkColor: const WidgetStatePropertyAll<Color>(AppColors.textOnBrand),
        side: const BorderSide(color: AppColors.borderStrong, width: 2),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.xs),
        ),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.ink900,
        contentTextStyle: AppTypography.body(color: AppColors.paper1),
        actionTextColor: AppColors.green300,
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
        color: AppColors.brand,
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
/// Material doesn't theme by default — chiefly the **vermilion brand** button.
/// Plain green [FilledButton]s already pick up the theme; use these for brand
/// or status-specific actions.
class AppButtonStyles {
  AppButtonStyles._();

  /// Vermilion **brand** CTA — logo moments, brand highlights. Used sparingly;
  /// the everyday worker action is the green primary.
  static ButtonStyle brand = FilledButton.styleFrom(
    backgroundColor: AppColors.brand,
    foregroundColor: AppColors.textOnBrand,
    minimumSize: const Size(64, AppSpacing.controlLg),
    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
    textStyle: AppTypography.body(size: AppTypography.sizeMd, weight: FontWeight.w700),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(AppRadii.md)),
    ),
    elevation: 3,
    shadowColor: AppColors.brand.withValues(alpha: 0.40),
  );

  /// Crimson danger action (delete account, destructive).
  static ButtonStyle danger = FilledButton.styleFrom(
    backgroundColor: AppColors.danger,
    foregroundColor: AppColors.textOnBrand,
    minimumSize: const Size(64, AppSpacing.controlLg),
    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(AppRadii.md)),
    ),
  );
}
