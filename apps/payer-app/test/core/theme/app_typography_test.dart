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
    // purpose and every other test in the app reads them. `true` (not `false`)
    // is the restore value because the binaries are in the repo: it is what
    // `main()` runs with.
    AppTypography.bundledBrandFonts = true;
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('bundledBrandFonts = true (shipped)', () {
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
        expect(s!.fontFamily, anyOf('Baloo 2', 'Mukta'));
      }
    });

    test('every weight textTheme() asks for has a real declared face', () {
      // Guards the pubspec against the type scale drifting away from the six
      // binaries we actually ship. A slot asking for a weight with no face gets
      // silently remapped to the nearest one, so the drift is invisible on
      // screen until someone compares against the design system.
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
        final Set<FontWeight> declared =
            s!.fontFamily == 'Baloo 2' ? baloo : mukta;
        // Never null: display()/body() both stamp their default weight in.
        expect(declared, contains(s.fontWeight));
      }
    });
  });

  // These two exercise the google_fonts path, which — with no google_fonts-named
  // Baloo2/Mukta assets to find (ours are declared as the 'Baloo 2'/'Mukta'
  // pubspec families, not under the google_fonts asset naming) — rejects its
  // fire-and-forget load future. `testWidgets` runs under FakeAsync so that
  // rejection is never pumped, which is how the rest of this app's widget suite
  // already coexists with google_fonts. A plain `test()` here would fail on the
  // unhandled async error, not on the assertion.
  group('bundledBrandFonts = false (pre-#350 fetch branch)', () {
    setUp(() => AppTypography.bundledBrandFonts = false);

    testWidgets('falls back to the google_fonts families',
        (WidgetTester tester) async {
      // Deliberately NOT the asset family name — this is the branch that proves
      // the bundled assertions above are testing a real switch and not a
      // constant.
      expect(AppTypography.display().fontFamily, isNot('Baloo 2'));
      expect(AppTypography.display().fontFamilyFallback, contains('Baloo2'));
      expect(AppTypography.body().fontFamilyFallback, contains('Mukta'));
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

  test('ships bundled by default', () {
    // The whole point of #350. Declared outside both groups so no setUp has
    // touched it; tearDown restores this same value.
    expect(AppTypography.bundledBrandFonts, isTrue);
  });

  test('mono stays self-hosted regardless of the brand-font switch', () {
    for (final bool bundled in <bool>[false, true]) {
      AppTypography.bundledBrandFonts = bundled;
      expect(AppTypography.mono().fontFamily, 'Roboto Mono');
    }
  });
}
