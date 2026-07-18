import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/theme/app_typography.dart';

/// #350 — the brand-font DELIVERY seam.
///
/// Baloo 2 + Mukta binaries are not in the repo yet, so the shipped default is
/// still the google_fonts (runtime-fetch) path. What these lock down is that the
/// bundled path is real and correct the moment the files land: asset families
/// only, and google_fonts hard-barred from ever reaching the network.
void main() {
  // Installs the test HttpOverrides, so the one case below that leaves runtime
  // fetching ON fails fast against the mock client instead of actually reaching
  // fonts.gstatic.com from CI.
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  tearDown(() {
    // Restore BOTH globals — this suite drives them on purpose and every other
    // test in the app reads them.
    AppTypography.bundledBrandFonts = false;
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('bundledBrandFonts = true (post-migration)', () {
    setUp(() => AppTypography.bundledBrandFonts = true);

    test('display/body/eyebrow resolve to the bundled asset families', () {
      // The exact pubspec `fonts:` family names — no google_fonts variant
      // suffix ("Baloo2_regular"), which is what proves the fetch path is out
      // of the picture rather than merely cached.
      expect(AppTypography.display().fontFamily, 'Baloo 2');
      expect(AppTypography.body().fontFamily, 'Mukta');
      expect(AppTypography.eyebrow().fontFamily, 'Mukta');
    });

    test('bars google_fonts from fetching at runtime', () {
      GoogleFonts.config.allowRuntimeFetching = true;

      AppTypography.display();

      // Bundled means bundled: nothing may go to the network for a family that
      // already ships inside the APK.
      expect(GoogleFonts.config.allowRuntimeFetching, isFalse);
    });

    test('carries the full type scale through, not just the family', () {
      final TextStyle s = AppTypography.display(
        size: AppTypography.size3xl,
        weight: FontWeight.w800,
        color: const Color(0xFF123456),
        height: 1.1,
        letterSpacing: -0.3,
      );

      expect(s.fontSize, AppTypography.size3xl);
      expect(s.fontWeight, FontWeight.w800);
      expect(s.color, const Color(0xFF123456));
      expect(s.height, 1.1);
      expect(s.letterSpacing, -0.3);
    });

    test('textTheme() is entirely bundled — no slot escapes to google_fonts',
        () {
      final TextTheme t = AppTypography.textTheme();
      final List<TextStyle?> slots = <TextStyle?>[
        t.displayLarge, t.displayMedium, t.displaySmall,
        t.headlineLarge, t.headlineMedium, t.headlineSmall,
        t.titleLarge, t.titleMedium, t.titleSmall,
        t.bodyLarge, t.bodyMedium, t.bodySmall,
        t.labelLarge, t.labelMedium, t.labelSmall,
      ];

      for (final TextStyle? s in slots) {
        expect(s!.fontFamily, anyOf('Baloo 2', 'Mukta'));
      }
    });
  });

  // These two exercise the google_fonts path, which — with no Baloo2/Mukta
  // assets to find — rejects its fire-and-forget load future. `testWidgets`
  // runs under FakeAsync so that rejection is never pumped, which is exactly how
  // the rest of this app's widget suite already coexists with google_fonts. A
  // plain `test()` here would fail on the unhandled async error, not on the
  // assertion.
  group('bundledBrandFonts = false (today — binaries still missing)', () {
    testWidgets('falls back to the google_fonts families',
        (WidgetTester tester) async {
      // Deliberately NOT the asset family name: until the binaries land we keep
      // asking google_fonts, because forcing allowRuntimeFetching=false with no
      // assets would hand EVERY worker fallback glyphs, online ones included.
      expect(AppTypography.display().fontFamily, isNot('Baloo 2'));
      expect(AppTypography.display().fontFamilyFallback, contains('Baloo2'));
      expect(AppTypography.body().fontFamilyFallback, contains('Mukta'));
    });

    testWidgets('does not touch the runtime-fetch config',
        (WidgetTester tester) async {
      GoogleFonts.config.allowRuntimeFetching = true;

      AppTypography.display();
      AppTypography.body();

      // Only ever tighten. Widget tests across the suite set this to false
      // themselves; re-enabling it here would put them all on the network.
      expect(GoogleFonts.config.allowRuntimeFetching, isTrue);
    });
  });

  test('mono stays self-hosted regardless of the brand-font switch', () {
    for (final bool bundled in <bool>[false, true]) {
      AppTypography.bundledBrandFonts = bundled;
      expect(AppTypography.mono().fontFamily, 'Roboto Mono');
    }
  });
}
