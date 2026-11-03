import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:payer_app/core/theme/app_typography.dart';

/// Payer-app typography split.
///
/// The brand face (Kilimanjaro Sans) belongs to the app header and the upper
/// part of a screen ONLY. Everything below the header — section/card headings,
/// body, UI labels — uses the old normal face (Roboto). These tests pin both
/// halves of that boundary so a future "make it consistent" change cannot
/// quietly make the whole app bold again.
void main() {
  // Installs the test HttpOverrides, so a case that leaves runtime fetching ON
  // fails fast against the mock client instead of reaching fonts.gstatic.com.
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  tearDown(() {
    // Restore the SHIPPED state — every other test in the app reads it.
    AppTypography.bundledBrandFonts = false;
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('header() — the brand face, header/upper part only', () {
    test('is Kilimanjaro Sans with the brand fallback chain on both branches',
        () {
      for (final bool bundled in <bool>[false, true]) {
        AppTypography.bundledBrandFonts = bundled;
        final TextStyle style = AppTypography.header();
        expect(style.fontFamily, 'Kilimanjaro Sans');
        expect(style.fontFamilyFallback, contains('Baloo 2'));
      }
    });

    test('carries the full type scale through, not just the family', () {
      final TextStyle s = AppTypography.header(
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
  });

  group('body()/heading()/eyebrow() — the old normal face below the header',
        () {
    test('ships on the fetch branch (bundledBrandFonts = false)', () {
      expect(AppTypography.bundledBrandFonts, isFalse);
    });

    testWidgets('resolve to Roboto through google_fonts on the shipped branch',
        (WidgetTester tester) async {
      AppTypography.bundledBrandFonts = false;

      for (final TextStyle Function() call in <TextStyle Function()>[
        () => AppTypography.body(),
        () => AppTypography.heading(),
        () => AppTypography.eyebrow(),
      ]) {
        final TextStyle style = call();
        expect(style.fontFamily, contains('Roboto'));
        expect(style.fontFamily, isNot('Kilimanjaro Sans'));
        expect(
          style.fontFamilyFallback,
          contains('Noto Sans Devanagari'),
        );
      }
    });

    testWidgets('do not force the runtime-fetch config off on the fetch branch',
        (WidgetTester tester) async {
      AppTypography.bundledBrandFonts = false;
      GoogleFonts.config.allowRuntimeFetching = true;

      AppTypography.body();
      AppTypography.heading();
      AppTypography.eyebrow();

      // Only ever tighten. Forcing this false while on the fetch branch would
      // hand EVERY payer fallback glyphs, online ones included.
      expect(GoogleFonts.config.allowRuntimeFetching, isTrue);
    });

    test('with bundledBrandFonts = true, name the Roboto family directly', () {
      AppTypography.bundledBrandFonts = true;

      for (final TextStyle Function() call in <TextStyle Function()>[
        () => AppTypography.body(),
        () => AppTypography.heading(),
        () => AppTypography.eyebrow(),
      ]) {
        expect(call().fontFamily, 'Roboto');
      }
    });
  });

  group('textTheme()', () {
    testWidgets('header slots are Kilimanjaro; every slot below is Roboto',
        (WidgetTester tester) async {
      final TextTheme t = AppTypography.textTheme();

      final List<TextStyle?> headerSlots = <TextStyle?>[
        t.displayLarge,
        t.displayMedium,
        t.displaySmall,
        t.headlineLarge,
        t.headlineMedium,
        t.headlineSmall,
        t.titleLarge, // the app-bar title
      ];
      for (final TextStyle? s in headerSlots) {
        expect(s!.fontFamily, 'Kilimanjaro Sans');
      }

      final List<TextStyle?> normalSlots = <TextStyle?>[
        t.titleMedium,
        t.titleSmall,
        t.bodyLarge,
        t.bodyMedium,
        t.bodySmall,
        t.labelLarge,
        t.labelMedium,
        t.labelSmall,
      ];
      for (final TextStyle? s in normalSlots) {
        expect(s!.fontFamily, isNot('Kilimanjaro Sans'));
      }
    });
  });

  test('mono stays self-hosted regardless of the brand-font switch', () {
    for (final bool bundled in <bool>[false, true]) {
      AppTypography.bundledBrandFonts = bundled;
      expect(AppTypography.mono().fontFamily, 'Roboto Mono');
    }
  });
}
