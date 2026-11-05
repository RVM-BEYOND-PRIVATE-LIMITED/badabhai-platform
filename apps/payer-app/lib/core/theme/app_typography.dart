import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'app_colors.dart';

/// BadaBhai typography — JUL31 "JOSH" system (LOCKED 2026-07-27).
///
///  - **Kilimanjaro Sans** (#1999) — the brand voice for the app header and the
///    upper part of a screen ONLY. [header] is the one entry point; every
///    heading below the header uses the normal UI face again.
///  - **Inter** (#2590, bundled; Mukta + Noto Sans Devanagari fallback) — body,
///    UI and every heading below the screen header ([body] / [heading] /
///    [eyebrow]). The brand body/UI face, the same one the worker app ships.
///  - **Roboto Mono** — data: wages, IDs, OTP, counts. Tabular numerals.
///    Self-hosted (see pubspec) so figures render identically offline.
///
/// Body never below 16px. Generous line-height (1.5); headlines tight (1.1)
/// with slight negative tracking.
///
/// **#350 / #2590 — font DELIVERY.** Every family is bundled in the APK; this
/// class never asks google_fonts for a face, and it forces
/// `GoogleFonts.config.allowRuntimeFetching` off so nothing can fetch a font
/// over HTTP at runtime.
class AppTypography {
  AppTypography._();

  /// Self-hosted data font family (declared in pubspec under `fonts:`).
  static const String monoFamily = 'Roboto Mono';

  /// Header family — the brand-kit heading face, **Kilimanjaro Sans** (#1999),
  /// bundled in `assets/fonts/` and declared in pubspec. This is the exact
  /// pubspec `fonts:` family name, so it resolves off the asset with no
  /// google_fonts call.
  static const String headerFamily = 'Kilimanjaro Sans';

  /// Header fallbacks: the bundled Baloo 2 (which carries Devanagari), the
  /// bundled Mukta, then the system Noto Sans Devanagari. Kilimanjaro Sans is
  /// Latin-display only — no ₹, no Devanagari — so those glyphs fall through to
  /// a face that carries them rather than rendering tofu.
  static const List<String> headerFallback = <String>[
    'Baloo 2',
    'Mukta',
    'Noto Sans Devanagari',
  ];

  /// Body/UI family — **Inter** (#2590), bundled in `assets/fonts/` and
  /// declared in pubspec. Exact pubspec family name, so it resolves off the
  /// asset with no google_fonts call and no platform-font substitution.
  static const String bodyFamily = 'Inter';

  /// Body fallbacks: the bundled Mukta (Devanagari), then the system Noto Sans
  /// Devanagari, so regional copy renders on budget handsets.
  static const List<String> bodyFallback = <String>[
    'Mukta',
    'Noto Sans Devanagari',
  ];

  /// #2590 — slam the network door: google_fonts must never fetch a family at
  /// runtime. Every face is bundled. Idempotent; called from every type entry
  /// point so the config is closed before the first style is built.
  static void _hardenFontLoading() {
    GoogleFonts.config.allowRuntimeFetching = false;
  }

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

  /// Header / upper-part style — **Kilimanjaro Sans** (#1999), the brand-kit
  /// heading face, bundled in `assets/fonts/`. NO google_fonts call: the face is
  /// in the APK, so this never touches the network. The fallback chain carries
  /// the ₹ and Devanagari glyphs the display cut lacks.
  ///
  /// Use this ONLY for the app header and the upper part of a screen. Every
  /// heading below that uses [heading] (the old normal face).
  static TextStyle header({
    double size = sizeXl,
    FontWeight weight = FontWeight.w700,
    Color color = AppColors.textPrimary,
    double height = 1.1,
    double letterSpacing = -0.3,
  }) {
    _hardenFontLoading();
    return TextStyle(
      fontFamily: headerFamily,
      fontFamilyFallback: headerFallback,
      fontSize: size,
      fontWeight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  /// Section / card heading below the screen header — the normal UI face
  /// (Inter), with the display metrics so the hierarchy stays the same.
  static TextStyle heading({
    double size = sizeXl,
    FontWeight weight = FontWeight.w700,
    Color color = AppColors.textPrimary,
    double height = 1.1,
    double letterSpacing = -0.3,
  }) {
    return _ui(
      size: size,
      weight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  /// Body / UI style — **Inter**.
  static TextStyle body({
    double size = sizeBase,
    FontWeight weight = FontWeight.w400,
    Color color = AppColors.textPrimary,
    double height = 1.5,
    double letterSpacing = 0,
  }) {
    return _ui(
      size: size,
      weight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  /// Tiny uppercase eyebrow / status-chip label — Inter bold, wide tracking.
  static TextStyle eyebrow({Color color = AppColors.textBrand}) {
    return _ui(
      size: sizeXs,
      weight: FontWeight.w700,
      color: color,
      height: 1.2,
      letterSpacing: 0.9,
    );
  }

  /// The one Inter resolver behind [body] + [heading] + [eyebrow]. Carries the
  /// Devanagari fallback so regional copy renders on budget handsets.
  static TextStyle _ui({
    required double size,
    required FontWeight weight,
    required Color color,
    required double height,
    required double letterSpacing,
  }) {
    _hardenFontLoading();
    return TextStyle(
      fontFamily: bodyFamily,
      fontFamilyFallback: bodyFallback,
      fontSize: size,
      fontWeight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
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

  /// The full Material [TextTheme] used by [ThemeData]. Display/headline and
  /// the app-bar title are the brand header face; every slot below that uses
  /// the normal UI face (Inter). Widgets can still override per-call.
  static TextTheme textTheme() {
    return TextTheme(
      displayLarge: header(size: size3xl, weight: FontWeight.w800),
      displayMedium: header(size: size2xl, weight: FontWeight.w800),
      displaySmall: header(size: sizeXl, weight: FontWeight.w700),
      headlineLarge: header(size: size2xl, weight: FontWeight.w700),
      headlineMedium: header(size: sizeXl, weight: FontWeight.w700),
      headlineSmall: header(size: sizeLg, weight: FontWeight.w700),
      titleLarge: header(size: sizeLg, weight: FontWeight.w600),
      titleMedium: heading(size: sizeMd, weight: FontWeight.w600),
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
