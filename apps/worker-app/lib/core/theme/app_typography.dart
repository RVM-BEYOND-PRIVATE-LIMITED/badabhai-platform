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

  /// #350 — whether the Baloo 2 + Mukta BINARIES ship inside the APK.
  ///
  /// `false` (today): the binaries are not in the repo, so we go on asking
  /// google_fonts for them, which fetches over HTTP on first use. That is bad
  /// for exactly our audience — an APK sideloaded via SHAREit or a first launch
  /// on 2G renders every headline and body string in the platform fallback and
  /// reflows mid-flow as the files land — but it is strictly better than the
  /// alternative available without binaries: forcing
  /// `allowRuntimeFetching = false` right now would guarantee the fallback for
  /// EVERY worker, online ones included, and silently drop the locked Desi
  /// Vernacular Pop type system on the floor.
  ///
  /// `true`: [display]/[body]/[eyebrow] resolve straight off the bundled asset
  /// families and google_fonts is never called, so no request is ever made. The
  /// switch is deliberately the LAST step of the migration — flip it in the same
  /// commit that adds the files and the pubspec `fonts:` entries, never before,
  /// or the app renders fallback glyphs for families that do not exist.
  ///
  /// Mutable (not `const`) so a test can drive BOTH sides of the seam; restore
  /// it in `tearDown`.
  ///
  /// FALSE since the Josh re-skin (2026-08-04): [displayFamily] now names **Anek**,
  /// which the pubspec does NOT bundle (it still ships the DEAD Baloo 2/Mukta
  /// binaries). With this TRUE, `display()` asked Flutter for a font family named
  /// 'Anek' that does not exist, so EVERY headline/button/salary silently rendered
  /// in the platform fallback — NOT Anek, not even Baloo. Flipping to FALSE routes
  /// display through `GoogleFonts.anekLatin`, which fetches real Anek at runtime —
  /// the SAME delivery the kit gallery and apps/payer-web use. Cost: a first launch
  /// with no network shows the fallback until the file lands (then it is cached),
  /// which is strictly better than the permanent fallback TRUE produced.
  ///
  /// The offline-safe upgrade (DESIGN_SPEC §3 "bundle subsetted Anek, drop the
  /// google_fonts fetch") is to add Anek Latin/Devanagari .ttf to assets/fonts/,
  /// declare `family: Anek` in pubspec, drop the dead Baloo 2/Mukta, and flip this
  /// back to TRUE — in that one commit. Until those binaries exist, FALSE is correct.
  static bool bundledBrandFonts = false;

  /// #350 — once the binaries are bundled, slam the network door: google_fonts
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

  /// Display / headline / button style — **Anek**.
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
    _hardenFontLoading();
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
