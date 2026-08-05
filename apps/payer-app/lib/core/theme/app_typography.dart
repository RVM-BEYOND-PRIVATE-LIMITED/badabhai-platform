import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'app_colors.dart';

/// BadaBhai typography — JUL31 "JOSH" system (LOCKED 2026-07-27).
///
///  - **Anek** (Ek Type) — display & brand voice. Distinctive, Indian; carries
///    Devanagari (same family). Headlines, buttons, salaries, big moments.
///    Wired via `GoogleFonts.anekLatin`, mirroring the JUL31 kit.
///  - **Roboto** (+ system Noto Sans Devanagari fallback) — body & all UI.
///    Neutral, free, renders perfectly on budget handsets and multilingual copy.
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

  /// Display family — **Anek**. Resolved through `GoogleFonts.anekLatin`
  /// (see [bundledBrandFonts]); falls back until the TTF is bundled.
  static const String displayFamily = 'Anek';

  /// Body/UI family — **Roboto** (system font on Android; Noto Sans Devanagari
  /// fallback for regional copy).
  static const String bodyFamily = 'Roboto';

  /// Devanagari fallback for body copy — mirrors the JUL31 kit's `BBType`.
  static const List<String> _devanagariFallback = <String>['Noto Sans Devanagari'];

  /// #350 — whether the display BINARY (Anek) ships inside the APK.
  ///
  /// `false` (current): [display] routes through `GoogleFonts.anekLatin` and
  /// [body]/[eyebrow] through `GoogleFonts.roboto`, so the real Anek + Roboto
  /// faces are fetched at runtime on first use — the same delivery the JUL31
  /// kit and payer-web use.
  ///
  /// `true` is the "binaries bundled" behaviour: [display]/[body]/[eyebrow]
  /// resolve straight off bundled asset families named [displayFamily]/[bodyFamily]
  /// and google_fonts is never called. **This must stay FALSE until an ANEK face
  /// is actually declared under pubspec `fonts:`.** The pubspec here bundles
  /// Baloo 2 + Mukta (DEAD JUL31-predecessor fonts), NOT Anek — so flipping this
  /// TRUE makes [display] ask for a family `'Anek'` that does not exist and every
  /// headline silently renders the system fallback instead of the Anek brand
  /// voice. (This is the exact bug fixed in the worker-app: flip to FALSE and let
  /// google_fonts deliver real Anek.)
  ///
  /// Mutable (not `const`) so a test can drive BOTH sides of the seam; restore
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

  /// Display / headline / button style — **Anek** (via `GoogleFonts.anekLatin`).
  static TextStyle display({
    double size = sizeXl,
    FontWeight weight = FontWeight.w700,
    Color color = AppColors.textPrimary,
    double height = 1.1,
    double letterSpacing = -0.3,
  }) {
    _hardenFontLoading();
    if (bundledBrandFonts) {
      return TextStyle(
        fontFamily: displayFamily,
        fontSize: size,
        fontWeight: weight,
        color: color,
        height: height,
        letterSpacing: letterSpacing,
      );
    }
    return GoogleFonts.anekLatin(
      fontSize: size,
      fontWeight: weight,
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
    return _mukta(
      size: size,
      weight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  /// Tiny uppercase eyebrow / status-chip label — Mukta bold, wide tracking.
  static TextStyle eyebrow({Color color = AppColors.textBrand}) {
    return _mukta(
      size: sizeXs,
      weight: FontWeight.w700,
      color: color,
      height: 1.2,
      letterSpacing: 0.9,
    );
  }

  /// The one Roboto resolver behind [body] + [eyebrow], so the #350 delivery
  /// branch lives in exactly one place. Carries the Devanagari
  /// fallback so regional copy renders on budget handsets.
  static TextStyle _mukta({
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

  /// The full Material [TextTheme] used by [ThemeData]. Display/title slots are
  /// Anek; body/label slots are Roboto. Widgets can still override per-call.
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
