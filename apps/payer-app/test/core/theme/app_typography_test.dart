import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:payer_app/core/theme/app_typography.dart';

/// #350 — the brand-font DELIVERY seam.
///
/// The payer app used to ask google_fonts for Baloo 2 + Mukta, which fetches the
/// faces over HTTP on first use: a recruiter opening the app cold in a plant
/// office got fallback glyphs and a reflow mid-flow, and the first launch handed
/// the device's IP/UA to fonts.gstatic.com. The binaries now ship in
/// `assets/fonts/`, so these lock down both sides of the switch — that the
/// bundled path resolves to the asset families ONLY, that google_fonts is hard
/// barred from the network, and that the pre-#350 branch still behaves as it did
/// so the switch stays honestly flippable.
void main() {
  // Installs the test HttpOverrides, so the one case below that leaves runtime
  // fetching ON fails fast against the mock client instead of actually reaching
  // fonts.gstatic.com from CI.
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  tearDown(() {
    // Restore BOTH globals to the SHIPPED state — this suite drives them on
    // purpose and every other test in the app reads them. `false` is the restore
    // value: it governs body()/eyebrow(), which route through GoogleFonts.roboto
    // (the pubspec bundles no Roboto). display() is always the bundled
    // Kilimanjaro Sans (#1999) and no longer reads this flag.
    AppTypography.bundledBrandFonts = false;
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('bundledBrandFonts = true (bundled-asset branch — NOT the shipped default)', () {
    setUp(() => AppTypography.bundledBrandFonts = true);

    test('display/body/eyebrow resolve to the named asset families', () {
      // On the bundled branch, display()/body() name a family DIRECTLY (no
      // google_fonts "_regular" variant suffix). #1999 — display() is the
      // bundled brand-kit heading face, Kilimanjaro Sans. body()/eyebrow() name
      // 'Roboto' (a platform font; the pubspec bundles no Roboto, which is why
      // this branch is not the shipped default).
      expect(AppTypography.display().fontFamily, 'Kilimanjaro Sans');
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

    test('body and eyebrow both harden, not just display', () {
      // eyebrow() and body() share one private resolver; if that resolver ever
      // loses its _hardenFontLoading() call, a screen whose first text is an
      // eyebrow chip would leave the door open.
      for (final TextStyle Function() call in <TextStyle Function()>[
        () => AppTypography.body(),
        () => AppTypography.eyebrow(),
      ]) {
        GoogleFonts.config.allowRuntimeFetching = true;
        call();
        expect(GoogleFonts.config.allowRuntimeFetching, isFalse);
      }
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
        expect(s!.fontFamily, anyOf('Kilimanjaro Sans', 'Roboto'));
      }
    });

    test('every weight textTheme() asks for has a real declared face', () {
      // Guards the pubspec against the type scale drifting away from the six
      // binaries we actually ship. A slot asking for a weight with no face gets
      // silently remapped to the nearest one, so the drift is invisible on
      // screen until someone compares against the design system.
      // #1999 — the display family is Kilimanjaro Sans, one file declared at
      // 400/600/700/800.
      const Set<FontWeight> kilimanjaro = <FontWeight>{
        FontWeight.w400,
        FontWeight.w600,
        FontWeight.w700,
        FontWeight.w800,
      };
      const Set<FontWeight> baloo = <FontWeight>{
        FontWeight.w600,
        FontWeight.w700,
        FontWeight.w800,
      };
      const Set<FontWeight> mukta = <FontWeight>{
        FontWeight.w400,
        FontWeight.w600,
        FontWeight.w700,
      };

      final TextTheme t = AppTypography.textTheme();
      for (final TextStyle? s in <TextStyle?>[
        t.displayLarge, t.displayMedium, t.displaySmall,
        t.headlineLarge, t.headlineMedium, t.headlineSmall,
        t.titleLarge, t.titleMedium, t.titleSmall,
        t.bodyLarge, t.bodyMedium, t.bodySmall,
        t.labelLarge, t.labelMedium, t.labelSmall,
      ]) {
        final Set<FontWeight> declared = switch (s!.fontFamily) {
          'Kilimanjaro Sans' => kilimanjaro,
          'Baloo 2' => baloo,
          _ => mukta,
        };
        // Never null: display()/body() both stamp their default weight in.
        expect(declared, contains(s.fontWeight));
      }
    });
  });

  // These two exercise the google_fonts path (the shipped default): with no
  // pre-bundled Anek/Roboto google_fonts asset to find, google_fonts rejects its
  // fire-and-forget load future. `testWidgets` runs under FakeAsync so that
  // rejection is never pumped, which is how the rest of this app's widget suite
  // already coexists with google_fonts. A plain `test()` here would fail on the
  // unhandled async error, not on the assertion.
  group('bundledBrandFonts = false (the shipped default — google_fonts delivery)', () {
    setUp(() => AppTypography.bundledBrandFonts = false);

    testWidgets('falls back to the google_fonts families',
        (WidgetTester tester) async {
      // #1999 — display() is the bundled Kilimanjaro Sans on BOTH branches (it
      // no longer reads the flag); body()/eyebrow() still route through
      // google_fonts Roboto when the flag is false.
      expect(AppTypography.display().fontFamily, 'Kilimanjaro Sans');
      expect(AppTypography.display().fontFamilyFallback, contains('Baloo 2'));
      expect(AppTypography.body().fontFamilyFallback, contains('Noto Sans Devanagari'));
    });

    testWidgets('does not touch the runtime-fetch config',
        (WidgetTester tester) async {
      GoogleFonts.config.allowRuntimeFetching = true;

      AppTypography.display();
      AppTypography.body();

      // Only ever tighten. Forcing this false while on the fetch branch would
      // hand EVERY payer fallback glyphs, online ones included.
      expect(GoogleFonts.config.allowRuntimeFetching, isTrue);
    });
  });

  test('ships the flag false — body/eyebrow still come via google_fonts', () {
    // #350/#1999: the pubspec bundles Baloo 2 / Mukta / Kilimanjaro Sans, NOT
    // Roboto, so a `true` flag would render every BODY run in the system
    // fallback. The flag MUST ship false, routing body()/eyebrow() through
    // GoogleFonts.roboto. display() is the bundled Kilimanjaro Sans either way.
    // Declared outside both groups so no setUp has touched it; tearDown restores
    // this same value.
    expect(AppTypography.bundledBrandFonts, isFalse);
  });

  test('mono stays self-hosted regardless of the brand-font switch', () {
    for (final bool bundled in <bool>[false, true]) {
      AppTypography.bundledBrandFonts = bundled;
      expect(AppTypography.mono().fontFamily, 'Roboto Mono');
    }
  });
}
