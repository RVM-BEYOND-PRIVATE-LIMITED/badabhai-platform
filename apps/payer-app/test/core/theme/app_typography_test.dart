import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:payer_app/core/theme/app_typography.dart';

/// Payer-app typography split.
///
/// The brand face (Kilimanjaro Sans) belongs to the app header and the upper
/// part of a screen ONLY. Everything below the header — section/card headings,
/// body, UI labels — uses the normal UI face, Inter (#2590: bundled, it replaced
/// Roboto fetched at runtime). These tests pin both
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
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('header() — the brand face, header/upper part only', () {
    test('is Kilimanjaro Sans with the brand fallback chain', () {
      final TextStyle style = AppTypography.header();
      expect(style.fontFamily, 'Kilimanjaro Sans');
      expect(style.fontFamilyFallback, contains('Baloo 2'));
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

  group('body()/heading()/eyebrow() — Inter below the header (#2590)', () {
    test('name the bundled Inter family directly, with Devanagari fallback',
        () {
      for (final TextStyle Function() call in <TextStyle Function()>[
        () => AppTypography.body(),
        () => AppTypography.heading(),
        () => AppTypography.eyebrow(),
      ]) {
        final TextStyle style = call();
        // Exact family, not a google_fonts `Inter_regular` alias: the face
        // resolves off the bundled asset.
        expect(style.fontFamily, 'Inter');
        expect(style.fontFamily, isNot(contains('Roboto')));
        expect(style.fontFamilyFallback, contains('Mukta'));
        expect(style.fontFamilyFallback, contains('Noto Sans Devanagari'));
      }
    });

    test('force runtime font fetching OFF — no face is ever downloaded', () {
      // Even if something re-enabled it, building any style closes the door.
      GoogleFonts.config.allowRuntimeFetching = true;
      AppTypography.body();
      expect(GoogleFonts.config.allowRuntimeFetching, isFalse);

      GoogleFonts.config.allowRuntimeFetching = true;
      AppTypography.header();
      expect(GoogleFonts.config.allowRuntimeFetching, isFalse);
    });
  });

  group('textTheme()', () {
    testWidgets('header slots are Kilimanjaro; every slot below is Inter',
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
        expect(s!.fontFamily, 'Inter');
      }
    });
  });

  test('mono stays the self-hosted Roboto Mono', () {
    expect(AppTypography.mono().fontFamily, 'Roboto Mono');
  });
}
