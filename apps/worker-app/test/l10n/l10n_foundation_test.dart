import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/l10n/gen/app_localizations.dart';
import 'package:badabhai_worker_app/l10n/ui_locale.dart';

/// #315 foundation — guards the localization PIPELINE, not the copy.
///
/// Two classes of silent break live here, and both are silent by nature: a
/// missing/typo'd ARB key produces no error at all (gen-l10n just falls back to
/// the template, so the worker quietly reads the wrong language), and an
/// undressable locale in `supportedLocales` produces no error until a real
/// device with that language opens the app and hits an assertion.
void main() {
  // `flutter test` runs with the package root as cwd, so the ARBs are readable
  // straight off disk. Asserting on the SOURCE files rather than on generated
  // code is deliberate: it catches a bad key before `pub get` ever regenerates.
  final Directory arbDir = Directory('lib/l10n');

  Map<String, Object?> readArb(String fileName) {
    final File file = File('${arbDir.path}/$fileName');
    expect(file.existsSync(), isTrue, reason: '${file.path} is missing');
    return json.decode(file.readAsStringSync()) as Map<String, Object?>;
  }

  /// Message ids only. ARB reserves every `@`-prefixed key for metadata
  /// (`@@locale`, our `@@x-note`, and the per-key `@description` blocks), and
  /// gen-l10n filters them the same way.
  Set<String> messageKeys(Map<String, Object?> arb) =>
      arb.keys.where((String k) => !k.startsWith('@')).toSet();

  group('ARB integrity', () {
    test('every supported code has an ARB declaring a matching @@locale', () {
      // Filename-suffix inference does NOT work for `bho` (it is ISO 639-3, and
      // gen-l10n only sniffs 639-1 codes out of filenames), so an explicit
      // @@locale is mandatory there or generation fails outright. Assert it for
      // all four so nobody has to remember which is which.
      for (final String code in LocaleStore.supported) {
        final Map<String, Object?> arb = readArb('app_$code.arb');
        expect(
          arb['@@locale'],
          code,
          reason: 'app_$code.arb must declare "@@locale": "$code"',
        );
      }
    });

    test('en carries EVERY template key — a gap silently serves Hindi', () {
      // `en` is the one non-Hindi locale we claim is complete. A key missing
      // here does not throw: gen-l10n fills it from the template, so an English
      // user is served Devanagari Hindi with no warning anyone will notice.
      final Set<String> template = messageKeys(readArb('app_hi.arb'));
      final Set<String> english = messageKeys(readArb('app_en.arb'));

      expect(template, isNotEmpty, reason: 'template ARB seeded no messages');
      expect(
        english.difference(template),
        isEmpty,
        reason: 'app_en.arb has keys the template does not — typo or orphan',
      );
      expect(
        template.difference(english),
        isEmpty,
        reason: 'app_en.arb is missing template keys; English falls back to Hindi',
      );
    });

    test('mr/bho hold no invented copy and no orphan keys', () {
      // These are intentionally EMPTY — nobody on this change speaks Marathi or
      // Bhojpuri, and guessed copy in front of a low-literacy worker mid-consent
      // is worse than the Hindi fallback. This test does NOT demand they stay
      // empty (translating them is the point of #315); it demands that whatever
      // lands is a SUBSET of the template's ids. A typo'd id is dropped on the
      // floor by gen-l10n with no error, so the translator would see their new
      // string simply not appear.
      final Set<String> template = messageKeys(readArb('app_hi.arb'));
      for (final String code in <String>['mr', 'bho']) {
        expect(
          messageKeys(readArb('app_$code.arb')).difference(template),
          isEmpty,
          reason: 'app_$code.arb has keys absent from app_hi.arb — these are '
              'silently ignored by gen-l10n and will never render',
        );
      }
    });
  });

  group('UI locale curation', () {
    test('every UI locale can actually be dressed by flutter_localizations', () {
      // THE crash guard. GlobalMaterialLocalizations covers `hi`/`mr`/`en` but
      // NOT `bho`; when it declines a locale the only fallback is
      // DefaultMaterialLocalizations, which supports English alone — so the
      // worker gets a `No MaterialLocalizations found` assertion and a blank
      // screen on app open.
      for (final Locale locale in kUiSupportedLocales) {
        expect(
          GlobalMaterialLocalizations.delegate.isSupported(locale),
          isTrue,
          reason: '$locale is offered to MaterialApp but the framework cannot '
              'localize it — this crashes on open, it does not degrade',
        );
        expect(GlobalWidgetsLocalizations.delegate.isSupported(locale), isTrue);
      }
    });

    test('the curated list deliberately diverges from the generated one', () {
      // Pins the divergence so it reads as a decision. gen-l10n derives
      // AppLocalizations.supportedLocales from the ARB files present, which
      // includes bho; app.dart must NOT hand that list to MaterialApp. If
      // someone "simplifies" the wiring to use it, the test above starts
      // failing — this one explains why.
      expect(
        AppLocalizations.supportedLocales.map((Locale l) => l.languageCode),
        contains('bho'),
        reason: 'app_bho.arb should still exist for translators',
      );
      expect(
        kUiSupportedLocales.map((Locale l) => l.languageCode),
        isNot(contains('bho')),
        reason: 'bho must stay out of MaterialApp.supportedLocales until the '
            'framework can localize it',
      );
    });

    test('every stored LocaleStore code resolves to an offerable locale', () {
      // LocaleStore.supported is the set the X-Locale header can carry. Each
      // one must land somewhere renderable — including bho, which rides Hindi.
      for (final String code in LocaleStore.supported) {
        expect(kUiSupportedLocales, contains(uiLocaleFor(code)));
      }
      expect(uiLocaleFor('bho'), const Locale('hi'));
      // Anything unrecognised (a future backend code, a corrupted pref) also
      // lands on the fully-translated default rather than on blanks.
      expect(uiLocaleFor('xx'), const Locale(LocaleStore.defaultLocale));
    });
  });

  group('delegates resolve through a real MaterialApp', () {
    /// Pumps the same delegate/locale wiring app.dart installs and hands back
    /// the resolved bundle, proving the pipeline rather than the ARB contents.
    Future<AppLocalizations> pumpAndResolve(
      WidgetTester tester,
      Locale locale,
    ) async {
      late AppLocalizations strings;
      await tester.pumpWidget(
        MaterialApp(
          locale: locale,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: kUiSupportedLocales,
          home: Builder(
            builder: (BuildContext context) {
              strings = AppLocalizations.of(context);
              // Touching MaterialLocalizations here is the point: it is what
              // throws if the locale cannot be dressed.
              MaterialLocalizations.of(context);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      return strings;
    }

    testWidgets('hi serves the moved Hinglish copy verbatim', (tester) async {
      final AppLocalizations strings =
          await pumpAndResolve(tester, const Locale('hi'));
      // Verbatim from failureReason(NetworkFailure) in failure_reason.dart —
      // if this drifts, the "move, don't rewrite" promise of the seed is broken.
      expect(strings.errorNetwork,
          'Server se connect nahi ho pa raha. Dobara try karein.');
      expect(strings.actionTryAgain, 'Try again');
    });

    testWidgets('en serves English', (tester) async {
      final AppLocalizations strings =
          await pumpAndResolve(tester, const Locale('en'));
      expect(strings.errorNetwork, "Can't reach the server. Please try again.");
    });

    testWidgets('mr falls back to Hindi, never to English or blank',
        (tester) async {
      // The whole reason app_hi.arb is the TEMPLATE. An untranslated Marathi
      // build must render readable Devanagari Hindi; falling back to English
      // would be worse than useless for this audience.
      final AppLocalizations hindi =
          await pumpAndResolve(tester, const Locale('hi'));
      final AppLocalizations marathi =
          await pumpAndResolve(tester, const Locale('mr'));
      expect(marathi.errorNetwork, hindi.errorNetwork);
      expect(marathi.errorConsentRequired, hindi.errorConsentRequired);
    });

    testWidgets('ICU placeholder renders the raw status code', (tester) async {
      final AppLocalizations strings =
          await pumpAndResolve(tester, const Locale('hi'));
      // The placeholder is typed `int` with NO `format`, so gen-l10n emits a
      // plain interpolation. If anyone adds `"format": "decimalPattern"`, a
      // status code would render group-separated ("1,001" for a 1001) — this
      // pins it at four honest digits' worth of raw code.
      expect(strings.errorServerStatus(503), contains('503'));
      expect(strings.errorServerStatus(1001), contains('1001'));
    });
  });
}
