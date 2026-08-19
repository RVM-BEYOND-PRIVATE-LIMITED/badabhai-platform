import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/theme/app_typography.dart';

/// The brand-font DELIVERY seam.
///
/// CRASH FIX: the shipped default is now `bundledBrandFonts = true` — google_fonts
/// is never called, so no runtime fetch can throw (a flaky-link fetch crashed a
/// real device). These lock down that default path (asset/platform families,
/// network hard-barred) AND that the legacy google_fonts path, if ever re-enabled,
/// still bars fetching.
void main() {
  // Installs the test HttpOverrides, so the one case below that leaves runtime
  // fetching ON fails fast against the mock client instead of actually reaching
  // fonts.gstatic.com from CI.
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  tearDown(() {
    // Restore BOTH globals to the shipped defaults — this suite drives them on
    // purpose and every other test in the app reads them.
    AppTypography.bundledBrandFonts = true;
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('bundledBrandFonts = true (post-migration)', () {
    setUp(() => AppTypography.bundledBrandFonts = true);

    test('display/body/eyebrow resolve to the bundled asset families', () {
      // The exact pubspec `fonts:` family names — no google_fonts variant
      // suffix ("Baloo2_regular"), which is what proves the fetch path is out
      // of the picture rather than merely cached.
      expect(AppTypography.display().fontFamily, 'Anek');
      expect(AppTypography.body().fontFamily, 'Roboto');
      expect(AppTypography.eyebrow().fontFamily, 'Roboto');
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
        expect(s!.fontFamily, anyOf('Anek', 'Roboto'));
      }
    });
  });

  // The LEGACY google_fonts path (only reached if someone flips the flag back to
  // false). It rejects its fire-and-forget load future when the assets are
  // missing; `testWidgets` runs under FakeAsync so that rejection is never pumped
  // (how the rest of the widget suite coexists with google_fonts). A plain
  // `test()` here would fail on the unhandled async error, not the assertion.
  group('bundledBrandFonts = false (legacy google_fonts path)', () {
    setUp(() => AppTypography.bundledBrandFonts = false);

    testWidgets('routes through the google_fonts families',
        (WidgetTester tester) async {
      expect(AppTypography.display().fontFamily, isNot('Anek'));
      expect(AppTypography.display().fontFamilyFallback, contains('AnekLatin'));
      expect(AppTypography.body().fontFamilyFallback, contains('Noto Sans Devanagari'));
    });

    testWidgets('STILL bars runtime fetching (crash fix — never the network)',
        (WidgetTester tester) async {
      GoogleFonts.config.allowRuntimeFetching = true;

      AppTypography.display();
      AppTypography.body();

      // configureFontLoading() now fires unconditionally: even the google_fonts
      // path must never reach fonts.gstatic.com, whose flaky-link failure crashed
      // a real device.
      expect(GoogleFonts.config.allowRuntimeFetching, isFalse);
    });
  });

  test('mono stays self-hosted regardless of the brand-font switch', () {
    for (final bool bundled in <bool>[false, true]) {
      AppTypography.bundledBrandFonts = bundled;
      expect(AppTypography.mono().fontFamily, 'Roboto Mono');
    }
  });
}
