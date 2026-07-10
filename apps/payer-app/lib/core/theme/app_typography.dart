import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'app_colors.dart';

/// BadaBhai typography — ported from `tokens/typography.css`.
///
///  - **Baloo 2** — display & brand voice. Warm, rounded, sturdy; carries
///    Devanagari. Headlines, the logo, big worker-facing moments. (google_fonts)
///  - **Mukta** — body & all UI. Calm, highly legible, multilingual. Carries
///    Hinglish/regional copy at low-literacy sizes. (google_fonts)
///  - **Roboto Mono** — data: wages, IDs, OTP, counts. Tabular numerals.
///    Self-hosted (see pubspec) so figures render identically offline.
///
/// Body never below 16px; worker-facing copy skews larger (18–20). Generous
/// line-height (1.5); headlines tight (1.1) with slight negative tracking.
class AppTypography {
  AppTypography._();

  /// Self-hosted data font family (declared in pubspec under `fonts:`).
  static const String monoFamily = 'Roboto Mono';

  // ---- type scale (px) ----
  static const double size2xs = 11;
  static const double sizeXs = 12;
  static const double sizeSm = 14;
  static const double sizeBase = 16; // minimum body
  static const double sizeMd = 18;
  static const double sizeLg = 20;
  static const double sizeXl = 24;
  static const double size2xl = 30;
  static const double size3xl = 38;
  static const double size4xl = 48;

  /// Display / headline / button style — **Baloo 2**.
  static TextStyle display({
    double size = sizeXl,
    FontWeight weight = FontWeight.w700,
    Color color = AppColors.textPrimary,
    double height = 1.1,
    double letterSpacing = -0.3,
  }) {
    return GoogleFonts.baloo2(
      fontSize: size,
      fontWeight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  /// Body / UI style — **Mukta**.
  static TextStyle body({
    double size = sizeBase,
    FontWeight weight = FontWeight.w400,
    Color color = AppColors.textPrimary,
    double height = 1.5,
    double letterSpacing = 0,
  }) {
    return GoogleFonts.mukta(
      fontSize: size,
      fontWeight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  /// Tiny uppercase eyebrow / status-chip label — Mukta bold, wide tracking.
  static TextStyle eyebrow({Color color = AppColors.textBrand}) {
    return GoogleFonts.mukta(
      fontSize: sizeXs,
      fontWeight: FontWeight.w700,
      color: color,
      height: 1.2,
      letterSpacing: 0.9,
    );
  }

  /// Data style — **Roboto Mono**, tabular numerals (wages, ₹, OTP, IDs).
  static TextStyle mono({
    double size = sizeBase,
    FontWeight weight = FontWeight.w400,
    Color color = AppColors.textPrimary,
    double letterSpacing = -0.2,
  }) {
    return TextStyle(
      fontFamily: monoFamily,
      fontSize: size,
      fontWeight: weight,
      color: color,
      letterSpacing: letterSpacing,
      fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
    );
  }

  /// The full Material [TextTheme] used by [ThemeData]. Display/title slots are
  /// Baloo 2; body/label slots are Mukta. Widgets can still override per-call.
  static TextTheme textTheme() {
    return TextTheme(
      displayLarge: display(size: size3xl, weight: FontWeight.w800),
      displayMedium: display(size: size2xl, weight: FontWeight.w800),
      displaySmall: display(size: sizeXl, weight: FontWeight.w700),
      headlineLarge: display(size: size2xl, weight: FontWeight.w700),
      headlineMedium: display(size: sizeXl, weight: FontWeight.w700),
      headlineSmall: display(size: sizeLg, weight: FontWeight.w700),
      titleLarge: display(size: sizeLg, weight: FontWeight.w600),
      titleMedium: display(size: sizeMd, weight: FontWeight.w600),
      titleSmall: body(size: sizeBase, weight: FontWeight.w600),
      bodyLarge: body(size: sizeMd),
      bodyMedium: body(size: sizeBase),
      bodySmall: body(size: sizeSm, color: AppColors.textSecondary),
      labelLarge: body(size: sizeBase, weight: FontWeight.w700), // buttons
      labelMedium: body(size: sizeSm, weight: FontWeight.w600),
      labelSmall: eyebrow(color: AppColors.textMuted),
    );
  }
}
