import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'app_colors.dart';

/// BadaBhai typography — **"Josh" system** (LOCKED 2026-07-27).
///
///  - **Anek** — display & brand voice (Ek Type). Distinctive, Indian; a
///    matching Anek Devanagari family means Hindi & English speak alike.
///    Headlines, the logo, big worker-facing moments, buttons, ₹ salaries.
///  - **Roboto** — body & all UI, with Noto Sans Devanagari fallback. Neutral,
///    free, renders perfectly on budget handsets at low-literacy sizes.
///  - **Roboto Mono** — data: wages, IDs, OTP, counts. Tabular numerals.
///    Self-hosted (see pubspec) so figures render identically offline.
///
/// Body never below 16px; worker-facing copy skews larger (18–20). Generous
/// line-height (1.5); headlines tight (1.1) with slight negative tracking.
///
/// **#350 — brand-font DELIVERY.** This class is the ONLY google_fonts call site
/// in `lib/`, so it is also the single seam where font delivery is decided. See
/// [bundledBrandFonts] and `assets/fonts/README.md` for the state of that
/// migration and the exact binaries it is waiting on.
class AppTypography {
  AppTypography._();

  /// Self-hosted data font family (declared in pubspec under `fonts:`).
  static const String monoFamily = 'Roboto Mono';

  /// Display family — **Anek** (Ek Type). Doubles as the pubspec `fonts:`
  /// family name once the binaries land — see [bundledBrandFonts]. Until then
  /// the string falls back (the bundled Baloo 2 assets don't match this name).
  static const String displayFamily = 'Anek';

  /// Body/UI family — **Roboto** (a platform font on Android). Devanagari copy
  /// falls through to [bodyFallback].
  static const String bodyFamily = 'Roboto';

  /// Devanagari fallback for body copy — free system font on budget handsets.
  static const List<String> bodyFallback = <String>['Noto Sans Devanagari'];

  /// Whether [display]/[body]/[eyebrow] resolve straight off a font FAMILY name
  /// (a bundled asset or a platform font) instead of going through google_fonts.
  ///
  /// `true` (today — CRASH FIX): google_fonts is NEVER called, so no HTTP fetch is
  /// ever made. This is what actually stops the crash: with `false`, `display()`
  /// called `GoogleFonts.anekLatin`, whose async font load throws uncaught on a
  /// device — a `ClientException` when a flaky-link fetch resets, OR (if fetching
  /// were merely disabled) a "font not found in assets" Exception because the Anek
  /// binaries are NOT bundled. Either throw, landing during the first frames
  /// before the crash reporter is ready, aborts the app (Firebase flagged a real
  /// device). Returning a plain `TextStyle` removes the whole async path:
  ///  - [bodyFamily] `'Roboto'` is a platform font on Android → real Roboto;
  ///  - [displayFamily] `'Anek'` is NOT bundled yet → Flutter renders the platform
  ///    FALLBACK for headlines/buttons/₹ (a silent glyph swap, never a throw).
  ///
  /// The COST is honest: headlines lose Anek until the binaries ship. That is a
  /// visual downgrade, but a graceful one — strictly better than crashing our
  /// low-connectivity audience. The real upgrade (DESIGN_SPEC §3) is to add Anek
  /// Latin/Devanagari .ttf to assets/fonts/ + declare `family: Anek` in pubspec;
  /// then this stays `true` and the headlines render true Anek off the asset with
  /// still no google_fonts call.
  ///
  /// Mutable (not `const`) so a test can drive both sides of the seam; restore it
  /// in `tearDown`.
  static bool bundledBrandFonts = true;

  /// Slam the network door on google_fonts: it must NEVER fetch a font over HTTP
  /// at runtime. Call ONCE from `main()` before the first frame.
  ///
  /// CRASH FIX. This used to fire only once fonts were bundled
  /// ([bundledBrandFonts]), leaving the runtime fetch ON until then — but that
  /// fetch is the crash source: on a flaky link
  /// `google_fonts._httpFetchFontAndSaveToDevice` throws a `ClientException`, and
  /// when it lands during the FIRST FRAMES (where headlines / PIN cells first
  /// build) it reaches the crash reporter's async handler BEFORE Crashlytics is
  /// ready, whose pre-ready branch returns `false` — so the engine aborts. That is
  /// a fatal crash on a transient, recoverable network error, hitting exactly our
  /// low-connectivity audience (Firebase Analytics flagged a real device).
  ///
  /// Turning fetching OFF removes the whole class: google_fonts still loads a font
  /// it has ALREADY cached on disk (a worker who fetched Anek before keeps it) and
  /// any bundled asset family, and otherwise falls back to the platform font — a
  /// graceful glyph swap, never a network call and never a crash.
  ///
  /// Only ever TIGHTENS the config, never re-enables fetching (that would put the
  /// test suite on the network too). Idempotent.
  static void configureFontLoading() {
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

  /// Display / headline / button style — **Anek**.
  static TextStyle display({
    double size = sizeXl,
    FontWeight weight = FontWeight.w700,
    Color color = AppColors.textPrimary,
    double height = 1.1,
    double letterSpacing = -0.3,
  }) {
    configureFontLoading();
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

  /// Body / UI style — **Roboto** (+ Noto Sans Devanagari fallback).
  static TextStyle body({
    double size = sizeBase,
    FontWeight weight = FontWeight.w400,
    Color color = AppColors.textPrimary,
    double height = 1.5,
    double letterSpacing = 0,
  }) {
    return _body(
      size: size,
      weight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  /// Tiny uppercase eyebrow / status-chip label — Roboto bold, wide tracking.
  static TextStyle eyebrow({Color color = AppColors.textBrand}) {
    return _body(
      size: sizeXs,
      weight: FontWeight.w700,
      color: color,
      height: 1.2,
      letterSpacing: 0.9,
    );
  }

  /// The one Roboto resolver behind [body] + [eyebrow], so the #350 delivery
  /// branch lives in exactly one place per family. Devanagari copy falls
  /// through to [bodyFallback] on either branch.
  static TextStyle _body({
    required double size,
    required FontWeight weight,
    required Color color,
    required double height,
    required double letterSpacing,
  }) {
    configureFontLoading();
    if (bundledBrandFonts) {
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
    return GoogleFonts.roboto(
      fontSize: size,
      fontWeight: weight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    ).copyWith(fontFamilyFallback: bodyFallback);
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
