import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'app_colors.dart';

/// BadaBhai typography — ported from `tokens/typography.css`.
///
///  - **Baloo 2** — display & brand voice. Warm, rounded, sturdy; carries
///    Devanagari. Headlines, the logo, big worker-facing moments.
///  - **Mukta** — body & all UI. Calm, highly legible, multilingual. Carries
///    Hinglish/regional copy at low-literacy sizes.
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

  /// Display family. Doubles as the pubspec `fonts:` family name once the
  /// binaries land — see [bundledBrandFonts].
  static const String displayFamily = 'Baloo 2';

  /// Body/UI family. Same deal as [displayFamily].
  static const String bodyFamily = 'Mukta';

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
  /// TRUE since #350: the six Devanagari-carrying binaries (Baloo 2 at wght
  /// 600/700/800, statically instanced from the upstream variable font; Mukta
  /// 400/600/700) ship in `assets/fonts/` and are declared in `pubspec.yaml`,
  /// so google_fonts is never called and no font request leaves the device.
  static bool bundledBrandFonts = true;

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

  /// Display / headline / button style — **Baloo 2**.
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

  /// The one Mukta resolver behind [body] + [eyebrow], so the #350 delivery
  /// branch lives in exactly one place per family.
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
        fontSize: size,
        fontWeight: weight,
        color: color,
        height: height,
        letterSpacing: letterSpacing,
      );
    }
    return GoogleFonts.mukta(
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
