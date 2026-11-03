import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'app_colors.dart';

/// BadaBhai typography — JUL31 "JOSH" system (LOCKED 2026-07-27).
///
///  - **Kilimanjaro Sans** (#1999) — the brand voice for the app header and the
///    upper part of a screen ONLY. [header] is the one entry point; every
///    heading below the header uses the normal UI face again.
///  - **Roboto** (+ system Noto Sans Devanagari fallback) — body, UI and every
///    heading below the screen header ([body] / [heading] / [eyebrow]). Neutral,
///    free, renders perfectly on budget handsets and multilingual copy.
///  - **Roboto Mono** — data: wages, IDs, OTP, counts. Tabular numerals.
///    Self-hosted (see pubspec) so figures render identically offline.
///
/// Body never below 16px. Generous line-height (1.5); headlines tight (1.1)
/// with slight negative tracking.
///
/// **#350 — brand-font DELIVERY.** This class is the ONLY google_fonts call site
/// in `lib/`, so it is also the single seam where font delivery is decided. See
/// [bundledBrandFonts].
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

  /// Body/UI family — **Roboto** (system font on Android; Noto Sans Devanagari
  /// fallback for regional copy). The old normal face, used below the header.
  static const String bodyFamily = 'Roboto';

  /// Devanagari fallback for body copy — mirrors the JUL31 kit's `BBType`.
  static const List<String> _devanagariFallback = <String>[
    'Noto Sans Devanagari'
  ];

  /// #350 — whether the BODY binaries ship inside the APK.
  ///
  /// `false` (shipped): [body]/[heading]/[eyebrow] route through
  /// `GoogleFonts.roboto`, so the real Roboto face is fetched at runtime on
  /// first use. [header] is ALWAYS the bundled Kilimanjaro Sans and does not
  /// consult this flag.
  ///
  /// `true` is the "body binaries bundled" behaviour. The pubspec bundles Baloo
  /// 2 + Mukta + Kilimanjaro Sans, NOT Roboto — so flipping this TRUE makes
  /// body ask for a family `'Roboto'` that is only a platform font.
  ///
  /// Mutable (not `const`) so a test can drive both sides of the seam; restore
  /// it in `tearDown`.
  static bool bundledBrandFonts = false;

  /// #350 — the binaries are bundled, so slam the network door: google_fonts
  /// must never quietly fetch a family we already ship.
  ///
  /// Only ever TIGHTENS the config, never re-enables fetching. Widget tests set
  /// `allowRuntimeFetching = false` themselves; flipping it back to `true` here
  /// would put the whole suite on the network. Deliberately NOT memoised — the
  /// write is idempotent and a one-shot latch would just be hidden state that
  /// makes the switch un-flippable within a process (tests do flip it).
  static void _hardenFontLoading() {
    if (!bundledBrandFonts) return;
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
    // #350 — on the bundled branch every type entry point slams the google_fonts
    // network door (a no-op on the fetch branch, where body()/eyebrow() need it).
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

  /// Section / card heading below the screen header — the OLD normal face
  /// (Roboto), with the display metrics so the hierarchy stays the same.
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

  /// Body / UI style — **Roboto**.
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

  /// Tiny uppercase eyebrow / status-chip label — Roboto bold, wide tracking.
  static TextStyle eyebrow({Color color = AppColors.textBrand}) {
    return _ui(
      size: sizeXs,
      weight: FontWeight.w700,
      color: color,
      height: 1.2,
      letterSpacing: 0.9,
    );
  }

  /// The one Roboto resolver behind [body] + [heading] + [eyebrow], so the
  /// #350 delivery branch lives in exactly one place per family. Carries the
  /// Devanagari fallback so regional copy renders on budget handsets.
  static TextStyle _ui({
    required double size,
    required FontWeight weight,
    required Color color,
    required double height,
    required double letterSpacing,
  }) {
    _hardenFontLoading();
    if (bundledBrandFonts) {
      return TextStyle(
        fontFamily: bodyFamily,
        fontFamilyFallback: _devanagariFallback,
        fontSize: size,
        fontWeight: weight,
        color: color,
        height: height,
        letterSpacing: letterSpacing,
      );
    }
    return GoogleFonts.roboto(
      fontSize: size,
      fontWeight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    ).copyWith(fontFamilyFallback: _devanagariFallback);
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
  /// the old normal face. Widgets can still override per-call.
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
